import fs from 'node:fs'
import path from 'node:path'
import type { CleanResult, DiskUsage, UsageItem } from '../shared/types'


interface Walked {
  bytes: number
  files: number
  partial: boolean
}

/** 递归量一个目录的大小（超时就先返回，partial=true）。
 * 传 seen 会按 inode 去重：硬链接在各个实例里只算一次，否则去重之后占用会被算成好几倍。 */
async function walkSize(
  dir: string,
  deadline: number,
  filter?: (file: string) => boolean,
  seen?: Set<string>
): Promise<Walked> {
  let bytes = 0
  let files = 0
  let partial = false
  const walk = async (d: string) => {
    if (partial || Date.now() > deadline) {
      partial = true
      return
    }
    let ents: fs.Dirent[]
    try {
      ents = await fs.promises.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        if (filter && !filter(p)) continue
        try {
          const st = await fs.promises.stat(p)
          if (seen && st.nlink > 1) {
            const key = `${st.dev}:${st.ino}`
            if (seen.has(key)) continue
            seen.add(key)
          }
          bytes += st.size
          files++
        } catch {
          /* 读不到就算了 */
        }
      }
    }
  }
  await walk(dir)
  return { bytes, files, partial }
}

const exists = (p: string) => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 数据目录里各块的占用：实例 / 下载 / 缓存 / 存档快照 / 日志 */
export async function dataUsage(dataDir: string, budgetMs = 4000): Promise<DiskUsage> {
  const deadline = Date.now() + budgetMs
  const items: UsageItem[] = []

  const instancesDir = path.join(dataDir, 'instances')
  // 硬链接去重之后，同一份 jab 会在多个实例里各有一个目录项：按 inode 只算一次，
  // 否则「实例与游戏文件」会把去重省下的那部分重复算进去
  const seen = new Set<string>()
  const inst = exists(instancesDir)
    ? await walkSize(instancesDir, deadline, undefined, seen)
    : { bytes: 0, files: 0, partial: false }
  items.push({
    key: 'instances',
    label: '实例与游戏文件',
    path: instancesDir,
    bytes: inst.bytes,
    files: inst.files,
    cleanable: false,
    hint: '删了就得重新下载，只能一个个实例删',
    inTotal: true
  })

  // 内容仓库：共享用的那份底本，字节数已经算在上面（按 inode 去重），这里只报个数
  const blobsDir = path.join(dataDir, 'blobs')
  if (exists(blobsDir)) {
    const bl = await walkSize(blobsDir, deadline)
    items.push({
      key: 'blobs',
      label: '共享内容仓库',
      path: blobsDir,
      bytes: bl.bytes,
      files: bl.files,
      cleanable: false,
      hint: '硬链接去重的底本，已包含在上面「实例与游戏文件」里，不重复计入合计',
      inTotal: false
    })
  }

  const downloadsDir = path.join(dataDir, 'downloads')
  const dl = exists(downloadsDir) ? await walkSize(downloadsDir, deadline) : { bytes: 0, files: 0, partial: false }
  items.push({
    key: 'downloads',
    label: '下载目录',
    path: downloadsDir,
    bytes: dl.bytes,
    files: dl.files,
    cleanable: true,
    hint: '贴链接下载下来的文件，清掉不影响游戏',
    inTotal: true
  })

  const cacheDir = path.join(dataDir, 'cache')
  const cache = exists(cacheDir) ? await walkSize(cacheDir, deadline) : { bytes: 0, files: 0, partial: false }
  items.push({
    key: 'cache',
    label: '元数据缓存',
    path: cacheDir,
    bytes: cache.bytes,
    files: cache.files,
    cleanable: true,
    hint: 'jar 元数据、版本清单缓存，清掉下次自己重建（稍慢一点）',
    inTotal: true
  })

  const backupsDir = path.join(dataDir, 'backups')
  const bk = exists(backupsDir) ? await walkSize(backupsDir, deadline) : { bytes: 0, files: 0, partial: false }
  items.push({
    key: 'backups',
    label: '存档快照',
    path: backupsDir,
    bytes: bk.bytes,
    files: bk.files,
    cleanable: false,
    hint: '启动前自动备份的存档，到「内容管理 → 存档快照」里回滚或删',
    inTotal: true
  })

  // 日志：各实例里的 logs / crash-reports，已经算在实例里了，单独列出来方便清
  let logBytes = 0
  let logFiles = 0
  let logPartial = false
  if (exists(instancesDir)) {
    let names: string[] = []
    try {
      names = (await fs.promises.readdir(instancesDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      /* 打不开就算了 */
    }
    for (const n of names) {
      for (const sub of ['minecraft/logs', 'minecraft/crash-reports', 'logs', 'crash-reports']) {
        const d = path.join(instancesDir, n, sub)
        if (!exists(d)) continue
        const w = await walkSize(d, deadline)
        logBytes += w.bytes
        logFiles += w.files
        if (w.partial) logPartial = true
      }
    }
  }
  items.push({
    key: 'logs',
    label: '游戏日志与崩溃报告',
    path: path.join(instancesDir, '<实例>', 'logs'),
    bytes: logBytes,
    files: logFiles,
    cleanable: true,
    hint: 'latest.log、崩溃报告，清掉不影响游戏（已经算在实例里，不重复计入总计）',
    inTotal: false
  })

  const totalBytes = items.filter((i) => i.inTotal).reduce((s, i) => s + i.bytes, 0)
  const totalFiles = items.filter((i) => i.inTotal).reduce((s, i) => s + i.files, 0)
  const partial = inst.partial || dl.partial || cache.partial || bk.partial || logPartial
  return { dir: dataDir, total: { bytes: totalBytes, files: totalFiles }, items, partial }
}

function removeAll(dir: string, onFile: (p: string, size: number) => void) {
  let ents: fs.Dirent[] = []
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      removeAll(p, onFile)
      try {
        fs.rmdirSync(p)
      } catch {
        /* 里面还有删不掉的东西 */
      }
    } else if (e.isFile()) {
      try {
        const size = fs.statSync(p).size
        fs.unlinkSync(p)
        onFile(p, size)
      } catch {
        /* 正被占用（游戏开着），跳过 */
      }
    }
  }
}

/**
 * 清一个分类。只允许 downloads / cache / logs —— 实例和存档快照必须走各自的正规入口，
 * 免得从这儿一键把整个游戏目录抹了。
 */
export function cleanCategory(dataDir: string, key: 'downloads' | 'cache' | 'logs'): CleanResult {
  let files = 0
  let bytes = 0
  const tally = (_p: string, size: number) => {
    files++
    bytes += size
  }
  if (key === 'downloads') {
    removeAll(path.join(dataDir, 'downloads'), tally)
    return { files, bytes }
  }
  if (key === 'cache') {
    removeAll(path.join(dataDir, 'cache'), tally)
    return { files, bytes }
  }
  const instancesDir = path.join(dataDir, 'instances')
  let names: string[] = []
  try {
    names = fs
      .readdirSync(instancesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return { files, bytes }
  }
  for (const n of names) {
    for (const sub of ['minecraft/logs', 'minecraft/crash-reports', 'logs', 'crash-reports']) {
      const d = path.join(instancesDir, n, sub)
      if (exists(d)) removeAll(d, tally)
    }
  }
  return { files, bytes }
}
