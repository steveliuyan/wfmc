import fs from 'node:fs'
import path from 'node:path'
import { AbortError } from './net'
import { isPaused, waitIfPaused } from './pause'
import { dlFetch, noteTransferProblem } from './proxy'

export { dlFetch }

/**
 * 下载引擎（PCL2 风格）
 *
 * - 文件级并发：全局连接池（默认 48），一批文件同时跑，不会把连接打爆
 * - 块级并发：单文件 ≥ 8MB 时按 Range 切成若干块并行拉（默认 8 片）+ 断点续传）
 * - 暂停 / 继续：暂停立刻中断在途请求；已完成的文件保留、大文件保留分块进度；
 *   继续时从断点续传，不会从头再下
 * - 失败重试：整批跑完后，失败的再补一轮
 */

export interface DlItem {
  urls: string[]
  dest: string
  size?: number
  /** 这个文件单独开几条连接（默认按连接预算算） */
  conns?: number
}

const UA = { 'User-Agent': 'WFMC/1.1 (Electron)' }
/** 调试：WFMC_DL_TRACE=1 时把每次连接的关键事件打到 stdout */
const trace: (...a: unknown[]) => void =
  process.env.WFMC_DL_TRACE === '1' ? (...a) => console.log('[dl]', ...a) : () => undefined
/** 小于这个大小不分块（小文件分块反而更慢） */
const MIN_CHUNK = 1 * 1024 * 1024
/** 多久没收到新数据就认为这条连接死了 */
const READ_IDLE_MS = 45_000
/** 等响应头的上限：代理/防火墙有时候把连接建起来却一个字节都不回，不能干等 */
const HEADER_TIMEOUT_MS = 45_000
/** 同一 host 同时开几条连接：Chromium 的每 host 预算就 6 条，再排队没意义 */
const HOST_CONNS = 6

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 连接被吊住（不发数据也不关）时抛这个，交给上层重连 */
class StallError extends Error {
  constructor() {
    super('下载卡住（5 秒没有数据）')
  }
}

/** fetch 连响应头都不给的时候自己掐断（Chromium 自己的超时可能是好几分钟） */
function fetchWithTimeout(
  p: Promise<Response>,
  ms: number,
  ctrl: AbortController
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        ctrl.abort()
      } catch {
        /* ignore */
      }
      reject(new StallError())
    }, ms)
    p.then(
      (r) => {
        clearTimeout(t)
        resolve(r)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/**
 * 读一块数据，带空闲看门狗。
 *
 * 为什么不能只用 AbortSignal：主进程的 fetch 走 Chromium 的网络栈，中途 abort
 * 并不总能打断已经挂住的 body 读取 —— 于是就出现「进度条永远停在 3587/3598」的。
 */
function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = READ_IDLE_MS
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reader.cancel().catch(() => undefined)
      reject(new StallError())
    }, timeoutMs)
    reader.read().then(
      (r) => {
        clearTimeout(timer)
        resolve(r)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

interface ChunkState {
  start: number
  end: number
  done: number
}

/** 计数信号量：把「同时开几条连接」的预算集中管理，别让 48 文件 × 8 分片把线路打满 */
class Limiter {
  private free: number
  private waiters: (() => void)[] = []
  constructor(capacity: number) {
    this.free = Math.max(1, capacity)
  }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--
    else await new Promise<void>((r) => this.waiters.push(r))
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.free++
    }
  }
}

export class MultiDownloader {
  readonly threads: number
  readonly chunks: number
  /** 同时下载的文件数：连接预算够时多开几个，加速「一堆小文件」的场景 */
  readonly files: number
  /** 单个文件同时开几条连接 */
  readonly connsPerFile: number
  private limiter: Limiter
  /** 每个 host 单独限并发：Chromium 自己对同一 host 就是 6 条，开再多也只是排队 */
  private hostSems = new Map<string, Limiter>()
  private paused = false
  private canceled = false
  /**
   * 任务暂停闸门挂在 signal 上（见 pause.ts）。下载器两种暂停都要认：
   * 自己的 pause()（即时下载面板用），以及任务面板的暂停（runTask 的 signal）。
   * 以前只认前者，所以任务里点暂停进度照样涨 —— 因为压根没人通知到引擎。
   */
  private signal?: AbortSignal
  private bytes = 0
  private inflight = new Set<AbortController>()
  private onBytes?: (delta: number) => void

