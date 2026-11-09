/**
 * 云端存档备份（服务端 /v1/saves/*）。
 *
 * 服务端契约（权威版，见 docs/云端存档备份-服务端提示词.md）：
 *   POST   /v1/saves/upload?instance=&name=   Content-Type: application/zip + X-WFMC-Meta(base64 JSON)
 *   GET    /v1/saves?instance=                列表 + limits
 *   GET    /v1/saves/{id}/download            zip 字节，响应头 X-Sha256
 *   DELETE /v1/saves/{id}                     幂等
 *   GET    /v1/saves/usage                    已用 / 配额
 *
 * 与 /v1/backup 完全无关（那是配置包 KV 快照，单键 2MB，装不下存档）。
 * 这里只做网络与落盘，不碰 electron、不碰 store，方便单测。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as uapi from './unifiedapi'
import { currentToken } from './cloudlogin'

/** 上传要带的实例信息（服务端原样存、原样回，界面按它分组） */
export interface UploadMeta {
  instance: string
  instanceName?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  worlds: string[]
  files: number
  createdAt: number
  sha256?: string
}

export interface UploadResult {
  id: string
  instance?: string
  bytes: number
  sha256: string
  /** 服务端入库时间（epoch 秒） */
  createdAt: number
  deduped: boolean
}

export interface ServerListItem {
  id: string
  instance: string
  instance_name?: string
  mc_version?: string
  loader?: string
  loader_version?: string
  worlds?: string[]
  files?: number
  bytes?: number
  sha256?: string
  created_at?: number
}

export interface ServerList {
  items: ServerListItem[]
  limits?: { saves_keep?: number; max_file_mb?: number; quota_bytes?: number; used_bytes?: number }
}

function token(): string {
  const t = currentToken()
  if (!t) throw new uapi.UnifiedError(401, 'token_expired', '还没登录统一账号，先登录再传云端存档')
  return t
}

/** 把服务端错误体翻成 UnifiedError（按 code 分支，别只看状态码） */
async function failure(res: Response): Promise<uapi.UnifiedError> {
  let code = `http_${res.status}`
  let message = `服务器返回 ${res.status}`
  try {
    const text = await res.text()
    const err = (JSON.parse(text) as { error?: { code?: string; message?: string } })?.error
    if (err?.code) code = err.code
    if (err?.message) message = err.message
  } catch {
    /* 不是 JSON 就用默认文案 */
  }
  return new uapi.UnifiedError(res.status, code, message)
}

/** 网络错误 / 5xx / 507 退避重试；401 / 4xx 直接抛（重试也没用） */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      const ue = e as uapi.UnifiedError
      const retriable = ue?.name === 'UnifiedError' ? ue.status === 0 || ue.status === 507 || ue.status >= 500 : true
      if (!retriable || i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, i)))
    }
  }
  throw last
}

async function jsonRequest<T>(p: string, method = 'GET'): Promise<T> {
  const res = await fetch(uapi.UNIFIED_BASE_URL + p, {
    method,
    headers: { Accept: 'application/json', 'User-Agent': 'WFMC-Launcher', Authorization: `Bearer ${token()}` }
  })
  if (!res.ok) throw await failure(res)
  const text = await res.text()
  try {
    return (text ? JSON.parse(text) : {}) as T
  } catch {
    return {} as T
  }
}

/** 算整个文件的 sha256（流式，别把几百 MB 读进内存） */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const rs = fs.createReadStream(file)
    rs.on('error', reject)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/** 把本地文件变成 fetch 收得下的 body（Blob 优先——它带 size，两套网络栈都能流式发） */
async function fileBody(file: string, size: number): Promise<BodyInit> {
  const p = fs.promises as unknown as { openAsBlob?: (f: string, o?: { type?: string }) => Promise<Blob> }
  if (typeof p.openAsBlob === 'function') {
    try {
      return (await p.openAsBlob(file, { type: 'application/zip' })) as unknown as BodyInit
    } catch {
      /* 落到下面的兜底 */
    }
  }
  if (size > 256 * 1024 * 1024) {
    throw new uapi.UnifiedError(422, 'too_large', '这份备份太大，当前运行环境没法流式上传，先只传需要的那几个存档')
  }
  return fs.readFileSync(file) as unknown as BodyInit
}

/**
 * 上传一份本地 zip。服务端流式接收；Content-Length 由 Blob 的大小决定。
 * 同实例 + 同 sha256 已存在时服务端返回 deduped=true，也算成功。
 */
