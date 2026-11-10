import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BlobStats, DedupeResult } from '../shared/types'
import { store } from './store'

/**
 * 内容仓库（硬链接去重）
 *
 * 同一份 jar / zip 在几个实例里各存一份，F 盘上就白占几份空间。
 * 这里把文件按 sha1 收进 `<dataDir>/blobs/<前两位>/<sha1>`，实例里的那份改成
 * 指向它的**硬链接** —— 同一个 inode，装几遍都只占一份。
 *
 * 引用计数不另存账本，直接看 inode 的 nlink：
 *   仓库自己算 1 个链接，实例里每多一份 nlink 就 +1。
 *   所以 nlink === 1 的 blob 就是没人用的孤儿，可以清掉。
 *
 * 硬链接的雷区只有一个：**就地改写**会顺着链接改到仓库那份，把别的实例一起改坏。
 * 所以：
 *   · 只接管不会被就地改写的文件（模组 jar、资源包/光影/数据包 zip）；
 *   · 下载器都是「写 .part 再 rename」，rename 换的是 dentry，安全；
 *   · 少数真的就地写的地方（从备份还原）必须先调 `unshare()` 断开链接。
 */

const SHARD = 2

export function blobRoot(): string {
  return path.join(store.dataDir, 'blobs')
}

function blobPath(sha1: string): string {
  return path.join(blobRoot(), sha1.slice(0, SHARD), sha1)
}

/** 允许被硬链接共享的文件：模组 jar、资源包 / 光影 / 数据包 zip。配置文件一律不碰（会被就地改写）。 */
export function shareable(file: string): boolean {
  const p = file.replace(/\\/g, '/').toLowerCase()
  if (/(^|\/)mods\/[^/]+\.jar(\.disabled)?$/.test(p)) return true
  if (/(^|\/)(resourcepacks|shaderpacks|datapacks)\/[^/]+\.zip$/.test(p)) return true
  return false
}

/** 流式算 sha1（大 jar 也只有一个缓冲区） */
export function sha1File(file: string): string {
  const h = crypto.createHash('sha1')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (!n) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

function sameInode(a: string, b: string): boolean {
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.dev === sb.dev && sa.ino === sb.ino
  } catch {
    return false
  }
}

/**
 * 把一个文件收进仓库，原位置换成硬链接。
 * 返回：
 *   'linked' —— 仓库里本来就有同一份内容，这次真的省下了这份空间；
 *   'stored' —— 第一次见到这份内容，收进仓库当底本（暂时还不省空间）；
 *   'kept'   —— 没动（跨盘、不是普通文件、算不出哈希之类）。
 */
export function adopt(file: string, opts: { knownSha1?: string } = {}): 'linked' | 'stored' | 'kept' {
  let st: fs.Stats
  try {
    st = fs.lstatSync(file)
  } catch {
    return 'kept'
  }
  if (!st.isFile() || st.nlink === 0) return 'kept'

  // 已经在仓库里躺着（实例那份本身就是仓库的链接）：什么都不用做
  const root = blobRoot()
  const resolved = path.resolve(file)
  if (resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep)) return 'kept'

  const sha1 = opts.knownSha1 ?? sha1File(file)
  const target = blobPath(sha1)

  if (fs.existsSync(target)) {
    if (sameInode(file, target)) return 'kept'
    // 仓库里已经有同一份内容：把实例这份换成链接，立刻省下这份空间。
    // 先链到临时名再 rename 覆盖 —— 中间任何一步断了，原文件都还在。
    const tmp = `${file}.adopt`
    try {
      fs.linkSync(target, tmp)
      fs.renameSync(tmp, file)
      return 'linked'
    } catch {
      fs.rmSync(tmp, { force: true })
      return 'kept'
    }
  }

  // 仓库里没有：先搬进仓库（同盘 rename 不复制字节），再链回来
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(file, target)
  } catch {
    // 跨盘或不许 rename：拷一份进去，原文件留着（这时并没有省空间）
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      fs.copyFileSync(file, tmp)
      fs.renameSync(tmp, target)
    } catch {
      return 'kept'
    }
    return 'kept'
  }
  try {
    fs.linkSync(target, file)
    return 'stored'
  } catch {
    try {
      fs.copyFileSync(target, file)
    } catch {
      /* 拷不回来就只能让调用方重新下载了，但仓库里这份是好的 */
    }
    return 'kept'
  }
}

/**
 * 就地写之前先断开硬链接：有别的引用就先复制一份再替换，
 * 只换自己的 dentry，仓库那份和别的实例那份都不受影响。
 */
export function unshare(file: string): boolean {
  let st: fs.Stats
  try {
    st = fs.lstatSync(file)
  } catch {
    return false
  }
  if (!st.isFile() || st.nlink <= 1) return false
  const tmp = `${file}.unshare`
  try {
    fs.copyFileSync(file, tmp)
    fs.renameSync(tmp, file)
    return true
  } catch {
    fs.rmSync(tmp, { force: true })
    return false
  }
}

interface WalkHit {
  file: string
  size: number
  nlink: number
}

function walkBlobs(dir: string, out: WalkHit[]): void {
  let ents: fs.Dirent[]
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkBlobs(p, out)
    else if (e.isFile()) {
      try {
        const st = fs.statSync(p)
        out.push({ file: p, size: st.size, nlink: st.nlink })
      } catch {
        /* 读不到就算了 */
      }
    }
  }
}