  private limitBytesPerSec: number
  private gateUntil = 0
  /** 连接建立耗时的滑动平均（ms），用来给读超时定一个「符合这条线路」的值 */
  private connectAvg = 0

  constructor(
    opts: { threads?: number; chunks?: number; limitKbps?: number; onBytes?: (delta: number) => void; signal?: AbortSignal } = {}
  ) {
    this.threads = Math.max(1, Math.min(128, opts.threads ?? 32))
    this.chunks = Math.max(1, Math.min(16, opts.chunks ?? 8))
    this.signal = opts.signal
    // 连接预算的三个去处：同时下载的文件数 / 单文件分片数 / 全局信号量
    this.files = Math.max(2, Math.min(8, Math.round(this.threads / 4)))
    this.connsPerFile = Math.max(1, Math.min(this.chunks, Math.floor(this.threads / this.files)))
    this.limiter = new Limiter(this.threads)
    this.onBytes = opts.onBytes
    this.limitBytesPerSec = Math.max(0, (opts.limitKbps ?? 0) * 1024)
  }

  get downloaded() {
    return this.bytes
  }

  get isPaused() {
    return this.paused
  }

  get isCanceled() {
    return this.canceled
  }

  /** 暂停中（自己的 pause() 或任务闸门），两种来源一视同仁 */
  private get pausedNow() {
    return this.paused || isPaused(this.signal)
  }

  pause() {
    this.paused = true
    for (const c of this.inflight) c.abort()
    this.inflight.clear()
  }

  resume() {
    this.paused = false
  }

  cancel() {
    this.canceled = true
    this.paused = false
    for (const c of this.inflight) c.abort()
    this.inflight.clear()
  }

  /** 每个 host 的并发连接上限（Chromium 自己只有一个 host 6 条的预算，多开只会排队超时） */
  private hostLimiter(url: string): Limiter {
    let host = 'unknown'
    try {
      host = new URL(url).host
    } catch {
      /* 不是合法 URL，归到同一类 */
    }
    let l = this.hostSems.get(host)
    if (!l) {
      l = new Limiter(HOST_CONNS)
      this.hostSems.set(host, l)
    }
    return l
  }

  /** 限速：按总字节预约，多线程共享一个水位（0 = 不限速） */
  private async throttle(bytes: number) {
    if (this.limitBytesPerSec <= 0) return
    const cost = (bytes / this.limitBytesPerSec) * 1000
    const now = Date.now()
    this.gateUntil = Math.max(this.gateUntil, now) + cost
    const wait = this.gateUntil - now
    // 单次最多睡 1 秒，剩下的水位留给后面的调用继续排队
    if (wait > 5) await sleep(Math.min(wait, 1000))
  }

  /** 暂停时挂起，取消时抛错 */
  private async gate() {
    for (;;) {
      if (this.canceled || this.signal?.aborted) throw new AbortError()
      if (!this.pausedNow) return
      if (isPaused(this.signal)) {
        // 任务暂停：先把在途连接掐掉，别让它们继续往文件里灌数据（已完成字节都在 st.done 里）
        for (const c of this.inflight) c.abort()
        this.inflight.clear()
        await waitIfPaused(this.signal)
      } else {
        await sleep(120)
      }
    }
  }

  /* ---------------- 对外入口 ---------------- */