export async function upload(
  zipFile: string,
  meta: UploadMeta
): Promise<UploadResult> {
  const stat = fs.statSync(zipFile)
  if (!stat.size) throw new uapi.UnifiedError(422, 'bad_request', '这份备份是空的，没法传')
  const sha256 = meta.sha256 || (await sha256File(zipFile))
  const metaJson = JSON.stringify({ ...meta, sha256 })
  const q = new URLSearchParams({ instance: meta.instance, name: path.basename(zipFile) })

  return withRetry(async () => {
    // 不能用 Readable.toWeb 流：main 里的 fetch 在走代理时会被换成 Electron 的
    // net.fetch（Chromium 网络栈），它不收 Node 的 ReadableStream，直接回
    // net::ERR_INVALID_ARGUMENT。Blob（openAsBlob 是懒读文件，不会整个进内存）
    // 两套栈都认，undici 也按 Blob 的 size 自动算 Content-Length。
    const body = await fileBody(zipFile, stat.size)
    const res = await fetch(`${uapi.UNIFIED_BASE_URL}/v1/saves/upload?${q.toString()}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WFMC-Launcher',
        'Content-Type': 'application/zip',
        'Content-Length': String(stat.size),
        'X-WFMC-Meta': Buffer.from(metaJson, 'utf-8').toString('base64'),
        Authorization: `Bearer ${token()}`
      },
      body
    }).catch((e) => {
      throw new uapi.UnifiedError(0, 'network', `上传失败：${(e as Error).message}`)
    })
    if (!res.ok) throw await failure(res)
    const data = (await res.json()) as {
      id: string
      instance?: string
      bytes?: number
      sha256?: string
      created_at?: number
      deduped?: boolean
    }
    return {
      id: data.id,
      instance: data.instance,
      bytes: Number(data.bytes ?? stat.size),
      sha256: data.sha256 || sha256,
      createdAt: Number(data.created_at ?? Math.floor(Date.now() / 1000)),
      deduped: !!data.deduped
    }
  })
}

/** 列表（instance 不传 = 整个账号） */
export async function list(instance?: string): Promise<ServerList> {
  const q = instance ? `?${new URLSearchParams({ instance }).toString()}` : ''
  return withRetry(() => jsonRequest<ServerList>(`/v1/saves${q}`))
}

export async function usage(): Promise<{
  usedBytes: number
  quotaBytes: number
  count: number
  instances: number
}> {
  const d = await withRetry(() =>
    jsonRequest<{ used_bytes?: number; quota_bytes?: number; count?: number; instances?: number }>('/v1/saves/usage')
  )
  return {
    usedBytes: Number(d.used_bytes ?? 0),
    quotaBytes: Number(d.quota_bytes ?? 0),
    count: Number(d.count ?? 0),
    instances: Number(d.instances ?? 0)
  }
}

/** 删除（幂等：不存在也当成功） */
export async function remove(id: string): Promise<void> {
  const res = await fetch(`${uapi.UNIFIED_BASE_URL}/v1/saves/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', 'User-Agent': 'WFMC-Launcher', Authorization: `Bearer ${token()}` }
  })
  if (res.status === 404 || res.ok) return
  throw await failure(res)
}

/**
 * 下载到 destFile 并校验 sha256（和响应头 X-Sha256 比对，不一致就删掉重传）。
 * 返回真实落盘大小。
 */
export async function download(id: string, destFile: string): Promise<{ bytes: number; sha256: string }> {
  return withRetry(async () => {
    const res = await fetch(`${uapi.UNIFIED_BASE_URL}/v1/saves/${encodeURIComponent(id)}/download`, {
      headers: { 'User-Agent': 'WFMC-Launcher', Authorization: `Bearer ${token()}` }
    })
    if (!res.ok) throw await failure(res)
    const expect = (res.headers.get('x-sha256') || '').trim().toLowerCase()
    fs.mkdirSync(path.dirname(destFile), { recursive: true })
    const tmp = `${destFile}.part`
    if (!res.body) throw new uapi.UnifiedError(0, 'empty_body', '服务器没返回文件内容')
    await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp))
    const actual = await sha256File(tmp)
    if (expect && actual !== expect) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* 删不掉就留着 */
      }
      throw new uapi.UnifiedError(422, 'sha_mismatch', '下载的文件不完整（校验没对上），请重试')
    }
    fs.renameSync(tmp, destFile)
    return { bytes: fs.statSync(destFile).size, sha256: actual }
  })
}
