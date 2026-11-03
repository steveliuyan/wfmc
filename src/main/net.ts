import fs from 'node:fs'
import path from 'node:path'
import { waitIfPaused } from './pause'
import { dlFetch } from './proxy'

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

/**
 * 把失败响应体里的人话挑出来。
 * 微软/CurseForge 这类接口只报状态码等于把线索扔掉——400 到底是 client id 不认识还是 scope 不对，
 * 全在 body 的 error_description 里，用户只看「请求失败 400」根本没法自助排查。
 */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text()
    if (!text) return ''
    try {
      const j = JSON.parse(text) as { error_description?: string; error?: string; message?: string }
      const msg = j.error_description || j.message || j.error
      if (msg) return `：${msg.replace(/\s+/g, ' ').slice(0, 400)}`
    } catch {
      /* 不是 JSON 就走下面截断文本 */
    }
    return `：${text.replace(/\s+/g, ' ').slice(0, 300)}`
  } catch {
    return ''
  }
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(META_TIMEOUT),
    headers: { ...ua, ...(init?.headers as Record<string, string> | undefined) }
  })
  if (!res.ok) throw new Error(`请求失败 ${res.status}${await errorDetail(res)}: ${url}`)
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

/**
 * 卡住判定：这么多毫秒没有新数据就放弃这条连接。
 * 很多镜像/运营商会把连接挂着不关（既不报错也不发数据），
 * 没有这个超时，进度条就会永远停在 99%。
 */
const IDLE_TIMEOUT_MS = 45_000

class StallError extends Error {
  constructor(what = '下载') {
    super(`${what}卡住：${Math.round(IDLE_TIMEOUT_MS / 1000)} 秒没有收到新数据`)
    this.name = 'StallError'
  }
}

interface StallGuard {
  signal: AbortSignal
  /** 收到数据时调一次，重新计时 */
  kick: () => void
  /** 是否是因为卡住被中断的 */
  stalled: () => boolean
  /** 主动断掉这条下载（例如某个分片已经失败，没必要等其它分片） */
  abort: () => void
  dispose: () => void
}

function stallGuard(parent?: AbortSignal): StallGuard {
  const ac = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let hit = false
  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      hit = true
      ac.abort()
    }, IDLE_TIMEOUT_MS)
    timer.unref?.()
  }
  const onAbort = () => ac.abort()
  parent?.addEventListener('abort', onAbort, { once: true })
  arm()
  return {
    signal: ac.signal,
    kick: arm,
    stalled: () => hit,
    abort: () => ac.abort(),
    dispose: () => {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    }
  }
}

/**
 * 读一块数据，带「多久没新数据就算卡住」的看门狗。
 *
 * 为什么不能只靠 AbortSignal：主进程的 fetch 换成了 Chromium 的网络栈之后，
 * 中途 abort 并不总能打断已经挂住的 body 读取（运营商把连接吊着，既不发数据
 * 也不关），于是进度条永远停在 99%，后台也不报错。这里用 Promise.race +
 * reader.cancel() 兜底，保证「卡住」一定会变成一次可重试的失败。
 */
const STALL_LABEL = '下载'

function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  guard: StallGuard
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => {})
      reject(new StallError(STALL_LABEL))
    }, IDLE_TIMEOUT_MS)
    reader.read().then(
      (r) => {
        clearTimeout(timer)
        resolve(r)
      },
      (e) => {
        clearTimeout(timer)
        reject(guard.stalled() ? new StallError(STALL_LABEL) : e)
      }
    )
  })
}

