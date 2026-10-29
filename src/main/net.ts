import fs from 'node:fs'
import path from 'node:path'

export const BmclApi = {
  versionManifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  assets: 'https://bmclapi2.bangbang93.com/assets',
  maven: 'https://bmclapi2.bangbang93.com/maven',
  forge: 'https://bmclapi2.bangbang93.com/forge',
  fabricMeta: 'https://bmclapi2.bangbang93.com/fabric-meta'
}

export const Official = {
  versionManifest: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  assets: 'https://resources.download.minecraft.net',
  maven: 'https://libraries.minecraft.net',
  forge: 'https://maven.minecraftforge.net',
  fabricMeta: 'https://meta.fabricmc.net'
}

/** 按设置返回下载源相关地址（versionClient 用于拿镜像的 client.jar） */
export function sources(useMirror: boolean) {
  return useMirror
    ? { ...BmclApi, versionClient: (id: string) => `https://bmclapi2.bangbang93.com/version/${id}/client` }
    : { ...Official, versionClient: (_id: string) => '' }
}

const ua = { 'User-Agent': 'WFMC/1.0 (Electron)' }

/** 元数据请求统一超时：不设的话偶发僵死连接会把界面永远卡在「加载中」 */
const META_TIMEOUT = 20_000

export class AbortError extends Error {
  constructor(what = '操作已取消') {
    super(what)
    this.name = 'AbortError'
  }
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new AbortError()
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(META_TIMEOUT),
    headers: { ...ua, ...(init?.headers as Record<string, string> | undefined) }
  })
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`)
  return (await res.json()) as T
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(META_TIMEOUT),
    headers: { ...ua, ...(init?.headers as Record<string, string> | undefined) }
  })
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`)
  return await res.text()
}

export interface DownloadOptions {
  /** 已知文件大小：传了就跳过 HEAD，省一次往返（assets/libraries 都有） */
  expectedSize?: number
  skipIfExists?: boolean
  signal?: AbortSignal
  /** 分片数（默认 4；文件 < 4MB 时分片会自动跳过） */
  chunks?: number
  /** 关掉分片（小文件 / 服务器不支持 Range 时自动关） */
  noChunk?: boolean
}

type Progress = (current: number, total: number) => void

/** 单流下载（保守路径，任何服务器都能用） */
async function singleStream(
  u: string,
  dest: string,
  onProgress: Progress | undefined,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {}
): Promise<void> {
  const res = await fetch(u, { headers: { ...ua, ...headers }, signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let current = 0
  const reader = res.body.getReader()
  for (;;) {
    checkAbort(signal)
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      current += value.byteLength
      out.write(Buffer.from(value))
      if (total) onProgress?.(current, total)
    }
  }
  await new Promise<void>((resolve, reject) => {
    out.on('error', reject)
    out.on('finish', () => resolve())
    out.end()
  })
  await fs.promises.rename(tmp, dest)
  if (!total) onProgress?.(current, current)
}

/** 分片（HTTP Range）并发下载：大文件明显更快，失败会自动退回单流 */
async function chunkedDownload(
  u: string,
  dest: string,
  total: number,
  onProgress: Progress | undefined,
  signal: AbortSignal | undefined,
  chunkCount: number
): Promise<void> {
  const tmp = `${dest}.part`
  const handle = await fs.promises.open(tmp, 'w')
  const size = Math.ceil(total / chunkCount)
  let downloaded = 0
  const progress = (n: number) => {
    downloaded += n
    onProgress?.(downloaded, total)
  }

  try {
    const jobs: Promise<void>[] = []
    for (let i = 0; i < chunkCount; i++) {
      const start = i * size
      const end = Math.min(total - 1, start + size - 1)
      if (start > end) break
      jobs.push(
        (async () => {
          const res = await fetch(u, {
            headers: { ...ua, Range: `bytes=${start}-${end}` },
            signal
          })
          if (res.status !== 206 || !res.body) throw new Error(`服务器不支持分片（HTTP ${res.status}）`)
          const reader = res.body.getReader()
          let pos = start
          for (;;) {
            checkAbort(signal)
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              await handle.write(Buffer.from(value), 0, value.byteLength, pos)
              pos += value.byteLength
              progress(value.byteLength)
            }
          }
        })()
      )
    }
    await Promise.all(jobs)
    await handle.close()
    await fs.promises.rename(tmp, dest)
  } catch (e) {
    try {
      await handle.close()
    } catch {
      /* 已关闭 */
    }
    fs.rmSync(tmp, { force: true })
    throw e
  }
}

/** 带进度/分片/可取消的下载；目标已存在则跳过 */
export async function downloadFile(
  url: string | string[],
  dest: string,
  onProgress?: Progress,
  opts: DownloadOptions = {}
): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })
  checkAbort(opts.signal)

  if (opts.skipIfExists !== false) {
    const stat = await fs.promises.stat(dest).catch(() => undefined)
    if (stat && stat.size > 0) {
      onProgress?.(stat.size, stat.size)
      return
    }
  }

  const urls = Array.isArray(url) ? url : [url]
  let lastErr: unknown
  for (const u of urls) {
    checkAbort(opts.signal)
    // 已知大小就跳过 HEAD（几千个 assets 时这一步能省掉一半请求数）
    let total = opts.expectedSize && opts.expectedSize > 0 ? opts.expectedSize : 0
    if (!total) {
      try {
        const head = await fetch(u, { method: 'HEAD', headers: ua, signal: opts.signal })
        total = Number(head.headers.get('content-length') ?? 0) || 0
      } catch {
        /* HEAD 不支持就直接走单流 */
      }
    }

    const wantChunks = !opts.noChunk && total >= 4 * 1024 * 1024
    if (wantChunks) {
      try {
        await chunkedDownload(u, dest, total, onProgress, opts.signal, opts.chunks ?? 4)
        return
      } catch (e) {
        if (e instanceof AbortError) throw e
        // 分片失败 → 退回单流
      }
    }
    try {
      await singleStream(u, dest, onProgress, opts.signal)
      return
    } catch (e) {
      if (e instanceof AbortError) throw e
      lastErr = e
    }
  }
  throw lastErr ?? new Error(`下载失败: ${url}`)
}

/** 并发受限的批量下载，返回失败项；signal 可用于整体取消 */
export async function downloadAll(
  items: { url: string | string[]; dest: string; skipIfExists?: boolean; size?: number }[],
  concurrency = 8,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
  onBytes?: (delta: number) => void
): Promise<string[]> {
  let index = 0
  let done = 0
  const errors: string[] = []
  const workers = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = index++
      if (i >= items.length) return
      const item = items[i]
      let prev = 0
      try {
        await downloadFile(item.url, item.dest, (got) => {
          if (onBytes && got > prev) {
            onBytes(got - prev)
            prev = got
          }
        }, { skipIfExists: item.skipIfExists, signal, expectedSize: item.size })
      } catch (e) {
        if (e instanceof AbortError) return
        errors.push(`${item.dest}: ${(e as Error).message}`)
      }
      done++
      onProgress?.(done, items.length)
    }
  })
  await Promise.all(workers)
  if (signal?.aborted) throw new AbortError()
  return errors
}
