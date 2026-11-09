import fs from 'node:fs'
import path from 'node:path'
import type { SaveBackup, SaveBackupKind, SavesBackupResult } from '../shared/types'
import { readZipEntry, readZipFromFile, zipDirectory } from './zip'

export type { SavesBackupResult }

/**
 * 存档快照（备份 / 回滚）的纯文件逻辑。
 * 这里只碰文件系统，不依赖 store / electron，方便单独跑测试。
 */

/** 快照文件名：<实例>-saves-<本地时间>.zip */
export function backupFileName(instanceId: string, date = new Date()): string {
  const stamp = date.toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  return `${instanceId}-saves-${stamp}.zip`
}

/** 快照旁边的小说明（.zip.json）：记下装了什么，列表不解压就能显示 */
interface BackupMeta {
  worlds: string[]
  files: number
  instanceId: string
  instanceName?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  createdAt: number
  /** 传上云端之后的记录 id / 时间（没传过就没有） */
  cloudId?: string
  cloudAt?: number
  /** 这份怎么来的（老快照没有） */
  kind?: SaveBackupKind
}

function metaFile(zipFile: string): string {
  return `${zipFile}.json`
}

/** saves 目录下一级的存档目录（新世界、新的世界1 …） */
export function listWorldDirs(savesDir: string): string[] {
  try {
    return fs
      .readdirSync(savesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  } catch {
    return []
  }
}

/**
 * 把 saves 目录整包打成快照。返回文件路径 + 装了哪些存档；没有文件时返回 undefined。
 * 顺手写一份 .zip.json，列表页不用解压就知道这份里有哪些世界。
 */
export function createBackup(
  savesDir: string,
  backupDir: string,
  instanceId: string,
  date = new Date(),
  extra: { instanceName?: string; mcVersion?: string; loader?: string; loaderVersion?: string; kind?: SaveBackupKind } = {}
): SavesBackupResult | undefined {
  if (!fs.existsSync(savesDir)) return undefined
  const worlds = listWorldDirs(savesDir)
  fs.mkdirSync(backupDir, { recursive: true })
  const out = path.join(backupDir, backupFileName(instanceId, date))
  const files = zipDirectory(savesDir, out)
  if (files === 0) {
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* 空包删不掉就算了 */
    }
    return undefined
  }
  const bytes = fs.statSync(out).size
  const meta: BackupMeta = {
    worlds,
    files,
    instanceId,
    instanceName: extra.instanceName,
    mcVersion: extra.mcVersion,
    loader: extra.loader,
    loaderVersion: extra.loaderVersion,
    kind: extra.kind,
    createdAt: date.getTime()
  }
  try {
    fs.writeFileSync(metaFile(out), JSON.stringify(meta, null, 2), 'utf-8')
  } catch {
    /* 说明文件写不进去也不影响快照本身 */
  }
  return {
    file: out,
    worlds,
    files,
    bytes,
    instanceId,
    instanceName: extra.instanceName,
    mcVersion: extra.mcVersion,
    loader: extra.loader,
    loaderVersion: extra.loaderVersion
  }
}

/** 上传成功后在 .zip.json 里记一笔：这份已经同步到云端了（列表能点亮徽标） */
export function markBackupSynced(zipFile: string, cloudId: string, at = Date.now()): void {
  const meta = readBackupMeta(zipFile)
  if (!meta) return
  try {
    fs.writeFileSync(
      metaFile(zipFile),
      JSON.stringify({ ...meta, cloudId, cloudAt: at }, null, 2),
      'utf-8'
    )
  } catch {
    /* 记不上不影响备份本身 */
  }
}

/** 读快照旁边的说明（老快照没有就返回 undefined） */
export function readBackupMeta(zipFile: string): BackupMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaFile(zipFile), 'utf-8')) as BackupMeta
  } catch {
    return undefined
  }
}