/** 仓库现状：唯一内容多少字节、被共享了多少份、省了多少、有多少孤儿 */
export function blobStats(budgetMs = 4000): BlobStats {
  const deadline = Date.now() + budgetMs
  const hits: WalkHit[] = []
  walkBlobs(blobRoot(), hits)
  let bytes = 0
  let links = 0
  let savedBytes = 0
  let orphans = 0
  let orphanBytes = 0
  let partial = false
  for (const h of hits) {
    if (Date.now() > deadline) {
      partial = true
      break
    }
    bytes += h.size
    // nlink 里有一个是仓库自己：nlink - 1 = 有多少处（实例 / 服务端）引用了它
    const refs = Math.max(0, h.nlink - 1)
    links += refs
    // 只存一份不省空间，从第二处引用开始才真的省下 (refs - 1) 份
    savedBytes += Math.max(0, refs - 1) * h.size
    if (h.nlink <= 1) {
      orphans++
      orphanBytes += h.size
    }
  }
  return { blobs: hits.length, bytes, links, savedBytes, orphans, orphanBytes, partial }
}

/** 清掉没人引用的 blob（nlink === 1：只剩仓库自己那一份） */
export function gcBlobs(): { files: number; bytes: number } {
  const hits: WalkHit[] = []
  walkBlobs(blobRoot(), hits)
  let files = 0
  let bytes = 0
  for (const h of hits) {
    if (h.nlink > 1) continue
    try {
      fs.rmSync(h.file, { force: true })
      files++
      bytes += h.size
    } catch {
      /* 正被占用，跳过 */
    }
  }
  // 顺手把空的分片目录收掉
  try {
    for (const name of fs.readdirSync(blobRoot())) {
      const d = path.join(blobRoot(), name)
      try {
        if (fs.statSync(d).isDirectory() && fs.readdirSync(d).length === 0) fs.rmdirSync(d)
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 仓库还不存在 */
  }
  return { files, bytes }
}

export interface DedupeProgress {
  phase?: string
  current?: number
  total?: number
}

/** 把一棵目录里能共享的文件都收进仓库（按需递归） */
export function dedupeTree(
  dir: string,
  opts: { signal?: AbortSignal; onProgress?: (p: DedupeProgress) => void } = {}
): DedupeResult {
  const files: string[] = []
  const collect = (d: string) => {
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) collect(p)
      else if (e.isFile() && shareable(p)) files.push(p)
    }
  }
  collect(dir)

  const res: DedupeResult = { scanned: files.length, linked: 0, bytes: 0 }
  let done = 0
  for (const f of files) {
    if (opts.signal?.aborted) break
    let size = 0
    try {
      const st = fs.statSync(f)
      if (st.nlink > 1) {
        // 已经是链接（仓库那份或别的实例）→ 不用再算一遍哈希
        done++
        if (done % 25 === 0 || done === files.length) opts.onProgress?.({ current: done, total: files.length })
        continue
      }
      size = st.size
    } catch {
      continue
    }
    if (adopt(f) === 'linked') {
      // 只有「仓库里本来就有这份内容」才算真省了字节；第一份是底本，不省
      res.linked++
      res.bytes += size
    }
    done++
    if (done % 25 === 0 || done === files.length) opts.onProgress?.({ current: done, total: files.length })
  }
  return res
}

/**
 * 复制一棵目录，但能共享的文件（模组 jar 等）走硬链接 —— 复制实例时
 * 900MB 的模组不真拷一遍，几十毫秒就完事，也不多占空间。
 */
export function copyTreeSharing(src: string, dest: string): void {
  const walk = (s: string, d: string) => {
    fs.mkdirSync(d, { recursive: true })
    let ents: fs.Dirent[]
    try {
      ents = fs.readdirSync(s, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const sp = path.join(s, e.name)
      const dp = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(sp, dp)
        continue
      }
      if (!e.isFile()) continue
      if (shareable(dp)) {
        adopt(sp)
        try {
          fs.linkSync(sp, dp)
          continue
        } catch {
          /* 跨盘 / 源那份没能收进仓库：退回复制 */
        }
      }
      try {
        fs.copyFileSync(sp, dp)
      } catch {
        /* 单个文件拷不过去就算了，别把整个复制搞挂 */
      }
    }
  }
  walk(src, dest)
}

/** 整个数据目录（所有实例）去重 */export function dedupeAll(opts: { signal?: AbortSignal; onProgress?: (p: DedupeProgress) => void } = {}): DedupeResult {
  const instancesDir = path.join(store.dataDir, 'instances')
  const total: DedupeResult = { scanned: 0, linked: 0, bytes: 0 }
  let names: string[] = []
  try {
    names = fs
      .readdirSync(instancesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return total
  }
  for (const n of names) {
    if (opts.signal?.aborted) break
    const game = path.join(instancesDir, n, 'minecraft')
    opts.onProgress?.({ phase: n })
    for (const sub of ['mods', 'resourcepacks', 'shaderpacks', 'datapacks']) {
      const r = dedupeTree(path.join(game, sub), opts)
      total.scanned += r.scanned
      total.linked += r.linked
      total.bytes += r.bytes
    }
  }
  return total
}