  async downloadAll(items: DlItem[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const errors: string[] = []
    await this.runPool(items, this.files, onProgress, errors)
    if (!this.canceled && !this.signal?.aborted && !this.pausedNow && errors.length > 0) {
      const failedDests = new Set(errors.map((e) => e.split('\u0000')[0]))
      const retry = items.filter((i) => failedDests.has(i.dest))
      const retryErrors: string[] = []
      if (retry.length > 0) await this.runPool(retry, Math.min(this.files, 4), undefined, retryErrors)
      return retryErrors
    }
    return errors
  }

  private async runPool(
    items: DlItem[],
    threads: number,
    onProgress: ((done: number, total: number) => void) | undefined,
    errors: string[]
  ) {
    let cursor = 0
    let done = 0
    const totalFiles = items.length
    const worker = async () => {
      for (;;) {
        await this.gate()
        const i = cursor++
        if (i >= totalFiles) return
        const item = items[i]
        try {
          await this.downloadOne(item)
        } catch (e) {
          if (e instanceof AbortError) {
            // 取消：整批结束；暂停：不算失败，退回队首等恢复
            if (this.canceled) throw e
            cursor--
            continue
          }
          errors.push(`${item.dest}\u0000${(e as Error).message}`)
        }
        done++
        onProgress?.(done, totalFiles)
      }
    }
    const n = Math.max(1, Math.min(threads, totalFiles))
    const results = await Promise.allSettled(new Array(n).fill(0).map(worker))
    for (const r of results) {
      if (r.status === 'rejected' && r.reason instanceof AbortError && this.canceled) throw r.reason
    }
  }

  /* ---------------- 单文件 ---------------- */

  private async downloadOne(item: DlItem) {
    const stat = await fs.promises.stat(item.dest).catch(() => undefined)
    if (stat && stat.size > 0 && (!item.size || stat.size === item.size)) return

    await fs.promises.mkdir(path.dirname(item.dest), { recursive: true })

    // 镜像和官方在某些设置下是同一个地址，去重免得同一个地址白试好几次
    item.urls = [...new Set(item.urls.filter(Boolean))]
    const size = item.size ?? (await this.probeSize(item.urls))
    if (size >= MIN_CHUNK && this.chunks > 1) await this.downloadChunked(item, size)
    else await this.downloadSingle(item.urls, item.dest)
  }

  private async probeSize(urls: string[]): Promise<number> {
    for (const u of urls) {
      try {
        const r = await dlFetch(u, { method: 'HEAD', headers: UA, signal: AbortSignal.timeout(15000) })
        if (r.ok) return Number(r.headers.get('content-length') ?? 0) || 0
      } catch {
        /* 换下一个源 */
      }
    }
    return 0
  }

  /** 读超时：按这条线路的实测建连耗时给，别再一律 45 秒干等 */
  private readTimeout(): number {
    const base = this.connectAvg > 0 ? this.connectAvg * 3 : 20000
    return Math.max(12000, Math.min(30000, Math.round(base)))
  }

  /** 大文件：分块「并发」+ 断点续传（原来是串行，等于只有一个连接在跑） */
  private async downloadChunked(item: DlItem, size: number) {
    const part = `${item.dest}.part`
    const metaFile = `${item.dest}.part.json`

    let states: ChunkState[] | undefined
    try {
      const saved = JSON.parse(await fs.promises.readFile(metaFile, 'utf-8')) as { size: number; states: ChunkState[] }
      if (saved.size === size && Array.isArray(saved.states) && saved.states.length > 0) states = saved.states
    } catch {
      /* 没有断点记录 */
    }
    if (!states) {
      const want = Math.max(item.conns ?? this.connsPerFile, 1)
      const n = Math.max(1, Math.min(want, Math.ceil(size / MIN_CHUNK)))
      const step = Math.ceil(size / n)
      states = Array.from({ length: n }, (_, i) => ({
        start: i * step,
        end: Math.min(size, (i + 1) * step) - 1,
        done: 0
      }))
      await fs.promises.writeFile(metaFile, JSON.stringify({ size, states }), 'utf-8')
    }

    const fh = await fs.promises.open(part, fs.existsSync(part) ? 'r+' : 'w+')
    const all = states
    const saveMeta = () => fs.promises.writeFile(metaFile, JSON.stringify({ size, states: all }), 'utf-8').catch(() => undefined)

    const queue = all.filter((s) => s.start + s.done <= s.end)
    const conns = Math.max(1, Math.min(item.conns ?? this.connsPerFile, queue.length))
    let fallback = false
    /** 线路不认 Range（回 200）时退回「单流整包」：一条连接从 0 读到尾 */
    let wholeMode = false
    let wholeDone = 0
    let fatal: unknown

    const worker = async () => {
      while (!fallback) {
        await this.gate()
        const st = queue.shift()
        if (!st) return
        let tries = 0
        for (;;) {
          await this.gate()
          if (st.start + st.done > st.end) {
            trace('chunk done', st.start)
            break
          }
          const before = st.done
          const release = await this.limiter.acquire()
          const releaseHost = await this.hostLimiter(item.urls[0] ?? '').acquire()
          const ctrl = new AbortController()
          this.inflight.add(ctrl)
          let interrupted = false
          try {
            const t0 = Date.now()
            trace('req', st.start, st.done, item.urls[0])
            const res = await fetchWithTimeout(
              this.fetchRange(item.urls, `bytes=${st.start + st.done}-${st.end}`, ctrl.signal),
              HEADER_TIMEOUT_MS,
              ctrl
            )
            const dt = Date.now() - t0
            trace('res', st.start, res.status, dt + 'ms')
            this.connectAvg = this.connectAvg > 0 ? this.connectAvg * 0.7 + dt * 0.3 : dt
            if (res.status !== 206 && res.status !== 200) {
              await res.body?.cancel().catch(() => undefined)
              trace('bad status', st.start, res.status)
              fallback = true
              break
            }
            if (res.status === 200) {
              // 这条线路根本不认 Range，直接回整包。那就让这一条连接把整包从 0
              // 读到尾（body 本来就从 0 开始），其余分片全部作废。
              if (wholeMode) {
                await res.body?.cancel().catch(() => undefined)
                trace('200 but whole mode already running', st.start)
                break
              }
              trace('200 -> whole-file mode', st.start)
              wholeMode = true
              fallback = true
              st.start = 0
              st.end = size - 1
              st.done = 0
              wholeDone = 0
            }
            const reader = res.body?.getReader()
            if (!reader) throw new Error('响应没有 body')
            let lastData = Date.now()
            for (;;) {
              if (this.pausedNow || this.canceled) {
                interrupted = true
                await reader.cancel().catch(() => undefined)
                break
              }
              const { done, value } = await readWithIdle(reader, this.readTimeout())
              if (done) break
              if (!value) continue
              // 慢速掐断：5 秒没来数据、而这段时间收到的还不到 1KB → 这条连接废了，重连
              const gap = Date.now() - lastData
              if (gap > 5000 && gap > value.byteLength) throw new StallError()
              lastData = Date.now()
              await fh.write(value, 0, value.byteLength, st.start + st.done)
              st.done += value.byteLength
              if (wholeMode) wholeDone = st.done
              this.bytes += value.byteLength
              this.onBytes?.(value.byteLength)
              await this.throttle(value.byteLength)
            }
          } catch (e) {
            if (this.canceled || this.signal?.aborted) throw new AbortError()
            if (this.pausedNow) {
              interrupted = true
            } else {
              // 卡住/超时/被掐：这一块已下多少记在 st.done 里，退避后接着要
              // 只要这一次「确实推进了」，就把失败计数清零 —— 线路抖动时
              // 每条连接都可能被掐，但只要还在往前爬就不该放弃。
              noteTransferProblem(item.urls[0] ?? '')
              trace('err', st.start, tries + 1, String(e))
              tries = st.done > before ? 0 : tries + 1
              if (tries >= 12) {
                fallback = true
                break
              }
              await sleep(300 * Math.min(tries, 6))
              if (wholeMode) {
                // 整包模式重试只能从头来
                st.done = 0
                wholeDone = 0
              }
              interrupted = true
            }
          } finally {
            this.inflight.delete(ctrl)
            releaseHost()
            release()
            await saveMeta()
          }
          if (interrupted) {
            if (this.pausedNow) {
              // 暂停：把这块退回队列，跳出内层重试 → 外层 while 回到 gate() 原地等恢复，
              // 恢复后从断点接着下（不是收工返回，否则调用方会以为这一步下完了）
              queue.unshift(st)
              break
            }
            continue
          }
          break
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: conns }, () => worker()))
    } catch (e) {
      fatal = e
    }
    await fh.close().catch(() => undefined)
    await saveMeta()

    if (fatal !== undefined) throw fatal
    if (wholeMode) {
      if (this.pausedNow || this.canceled) return
      if (wholeDone >= size) {
        await fs.promises.rename(part, item.dest)
        await fs.promises.rm(metaFile, { force: true }).catch(() => undefined)
        return
      }
      trace('whole mode incomplete', wholeDone, size)
    }
    if (fallback) {
      // 有些线路（或 Chromium 的同 host 连接上限）对多连接就是不行：
      // 退回「1 条连接的分块下载」，断点全保留，比删档重下安全得多。
      const cur = item.conns ?? this.connsPerFile
      if (cur > 1) {
        await this.downloadChunked({ ...item, conns: 1 }, size)
        return
      }
      await fs.promises.rm(part, { force: true }).catch(() => undefined)
      await fs.promises.rm(metaFile, { force: true }).catch(() => undefined)
      await this.downloadSingle(item.urls, item.dest)
      return
    }
    // 暂停/取消时没下完，别改名，保留断点
    if (this.pausedNow || this.canceled) return
    if (all.some((s) => s.start + s.done <= s.end)) throw new Error('分片没下完')

    await fs.promises.rename(part, item.dest)
    await fs.promises.rm(metaFile, { force: true }).catch(() => undefined)
  }

