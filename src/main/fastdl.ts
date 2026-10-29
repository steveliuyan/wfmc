import fs from 'node:fs'
import path from 'node:path'
import { AbortError } from './net'

/**
 * 多线程下载器（PCL2 风格）
 *
 * - 文件级并发：全局连接池（默认 48），一批文件同时跑，不会把连接打爆
 * - 块级并发：单文件 ≥ 8MB 时按 Range 切成若干块并行拉（默认 8 块 + 断点续传）
 * - 暂停 / 继续：暂停立刻中断在途请求；已完成的文件保留、大文件保留分块进度，
 *   继续时从断点续传，不会从头再来
 * - 失败重试：整批跑完后，失败的再补一轮
 */

export interface DlItem {
  urls: string[]
  dest: string
  size?: number
}

const UA = { 'User-Agent': 'WFMC/1.1 (Electron)' }
/** 小于这个大小不分块（小文件分块反而更慢） */
const MIN_CHUNK = 8 * 1024 * 1024

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 给请求加超时：和暂停用的 signal 取并集，僵死连接最多拖 30 秒 */
function withTimeout(signal: AbortSignal, ms = 30000): AbortSignal {
  const anyOf = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  const timeout = AbortSignal.timeout(ms)
  if (typeof anyOf === 'function') return anyOf([signal, timeout])
  return signal
}

interface ChunkState {
  start: number
  end: number
  done: number
}

export class MultiDownloader {
  readonly threads: number
  readonly chunks: number
  private paused = false
  private canceled = false
  private bytes = 0
  private inflight = new Set<AbortController>()
  private onBytes?: (delta: number) => void

  private limitBytesPerSec: number
  private gateUntil = 0

  constructor(opts: { threads?: number; chunks?: number; limitKbps?: number; onBytes?: (delta: number) => void } = {}) {
    this.threads = Math.max(1, Math.min(128, opts.threads ?? 48))
    this.chunks = Math.max(1, Math.min(16, opts.chunks ?? 8))
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
    while (this.paused && !this.canceled) await sleep(120)
    if (this.canceled) throw new AbortError()
  }

  /* ---------------- 对外入口 ---------------- */

  async downloadAll(items: DlItem[], onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const errors: string[] = []
    await this.runPool(items, this.threads, onProgress, errors)
    if (!this.canceled && !this.paused && errors.length > 0) {
      const failedDests = new Set(errors.map((e) => e.split('\u0000')[0]))
      const retry = items.filter((i) => failedDests.has(i.dest))
      const retryErrors: string[] = []
      if (retry.length > 0) await this.runPool(retry, 4, undefined, retryErrors)
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

    const size = item.size ?? (await this.probeSize(item.urls))
    if (size >= MIN_CHUNK && this.chunks > 1) await this.downloadChunked(item, size)
    else await this.downloadSingle(item.urls, item.dest)
  }

  private async probeSize(urls: string[]): Promise<number> {
    for (const u of urls) {
      try {
        const r = await fetch(u, { method: 'HEAD', headers: UA, signal: AbortSignal.timeout(15000) })
        if (r.ok) return Number(r.headers.get('content-length') ?? 0) || 0
      } catch {
        /* 换下一个源 */
      }
    }
    return 0
  }

  /** 大文件：分块 + 断点续传 */
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
      const step = Math.ceil(size / this.chunks)
      states = Array.from({ length: this.chunks }, (_, i) => ({
        start: i * step,
        end: Math.min(size, (i + 1) * step) - 1,
        done: 0
      }))
      await fs.promises.writeFile(metaFile, JSON.stringify({ size, states }), 'utf-8')
    }

    const fh = await fs.promises.open(part, fs.existsSync(part) ? 'r+' : 'w+')
    const saveMeta = () => fs.promises.writeFile(metaFile, JSON.stringify({ size, states }), 'utf-8').catch(() => undefined)

    try {
      for (const st of states) {
        for (;;) {
          await this.gate()
          const from = st.start + st.done
          if (from > st.end) break
          const ctrl = new AbortController()
          this.inflight.add(ctrl)
          let interrupted = false
          let mustFallback = false
          try {
            const res = await this.fetchRange(item.urls, `bytes=${from}-${st.end}`, ctrl.signal)
            if (res.status !== 206) {
              await res.body?.cancel().catch(() => undefined)
              mustFallback = true
            } else {
              const reader = res.body?.getReader()
              if (!reader) throw new Error('响应没有 body')
              for (;;) {
                if (this.paused || this.canceled) {
                  interrupted = true
                  await reader.cancel().catch(() => undefined)
                  break
                }
                const { done, value } = await reader.read()
                if (done) break
                if (!value) continue
                await fh.write(value, 0, value.byteLength, st.start + st.done)
                st.done += value.byteLength
                this.bytes += value.byteLength
                this.onBytes?.(value.byteLength)
                await this.throttle(value.byteLength)
              }
            }
          } catch (e) {
            if (this.canceled) throw new AbortError()
            if (ctrl.signal.aborted) interrupted = true
            else throw e
          } finally {
            this.inflight.delete(ctrl)
            await saveMeta()
          }

          if (mustFallback) {
            await fh.close().catch(() => undefined)
            await fs.promises.rm(part, { force: true }).catch(() => undefined)
            await fs.promises.rm(metaFile, { force: true }).catch(() => undefined)
            await this.downloadSingle(item.urls, item.dest)
            return
          }
          if (interrupted) continue
          break
        }
      }
    } finally {
      await fh.close().catch(() => undefined)
      await saveMeta()
    }

    await fs.promises.rename(part, item.dest)
    await fs.promises.rm(metaFile, { force: true }).catch(() => undefined)
  }

  private async fetchRange(urls: string[], range: string, signal: AbortSignal): Promise<Response> {
    let lastErr: unknown
    for (const u of urls) {
      try {
        return await fetch(u, { headers: { ...UA, Range: range }, signal })
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
      await this.gate()
      const ctrl = new AbortController()
      this.inflight.add(ctrl)
      let interrupted = false
      let streamOk = false
      try {
        const res = await fetch(u, { headers: UA, signal: withTimeout(ctrl.signal) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const reader = res.body?.getReader()
        if (!reader) throw new Error('响应没有 body')
        const fh = await fs.promises.open(tmp, 'w')
        try {
          for (;;) {
            if (this.paused || this.canceled) {
              interrupted = true
              await reader.cancel().catch(() => undefined)
              break
            }
            const { done, value } = await reader.read()
            if (done) break
            if (!value) continue
            await fh.write(value)
            this.bytes += value.byteLength
            this.onBytes?.(value.byteLength)
            await this.throttle(value.byteLength)
          }
          streamOk = !interrupted
        } finally {
          await fh.close().catch(() => undefined)
        }
      } catch (e) {
        if (this.canceled) throw new AbortError()
        if (ctrl.signal.aborted) interrupted = true
        else lastErr = e
      } finally {
        this.inflight.delete(ctrl)
      }

      if (interrupted) {
        await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
        await this.gate()
        return await this.downloadSingle(urls, dest)
      }
      if (streamOk) {
        await fs.promises.rename(tmp, dest)
        return
      }
    }
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined)
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
