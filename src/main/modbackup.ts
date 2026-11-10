import fs from 'node:fs'
import path from 'node:path'
import { collectDirFiles, readZipEntry, readZipFromFile, writeZip } from './zip'
import { adopt, unshare } from './blobstore'

/**
 * 模组目录快照（备份 / 回滚）。
 * 和存档快照一样只碰文件系统，方便单独测试。
 *
 * 两个用途：
 *  1) 更新模组前自动打一份（只含将被替换的那几个 jar），更新翻车了能一键退回；
 *  2) 用户手动「备份当前 mods」，整目录打一份，折腾坏了自己回滚。
 *
 * 每份快照旁边有个同名 .json 记元信息（是否只含部分文件），
 * 整包快照回滚时才会删掉「快照里没有的 jar」，局部快照只覆盖写回，不删东西。
 */

export interface ModsBackupMeta {
  instanceId: string
  time: number
  /** true = 只备份了部分文件（更新前自动打的那种） */
  partial: boolean
  /** 备份里的文件名 */
  files: string[]
  note?: string
}

/** 备份文件名：<实例>-mods-<本地时间>.zip；局部备份多一个 upd 标记 */
export function backupFileName(instanceId: string, date = new Date(), partial = false): string {
  const stamp = date.toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  return `${instanceId}-mods-${partial ? 'upd-' : ''}${stamp}.zip`
}

function metaPath(zipPath: string): string {
  return zipPath.replace(/\.zip$/i, '.json')
}

export function readModsBackupMeta(zipPath: string): ModsBackupMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaPath(zipPath), 'utf8')) as ModsBackupMeta
  } catch {
    return undefined
  }
}

/**
 * 打快照。
 * only 给了文件名（jar 名）就只备份这几个 —— 更新前用，体积小、快；
 * 不给就整目录打一份（store 模式，jar 本来就压过，再压没意义）。
 */
export function createModsBackup(
  modsDir: string,
  backupDir: string,
  instanceId: string,
  opts?: { only?: string[]; note?: string; date?: Date }
): string | undefined {
  if (!fs.existsSync(modsDir)) return undefined
  const all = collectDirFiles(modsDir)
  if (all.length === 0) return undefined

  const partial = !!opts?.only && opts.only.length > 0
  const wanted = partial ? new Set(opts!.only!.map((n) => n.toLowerCase())) : undefined
  const files = partial ? all.filter((f) => wanted!.has(f.name.toLowerCase())) : all
  if (files.length === 0) return undefined

  fs.mkdirSync(backupDir, { recursive: true })
  let out = path.join(backupDir, backupFileName(instanceId, opts?.date, partial))
  // 同一秒内连续备份（批量更新好几个 mod）不能互相覆盖，加个序号
  if (fs.existsSync(out) || fs.existsSync(metaPath(out))) {
    const base = out.replace(/\.zip$/i, '')
    let i = 2
    while (fs.existsSync(`${base}-${i}.zip`)) i++
    out = `${base}-${i}.zip`
  }
  const count = writeZip(out, files)
  if (count === 0) {
    try {
      fs.rmSync(out, { force: true })
    } catch {
      /* 空包删不掉就算了 */
    }
    return undefined
  }
  const meta: ModsBackupMeta = {
    instanceId,
    time: Date.now(),
    partial,
    files: files.map((f) => f.name),
    note: opts?.note
  }
  try {
    fs.writeFileSync(metaPath(out), JSON.stringify(meta, null, 2), 'utf8')
  } catch {
    /* 元信息写不上不影响回滚（只是会当成整包处理） */
  }
  return out
}

export interface ModsBackupItem {
  file: string
  name: string
  bytes: number
  time: number
  /** 里面有多少个 jar */
  count: number
  /** true = 更新前自动打的局部快照 */
  partial: boolean
}

export function listModsBackups(backupDir: string, instanceId: string): ModsBackupItem[] {
  if (!fs.existsSync(backupDir)) return []
  const prefix = `${instanceId}-mods-`
  try {
    return fs
      .readdirSync(backupDir)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.zip'))
      .map((n) => {
        const full = path.join(backupDir, n)
        const stat = fs.statSync(full)
        const meta = readModsBackupMeta(full)
        return {
          file: full,
          name: n,
          bytes: stat.size,
          time: stat.mtimeMs,
          count: meta?.files.length ?? 0,
          partial: meta?.partial ?? n.includes('-mods-upd-')
        }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

export function pruneModsBackups(backupDir: string, instanceId: string, keep = 8): number {
  let removed = 0
  for (const item of listModsBackups(backupDir, instanceId).slice(keep)) {
    try {
      fs.rmSync(item.file, { force: true })
      fs.rmSync(metaPath(item.file), { force: true })
      removed++
    } catch {
      /* 删不掉就留着 */
    }
  }
  return removed
}

/**
 * 把快照写回 mods 目录：快照里的文件覆盖写回。
 * 整包快照还会删掉「快照之后才出现的 jar」（更新时装进来的新版本），
 * 避免同一个 mod 两个版本并存；局部快照只写回，不动别的文件。
 */
export function restoreModsBackup(
  modsDir: string,
  backupDir: string,
  file: string
): { restored: number; removed: number } {
  const full = path.resolve(file)
  if (path.dirname(full).toLowerCase() !== path.resolve(backupDir).toLowerCase()) {
    throw new Error('只能回滚备份目录里的快照')
  }
  if (!fs.existsSync(full)) throw new Error('备份文件不在了')

  const { buf, entries } = readZipFromFile(full)
  const inBackup = new Set<string>()
  let restored = 0

  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue
    // 防 zip slip：绝对路径 / 盘符 / .. 一律丢掉
    if (path.isAbsolute(entry.name) || entry.name.includes(':') || entry.name.split('/').some((p) => p === '..' || p === '.')) {
      continue
    }
    const parts = entry.name.split('/').filter((p) => p.length > 0)
    if (parts.length === 0) continue
    const resolved = path.resolve(path.join(modsDir, ...parts))
    if (resolved !== path.resolve(modsDir) && !resolved.startsWith(path.resolve(modsDir) + path.sep)) continue
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    // 这个 jar 可能是指向内容仓库的硬链接：先断开，否则就地写会把别的实例那份一起改坏
    unshare(resolved)
    fs.writeFileSync(resolved, readZipEntry(buf, entry))
    adopt(resolved)
    inBackup.add(parts[parts.length - 1].toLowerCase())
    restored++
  }

  const meta = readModsBackupMeta(full)
  const partial = meta?.partial ?? file.includes('-mods-upd-')
  let removed = 0
  if (!partial && fs.existsSync(modsDir)) {
    for (const n of fs.readdirSync(modsDir)) {
      if (!n.toLowerCase().endsWith('.jar')) continue
      if (inBackup.has(n.toLowerCase())) continue
      try {
        fs.rmSync(path.join(modsDir, n), { force: true })
        removed++
      } catch {
        /* 删不掉留着，下次体检会报重复 */
      }
    }
  }

  return { restored, removed }
}
