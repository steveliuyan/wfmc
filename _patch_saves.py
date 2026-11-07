# -*- coding: utf-8 -*-
"""一次性补丁：存档备份带「装了哪些存档」+ 打开文件夹；云备份本地 5 份；设置合并云账号。"""
import io, sys, os

ROOT = r"H:\mcqidongqi"

def read(p):
    with io.open(os.path.join(ROOT, p), "r", encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with io.open(os.path.join(ROOT, p), "w", encoding="utf-8", newline="\n") as f:
        f.write(s)

def sub(text, old, new, path=""):
    n = text.count(old)
    if n != 1:
        raise SystemExit("!! %s: 期望 1 处，实际 %d 处：\n%s" % (path, n, old[:160]))
    return text.replace(old, new)

# ---------------------------------------------------------------- savebackup.ts
SAVEBACKUP = r'''import fs from 'node:fs'
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

/** 备份结果：文件路径 + 里面装了哪几个存档 + 文件数 + 体积 */
export interface SavesBackupResult {
  file: string
  /** 打进去的存档目录名（saves 下一级目录） */
  worlds: string[]
  /** 打包的文件数 */
  files: number
  /** zip 体积（字节） */
  bytes: number
  /** 属于哪个实例（游戏版本 / 整合包） */
  instanceId: string
  instanceName?: string
  mcVersion?: string
}

/** 快照旁边的小说明（.zip.json）：记下装了什么，列表不解压就能显示 */
interface BackupMeta {
  worlds: string[]
  files: number
  instanceId: string
  instanceName?: string
  mcVersion?: string
  createdAt: number
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
  extra: { instanceName?: string; mcVersion?: string } = {}
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
    createdAt: date.getTime()
  }
  try {
    fs.writeFileSync(metaFile(out), JSON.stringify(meta, null, 2), 'utf-8')
  } catch {
    /* 说明文件写不进去也不影响快照本身 */
  }
  return { file: out, worlds, files, bytes, instanceId, instanceName: extra.instanceName, mcVersion: extra.mcVersion }
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
          mcVersion: meta?.mcVersion
        }
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
'''
write("src/main/savebackup.ts", SAVEBACKUP)

# ---------------------------------------------------------------- shared/types.ts
t = read("src/shared/types.ts")
t = sub(t, """export interface SaveBackup {
  /** 绝对路径 */
  file: string
  /** 文件名（带时间戳） */
  name: string
  bytes: number
  time: number
}""", """export interface SaveBackup {
  /** 绝对路径 */
  file: string
  /** 文件名（带时间戳） */
  name: string
  bytes: number
  time: number
  /** 这份快照里装了几个存档（世界目录名）；老快照没有这项 */
  worlds?: string[]
  /** 打包的文件数 */
  files?: number
  /** 属于哪个实例 */
  instanceName?: string
  mcVersion?: string
}""", "types.ts SaveBackup")
t = sub(t, """  limits?: { autoKeep: number; manualKeep: number }""", """  limits?: { autoKeep: number; manualKeep: number }
  /** 本地保留份数（客户端固定值，跟服务端无关） */
  localKeep?: number""", "types.ts CloudStatus")
write("src/shared/types.ts", t)

# ---------------------------------------------------------------- content.ts
t = read("src/main/content.ts")
t = sub(t, """/** 备份存档目录成 zip，返回备份文件路径 */
export function backupSaves(instanceId: string): string | undefined {
  const root = instanceRoot(instanceId)
  return createBackup(path.join(root, 'saves'), store.backupsDir, instanceId)
}""", """/**
 * 备份存档目录成 zip。
 * 返回的不只是路径 —— 还带上「装了哪几个存档」，界面上要显示出来，
 * 免得用户打完包不知道里面到底有什么。
 */
export function backupSaves(instanceId: string): SavesBackupResult | undefined {
  const root = instanceRoot(instanceId)
  const inst = store.getInstance(instanceId)
  return createBackup(path.join(root, 'saves'), store.backupsDir, instanceId, new Date(), {
    instanceName: inst?.name,
    mcVersion: inst?.mcVersion
  })
}

/** 备份目录（存档快照都放这儿），打开文件夹用 */
export function savesBackupDir(): string {
  return store.backupsDir
}""", "content.ts backupSaves")
t = sub(t, """  const safetyBackup = backupSaves(instanceId)""", """  const safetyBackup = backupSaves(instanceId)?.file""", "content.ts safetyBackup")
t = sub(t, """import { createBackup, listBackups, pruneBackups, restoreBackup } from './savebackup'""",
"""import { createBackup, listBackups, pruneBackups, restoreBackup, type SavesBackupResult } from './savebackup'""",
"content.ts import")
write("src/main/content.ts", t)

# ---------------------------------------------------------------- launch.ts
t = read("src/main/launch.ts")
t = sub(t, """        const file = backupSaves(instance.id)
        if (file) {
          pruneSaveBackups(instance.id)
          onLog(instance.id, `[WFMC] 启动前已备份存档：${path.basename(file)}`)
        }""", """        const bk = backupSaves(instance.id)
        if (bk) {
          pruneSaveBackups(instance.id)
          onLog(
            instance.id,
            `[WFMC] 启动前已备份存档：${path.basename(bk.file)}（${bk.worlds.length} 个世界 / ${bk.files} 个文件）`
          )
        }""", "launch.ts backup")
write("src/main/launch.ts", t)

# ---------------------------------------------------------------- cloudsync.ts
t = read("src/main/cloudsync.ts")
t = sub(t, """    const local = await listLocalBackups()
    status.localBackups = local""", """    const local = await listLocalBackups()
    status.localBackups = local
    // 本地保留份数是客户端自己定的（LOCAL_KEEP），跟服务端的云端保留份数无关
    status.localKeep = LOCAL_KEEP""", "cloudsync status localKeep")
write("src/main/cloudsync.ts", t)

print("patch A ok")
