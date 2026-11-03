import fs from 'node:fs'
import path from 'node:path'

/**
 * 落盘的键值缓存。
 *
 * 内容管理每次进页面都要把每个 mod jar 打开一遍读 fabric.mod.json / mods.toml，
 * 几百个 mod 的整合包冷启动能卡上一两秒。这里把结果按「路径|大小|修改时间」存到
 * data/cache 下的 json 里，下次启动直接命中，不用再把压缩包拆一遍。
 *
 * - 只碰文件系统，不依赖 electron，方便单测
 * - 写盘是原子的（先写 .tmp 再 rename），坏了就当空缓存用，绝不影响启动
 * - 超过 limit 条 / 超过 maxAgeMs 没被碰过的条目在写盘时丢掉
 */

interface Entry<T> {
  /** 最后一次写入时间 */
  t: number
  v: T
}

interface FileShape<T> {
  version: number
  entries: Record<string, Entry<T>>
}

export interface DiskCacheOptions {
  /** 最多保留多少条（默认 20000） */
  limit?: number
  /** 多久没碰过就丢（默认 30 天） */
  maxAgeMs?: number
  /** 攒多久写一次盘（默认 1500ms；测试里可以调小） */
  flushDelayMs?: number
  /** 注入时钟，方便测试 */
  now?: () => number
}

const VERSION = 1

export class DiskCache<T> {
  private mem = new Map<string, Entry<T>>()
  private loaded = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false
  private readonly limit: number
  private readonly maxAgeMs: number
  private readonly flushDelayMs: number
  private readonly now: () => number

  constructor(
    private readonly file: string,
    opts: DiskCacheOptions = {}
  ) {
    this.limit = opts.limit ?? 20_000
    this.maxAgeMs = opts.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
    this.flushDelayMs = opts.flushDelayMs ?? 1500
    this.now = opts.now ?? Date.now
  }

  private load() {
    if (this.loaded) return
    this.loaded = true
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf-8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as FileShape<T>
      if (!parsed || parsed.version !== VERSION || !parsed.entries) return
      const now = this.now()
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry.t !== 'number') continue
        if (now - entry.t > this.maxAgeMs) continue
        this.mem.set(key, entry)
      }
    } catch {
      // 文件坏了就当没有：下次写入会覆盖掉
    }
  }

  get(key: string): T | undefined {
    this.load()
    return this.mem.get(key)?.v
  }

  set(key: string, value: T): void {
    this.load()
    this.mem.set(key, { t: this.now(), v: value })
    this.dirty = true
    this.schedule()
  }

  delete(key: string): void {
    this.load()
    if (this.mem.delete(key)) {
      this.dirty = true
      this.schedule()
    }
  }

  /** 清空内存里的表（不动磁盘），用于实例被删之类的情况 */
  clear(): void {
    this.load()
    this.mem.clear()
    this.dirty = true
    this.schedule()
  }

  get size(): number {
    this.load()
    return this.mem.size
  }

  private schedule() {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.flush()
      } catch {
        /* 写不进去就算了，内存里还有 */
      }
    }, this.flushDelayMs)
    // 别因为这个定时器把进程吊着
    ;(this.timer as unknown as { unref?: () => void }).unref?.()
  }

  /** 立刻写盘（同时也做裁剪） */
  flush(): void {
    this.load()
    if (!this.dirty) return
    const now = this.now()
    const alive = [...this.mem.entries()]
      .filter(([, e]) => now - e.t <= this.maxAgeMs)
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, this.limit)
    this.mem = new Map(alive)

    const payload: FileShape<T> = { version: VERSION, entries: Object.fromEntries(alive) }
    const text = JSON.stringify(payload)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, text, 'utf-8')
    fs.renameSync(tmp, this.file)
    this.dirty = false
  }
}