/** 列出某实例的快照（新的在前） */
export function listBackups(backupDir: string, instanceId: string): SaveBackup[] {
  if (!fs.existsSync(backupDir)) return []
  const prefix = `${instanceId}-saves-`
  try {
    return fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.zip'))
      .map((n) => {
        const full = path.join(backupDir, n)
        const stat = fs.statSync(full)
        const meta = readBackupMeta(full)
        return {
          file: full,
          name: n,
          bytes: stat.size,
          time: stat.mtimeMs,
          worlds: meta?.worlds,
          files: meta?.files,
          instanceName: meta?.instanceName,
          mcVersion: meta?.mcVersion,
          cloudId: meta?.cloudId,
          cloudAt: meta?.cloudAt,
          kind: meta?.kind
        }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

/**
 * 删掉一份快照（连同旁边的 .zip.json）。
 * 只认备份目录里的文件 —— 别处的路径一律拒掉，免得传错了把系统文件删了。
 */
export function deleteBackup(backupDir: string, file: string): boolean {
  const full = path.resolve(file)
  if (path.dirname(full).toLowerCase() !== path.resolve(backupDir).toLowerCase()) {
    throw new Error('只能删备份目录里的快照')
  }
  if (!fs.existsSync(full)) return false
  fs.rmSync(full, { force: true })
  fs.rmSync(metaFile(full), { force: true })
  return true
}

/** 只保留最近 keep 份（safety 那份不算在 keep 里），返回删掉的份数 */
export function pruneBackups(backupDir: string, instanceId: string, keep = 12): number {
  let removed = 0
  for (const item of listBackups(backupDir, instanceId).slice(keep)) {
    try {
      fs.rmSync(item.file, { force: true })
      fs.rmSync(metaFile(item.file), { force: true })
      removed++
    } catch {
      /* 删不掉就留着 */
    }
  }
  return removed
}

/**
 * 把快照覆盖写回 saves 目录。
 * 覆盖而不是清空重来 —— 快照里没有的存档保持原样，不会误删新世界。
 * 返回写回的文件数与涉及的存档目录名。
 */
export function restoreBackup(
  savesDir: string,
  backupDir: string,
  file: string,
  opts: { avoidOverwrite?: boolean } = {}
): { restored: number; worlds: string[] } {
  const full = path.resolve(file)
  if (path.dirname(full).toLowerCase() !== path.resolve(backupDir).toLowerCase()) {
    throw new Error('只能回滚备份目录里的快照')
  }
  if (!fs.existsSync(full)) throw new Error('快照文件不在了')

  const { buf, entries } = readZipFromFile(full)
  const worlds = new Set<string>()
  let restored = 0

  // 从别的整合包/别的电脑带回来的存档：目标 saves 里已经有同名世界时不能直接覆盖
  // （两个不同的世界合到一起 = 区块错乱），改成「世界名（云端恢复 2）」另存一份。
  const remap = new Map<string, string>()
  if (opts.avoidOverwrite) {
    const tops = new Set<string>()
    for (const e of entries) {
      const top = e.name.split('/')[0]
      if (top) tops.add(top)
    }
    for (const top of tops) {
      if (!fs.existsSync(path.join(savesDir, top))) continue
      let n = 2
      while (fs.existsSync(path.join(savesDir, `${top}（云端恢复 ${n}）`))) n++
      remap.set(top, `${top}（云端恢复 ${n}）`)
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue
    // 带 .. / 绝对路径 / 盘符的条目直接丢掉（防 zip slip，别把文件写到 saves 外面）
    if (path.isAbsolute(entry.name) || entry.name.includes(':') || entry.name.split('/').some((p) => p === '..' || p === '.')) {
      continue
    }
    const parts = entry.name.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) continue
    const renamed = remap.get(parts[0])
    if (renamed) parts[0] = renamed
    const dest = path.join(savesDir, ...parts)
    const resolved = path.resolve(dest)
    if (resolved !== path.resolve(savesDir) && !resolved.startsWith(path.resolve(savesDir) + path.sep)) continue
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, readZipEntry(buf, entry))
    restored++
    worlds.add(parts[0])
  }

  return { restored, worlds: [...worlds] }
}
