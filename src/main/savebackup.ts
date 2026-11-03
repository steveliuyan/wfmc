import fs from 'node:fs'
import path from 'node:path'
import type { SaveBackup } from '../shared/types'
import { readZipEntry, readZipFromFile, zipDirectory } from './zip'

/**
 * 存档快照（备份 / 回滚）的纯文件逻辑。
 * 这里只碰文件系统，不依赖 store / electron，方便单独跑测试。
 */

/** 快照文件名：<实例>-saves-<本地时间>.zip */
export function backupFileName(instanceId: string, date = new Date()): string {
  const stamp = date.toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  return `${instanceId}-saves-${stamp}.zip`
}

/** 把 saves 目录整包打成快照，返回文件路径；没有文件时返回 undefined */
export function createBackup(
  savesDir: string,
  backupDir: string,
  instanceId: string,
  date = new Date()
): string | undefined {
  if (!fs.existsSync(savesDir)) return undefined
  fs.mkdirSync(backupDir, { recursive: true })
  const out = path.join(backupDir, backupFileName(instanceId, date))
  const count = zipDirectory(savesDir, out)
  if (count === 0) {
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* 空包删不掉就算了 */
    }
    return undefined
  }
  return out
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
        return { file: full, name: n, bytes: stat.size, time: stat.mtimeMs }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

/** 只保留最近 keep 份（safety 那份不算在 keep 里），返回删掉的份数 */
export function pruneBackups(backupDir: string, instanceId: string, keep = 12): number {
  let removed = 0
  for (const item of listBackups(backupDir, instanceId).slice(keep)) {
    try {
      fs.rmSync(item.file, { force: true })
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
  file: string
): { restored: number; worlds: string[] } {
  const full = path.resolve(file)
  if (path.dirname(full).toLowerCase() !== path.resolve(backupDir).toLowerCase()) {
    throw new Error('只能回滚备份目录里的快照')
  }
  if (!fs.existsSync(full)) throw new Error('快照文件不在了')

  const { buf, entries } = readZipFromFile(full)
  const worlds = new Set<string>()
  let restored = 0

  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue
    // 带 .. / 绝对路径 / 盘符的条目直接丢掉（防 zip slip，别把文件写到 saves 外面）
    if (path.isAbsolute(entry.name) || entry.name.includes(':') || entry.name.split('/').some((p) => p === '..' || p === '.')) {
      continue
    }
    const parts = entry.name.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) continue
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
