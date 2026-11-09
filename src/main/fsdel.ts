import fs from 'node:fs'
import path from 'node:path'

/**
 * 带进度的删目录。
 *
 * fs.rmSync(dir, { recursive: true }) 在几 GB、几万个小文件的实例上要转好几秒到几十秒，
 * 界面看着像卡死（用户点了「删除」完全没反应）。这里先数一遍，再逐个删并回报进度，
 * 于是任务面板能显示「删到 3721/18093」和已释放的字节数。
 */

export interface TreeMeasure {
  files: number
  bytes: number
  dirs: number
}

export interface RemoveProgress {
  current: number
  total: number
  bytes: number
  totalBytes: number
  detail?: string
}

export interface RemoveResult {
  removed: number
  failed: number
  bytes: number
}

/** 先量一遍：文件数 / 字节数（不读文件内容，只 stat） */
export function measureTree(root: string): TreeMeasure {
  const out: TreeMeasure = { files: 0, bytes: 0, dirs: 0 }
  const walk = (dir: string) => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    out.dirs++
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) {
        walk(full)
      } else if (it.isFile()) {
        out.files++
        try {
          out.bytes += fs.statSync(full).size
        } catch {
          /* 读不到大小就当 0，不影响删 */
        }
      }
    }
  }
  walk(root)
  return out
}

/** 收集所有文件（深度优先，顺带按删除顺序倒着记目录，好自底向上 rmdir） */
function collect(root: string): { files: string[]; dirs: string[] } {
  const files: string[] = []
  const dirs: string[] = []
  const walk = (dir: string) => {
    dirs.push(dir)
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const it of items) {
      const full = path.join(dir, it.name)
      if (it.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(root)
  return { files, dirs }
}

/**
 * 删掉整个目录，边删边报进度。
 * 单个文件删不掉（被游戏/杀软占用）只计数，不中断——剩下的最后还是 rmSync 兜一次。
 */
export function removeTreeWithProgress(
  root: string,
  onProgress?: (p: RemoveProgress) => void,
  shouldStop?: () => boolean
): RemoveResult {
  const res: RemoveResult = { removed: 0, failed: 0, bytes: 0 }
  if (!fs.existsSync(root)) return res
  const total = measureTree(root)
  const { files, dirs } = collect(root)
  const totalFiles = Math.max(files.length, 1)
  let lastEmit = 0

  onProgress?.({ current: 0, total: totalFiles, bytes: 0, totalBytes: total.bytes, detail: '开始删除…' })

  for (let i = 0; i < files.length; i++) {
    if (shouldStop?.()) break
    const f = files[i]
    let size = 0
    try {
      size = fs.statSync(f).size
    } catch {
      /* 已经不在了 */
    }
    try {
      fs.rmSync(f, { force: true })
      res.removed++
      res.bytes += size
    } catch {
      res.failed++
    }
    // 每 50 个文件或每 200ms 报一次，别把 IPC 塞爆
    const now = Date.now()
    if (now - lastEmit > 200 || i === files.length - 1) {
      lastEmit = now
      onProgress?.({
        current: i + 1,
        total: totalFiles,
        bytes: res.bytes,
        totalBytes: total.bytes,
        detail: path.basename(f)
      })
    }
  }

  // 目录自底向上删（顺序不重要，失败就留着，下面 rmSync 会兜）
  for (const d of dirs.reverse()) {
    try {
      fs.rmdirSync(d)
    } catch {
      /* 非空或占用，留给兜底 */
    }
  }
  try {
    fs.rmSync(root, { recursive: true, force: true })
  } catch {
    /* 还有被占用的文件，尽力了 */
  }
  onProgress?.({ current: totalFiles, total: totalFiles, bytes: res.bytes, totalBytes: total.bytes, detail: '完成' })
  return res
}