  private async fetchRange(urls: string[], range: string, signal: AbortSignal): Promise<Response> {
    let lastErr: unknown
    for (const u of urls) {
      try {
        return await dlFetch(u, { headers: { ...UA, Range: range }, signal })
      } catch (e) {
        if (signal.aborted || this.canceled) throw e
        lastErr = e
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('所有下载源都失败')
  }

  /** 小文件：单流直下（暂停时中断，恢复后重下这一个文件） */
  private async downloadSingle(urls: string[], dest: string): Promise<void> {
    const tmp = `${dest}.tmp`
    let lastErr: unknown
    for (const u of urls) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.gate()
        const release = await this.limiter.acquire()
        const releaseHost = await this.hostLimiter(u).acquire()
        const ctrl = new AbortController()
        this.inflight.add(ctrl)
        let streamOk = false
        let paused = false
        try {
          const res = await fetchWithTimeout(
            dlFetch(u, { headers: UA, signal: ctrl.signal }),
            HEADER_TIMEOUT_MS,
            ctrl
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const reader = res.body?.getReader()
          if (!reader) throw new Error('响应没有 body')
          const fh = await fs.promises.open(tmp, 'w')
          try {
            let lastData = Date.now()
            for (;;) {
              if (this.pausedNow || this.canceled) {
                paused = true
                await reader.cancel().catch(() => undefined)
                break
              }
              const { done, value } = await readWithIdle(reader, this.readTimeout())
              if (done) break
              if (!value) continue
              const gap = Date.now() - lastData
              if (gap > 5000 && gap > value.byteLength) throw new StallError()
              lastData = Date.now()
              await fh.write(value)
              this.bytes += value.byteLength
              this.onBytes?.(value.byteLength)
              await this.throttle(value.byteLength)
            }
            streamOk = !paused
          } finally {
            await fh.close().catch(() => undefined)
          }
        } catch (e) {
          if (this.canceled || this.signal?.aborted) throw new AbortError()
          if (this.pausedNow) paused = true
          else noteTransferProblem(u)
          lastErr = e
        } finally {
          this.inflight.delete(ctrl)
          releaseHost()
          release()
        }

        if (streamOk) {
          await fs.promises.rename(tmp, dest)
          return
        }
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        if (paused) {
          // 暂停：不算失败，等恢复后把同一个地址重来一次
          await this.gate()
          attempt--
          continue
        }
        if (attempt < 3) await sleep(500 * attempt)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('下载失败')
  }
}

/* ---------------- 全局注册表：给 IPC 的暂停/继续/取消用 ---------------- */

const registry = new Map<string, MultiDownloader>()

export function registerDownloader(key: string, dl: MultiDownloader) {
  registry.set(key, dl)
}

export function unregisterDownloader(key: string) {
  registry.delete(key)
}

export function pauseDownload(key: string): boolean {
  const dl = registry.get(key)
  if (!dl) return false
  dl.pause()
  return true
}

export function resumeDownload(key: string): boolean {
  const dl = registry.get(key)
  if (!dl) return false
  dl.resume()
  return true
}

export function cancelDownload(key: string): boolean {
  const dl = registry.get(key)
  if (!dl) return false
  dl.cancel()
  return true
}

export function downloaderState(key: string) {
  const dl = registry.get(key)
  return { exists: !!dl, paused: dl?.isPaused ?? false, bytes: dl?.downloaded ?? 0 }
}