/** 单流下载（保守路径，任何服务器都能用） */
async function singleStream(
  u: string,
  dest: string,
  onProgress: Progress | undefined,
  signal: AbortSignal | undefined,
  headers: Record<string, string> = {}
): Promise<void> {
  const guard = stallGuard(signal)
  const tmp = `${dest}.part`
  let out: fs.WriteStream | undefined
  try {
    // 断点续传：上次留下的 .part 直接从断掉的位置接着要，别每次重试都从头下一遍
    // （大文件 + 慢线路时，从零重来几乎永远下不完）
    let start = 0
    try {
      const st = await fs.promises.stat(tmp)
      if (st.size > 0) start = st.size
    } catch {
      /* 没有残包 */
    }
    const res = await dlFetch(u, {
      headers: { ...ua, ...headers, ...(start > 0 ? { Range: `bytes=${start}-` } : {}) },
      signal: guard.signal
    })
    if (res.status === 416 && start > 0) {
      // 残包比服务器上的文件还长（或服务器不认这个 Range）：丢掉重来
      fs.rmSync(tmp, { force: true })
      throw new Error('HTTP 416（残包无效，重下）')
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
    let total = 0
    let append = false
    if (res.status === 206) {
      append = start > 0
      const cr = res.headers.get('content-range')
      const m = cr ? /\/(\d+)\s*$/.exec(cr) : null
      total = m ? Number(m[1]) : Number(res.headers.get('content-length') ?? 0) + start
    } else {
      // 服务器忽略了 Range，返回的是整个文件：从 0 覆盖写
      start = 0
      total = Number(res.headers.get('content-length') ?? 0)
    }
    out = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' })
    let current = start
    const reader = res.body.getReader()
    for (;;) {
      checkAbort(signal)
      await waitIfPaused(signal, () => guard.kick())
      const read = await readWithIdle(reader, guard)
      if (read.done) break
      if (read.value) {
        guard.kick()
        current += read.value.byteLength
        out.write(Buffer.from(read.value))
        if (total) onProgress?.(current, total)
      }
    }
    const stream = out
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject)
      stream.on('finish', () => resolve())
      stream.end()
    })
    // 服务器提前收尾（连接被掐断但没报错）时不能把半截文件当成下完了
    if (total && current < total) throw new StallError(STALL_LABEL)
    await fs.promises.rename(tmp, dest)
    if (!total) onProgress?.(current, current)
  } catch (e) {
    out?.destroy()
    // 保留 .part 供下次断点续传，只有确实没法续的情况才删
    throw e
  } finally {
    guard.dispose()
  }
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
  const guard = stallGuard(signal)
  let downloaded = 0
  let firstError: unknown
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
          const res = await dlFetch(u, {
            headers: { ...ua, Range: `bytes=${start}-${end}` },
            signal: guard.signal
          })
          if (res.status !== 206 || !res.body) throw new Error(`服务器不支持分片（HTTP ${res.status}）`)
          const reader = res.body.getReader()
          let pos = start
          for (;;) {
            checkAbort(signal)
            await waitIfPaused(signal, () => guard.kick())
            const read = await readWithIdle(reader, guard)
            if (read.done) break
            if (read.value) {
              guard.kick()
              await handle.write(Buffer.from(read.value), 0, read.value.byteLength, pos)
              pos += read.value.byteLength
              progress(read.value.byteLength)
            }
          }
        })().catch((e) => {
          // 一个分片崩了就立刻掐掉其它分片，别让它们在后台空转
          if (firstError === undefined) firstError = e
          guard.abort()
          throw e
        })
      )
    }    // 用 allSettled：某一分片崩了要把所有分片都收干净再抛，否则其它分片还在写已删掉的文件
    const results = await Promise.allSettled(jobs)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (failed) throw firstError ?? failed.reason
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
  } finally {
    guard.dispose()
  }
}

/** 网络抖动的错误：值得再试一次；用户取消不算 */
function isRetriable(e: unknown): boolean {
  if (e instanceof AbortError) return false
  if (e instanceof StallError) return true
  const msg = (e as Error)?.message ?? String(e)
  return /fetch failed|socket hang up|other side closed|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR|network|aborted|HTTP 5\d\d/i.test(
    msg
  )
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
  await waitIfPaused(opts.signal)

  if (opts.skipIfExists !== false) {
    const stat = await fs.promises.stat(dest).catch(() => undefined)
    if (stat && stat.size > 0) {
      onProgress?.(stat.size, stat.size)
      return
    }
  }

  // 镜像/官方在「已切官方源」时会是同一个地址，去重免得同一个地址白试 6 次
  const urls = [...new Set(Array.isArray(url) ? url : [url])]
  let lastErr: unknown
  for (const u of urls) {
    // 网络抖一下就整包失败太脆：同一个地址最多试 3 次，退避 0.7s / 1.4s
    for (let attempt = 1; attempt <= 3; attempt++) {
      checkAbort(opts.signal)
      // 已知大小就跳过 HEAD（几千个 assets 时这一步能省掉一半请求数）
      let total = opts.expectedSize && opts.expectedSize > 0 ? opts.expectedSize : 0
      if (!total) {
        try {
          const headTimeout = AbortSignal.timeout(15_000)
          const head = await dlFetch(u, {
            method: 'HEAD',
            headers: ua,
            signal: opts.signal ? AbortSignal.any([opts.signal, headTimeout]) : headTimeout
          })
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
          lastErr = e
          // 分片是随机位置写的，残包中间可能有洞，不能拿来续传
          fs.rmSync(`${dest}.part`, { force: true })
          // 分片失败 → 先退回单流（很多镜像/CDN 不支持 Range 或多连接）
          try {
            await singleStream(u, dest, onProgress, opts.signal)
            return
          } catch (e2) {
            if (e2 instanceof AbortError) throw e2
            lastErr = e2
          }
        }
      } else {
        try {
          await singleStream(u, dest, onProgress, opts.signal)
          return
        } catch (e) {
          if (e instanceof AbortError) throw e
          lastErr = e
        }
      }

      if (attempt < 3 && isRetriable(lastErr)) {
        await new Promise((r) => setTimeout(r, 700 * attempt))
        continue
      }
      break
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
  const failed: { item: (typeof items)[number]; err: string }[] = []
  const workers = new Array(Math.min(concurrency, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      if (signal?.aborted) return
      await waitIfPaused(signal)
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
        failed.push({ item, err: (e as Error).message })
      }
      done++
      onProgress?.(done, items.length)
    }
  })
  await Promise.all(workers)
  if (signal?.aborted) throw new AbortError()

  // 并发出错的多半是 CDN 掐连接：失败项串行各补一次，往往就过了
  for (const f of failed) {
    if (signal?.aborted) throw new AbortError()
    await waitIfPaused(signal)
    try {
      await downloadFile(f.item.url, f.item.dest, undefined, {
        skipIfExists: f.item.skipIfExists,
        signal,
        expectedSize: f.item.size,
        chunks: 1
      })
    } catch (e) {
      if (e instanceof AbortError) throw e
      errors.push(`${f.item.dest}: ${(e as Error).message}`)
    }
  }
  return errors
}
