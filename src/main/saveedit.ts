/**
 * E 方向：存档工坊
 *
 * 只做「定点的、可解释的」修改：白名单字段 + 强制快照 + 改完再读一遍校验。
 * 不碰区块数据（那是另一种风险量级），区块只统计、只展示。
 *
 * 铁律：
 *  1. 动 level.dat 之前先把原文件整份复制到 backups/levels/<实例>/，并把 sha1 一起记下来。
 *  2. 白名单之外的字段一律不写（存档里的未知字段可能是新版本加的，写坏就要重开档）。
 *  3. 写完立刻按字节往返校验：能读懂、字段值等于期望值，才算成功；否则从快照还原。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { store } from './store'
import { gamePathFor } from './paths'
import { getPath, readNbtFile, setPath, tagByte, tagNumber, tagString, toPlain, writeNbtFile } from './nbt'
import type { NbtCompound } from './nbt'

/** 白名单字段：UI 上能改的就这些，别的一概不碰 */
export const LEVEL_FIELDS = [
  'Data.LevelName',
  'Data.GameType',
  'Data.Difficulty',
  'Data.hardcore',
  'Data.allowCommands',
  'Data.DayTime',
  'Data.Time'
] as const

export type LevelField = (typeof LEVEL_FIELDS)[number]

export type { LevelPatch, PatchResult, SaveInspect, SaveLevelInfo, SaveRegion, SaveWorld } from '../shared/types'
import type { LevelPatch, PatchResult, SaveInspect, SaveLevelInfo, SaveRegion, SaveWorld } from '../shared/types'

function savesDirOf(instanceId: string): string {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  return path.join(gamePathFor(instance), 'saves')
}

function worldDirOf(instanceId: string, folder: string): string {
  const safe = path.basename(folder)
  const dir = path.join(savesDirOf(instanceId), safe)
  if (!fs.existsSync(dir)) throw new Error(`存档不存在：${safe}`)
  return dir
}

function dirBytes(dir: string): { bytes: number; files: number; mtime: number } {
  let bytes = 0
  let files = 0
  let mtime = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(full)
      } else {
        try {
          const st = fs.statSync(full)
          bytes += st.size
          files += 1
          if (st.mtimeMs > mtime) mtime = st.mtimeMs
        } catch {
          /* 读不到就跳过 */
        }
      }
    }
  }
  walk(dir)
  return { bytes, files, mtime }
}

function sha1Of(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

/** 列表：这个实例下所有存档（读 level.dat 拿真名） */
export function listSaves(instanceId: string): SaveWorld[] {
  const savesDir = savesDirOf(instanceId)
  if (!fs.existsSync(savesDir)) return []
  const out: SaveWorld[] = []
  for (const entry of fs.readdirSync(savesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(savesDir, entry.name)
    const levelFile = path.join(dir, 'level.dat')
    let name = entry.name
    let hasLevel = false
    if (fs.existsSync(levelFile)) {
      hasLevel = true
      try {
        const nbt = readNbtFile(levelFile)
        const tag = getPath(nbt.root, 'Data.LevelName')
        if (tag && tag.t === 8 && tag.v) name = tag.v
      } catch {
        /* 读不了就用文件夹名 */
      }
    }
    const stat = fs.statSync(dir)
    const agg = dirBytes(dir)
    out.push({
      folder: entry.name,
      name,
      bytes: agg.bytes,
      files: agg.files,
      mtime: agg.mtime || stat.mtimeMs,
      hasLevel
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function readLevelInfo(root: NbtCompound): SaveLevelInfo {
  const num = (p: string): number | undefined => {
    const t = getPath(root, p)
    if (!t) return undefined
    if (t.t === 4) return Number(t.v)
    if (t.t === 1 || t.t === 2 || t.t === 3 || t.t === 5 || t.t === 6) return t.v as number
    return undefined
  }
  const str = (p: string): string | undefined => {
    const t = getPath(root, p)
    return t && t.t === 8 ? t.v : undefined
  }
  const flag = (p: string): boolean | undefined => {
    const n = num(p)
    return n === undefined ? undefined : n !== 0
  }
  const sx = num('Data.SpawnX')
  const sy = num('Data.SpawnY')
  const sz = num('Data.SpawnZ')
  const last = num('Data.LastPlayed')
  return {
    levelName: str('Data.LevelName'),
    gameType: num('Data.GameType'),
    difficulty: num('Data.Difficulty'),
    hardcore: flag('Data.hardcore'),
    allowCommands: flag('Data.allowCommands'),
    dayTime: num('Data.DayTime')?.toString(),
    time: num('Data.Time')?.toString(),
    versionName: str('Data.Version.Name'),
    dataVersion: num('Data.DataVersion'),
    spawn: sx !== undefined && sy !== undefined && sz !== undefined ? { x: sx, y: sy, z: sz } : undefined,
    lastPlayed: last !== undefined ? new Date(last).toISOString() : undefined
  }
}

function scanRegions(dir: string): SaveRegion[] {
  const regionDir = path.join(dir, 'region')
  if (!fs.existsSync(regionDir)) return []
  const out: SaveRegion[] = []
  for (const name of fs.readdirSync(regionDir)) {
    if (!name.endsWith('.mca')) continue
    const full = path.join(regionDir, name)
    let chunks = 0
    let bytes = 0
    let mtime = 0
    try {
      const st = fs.statSync(full)
      bytes = st.size
      mtime = st.mtimeMs
      // 表头 4096 字节 = 1024 个 4 字节项，前 3 字节是扇区偏移，为 0 表示该位置没区块
      const head = Buffer.alloc(4096)
      const fd = fs.openSync(full, 'r')
      try {
        fs.readSync(fd, head, 0, 4096, 0)
      } finally {
        fs.closeSync(fd)
      }
      for (let i = 0; i < 1024; i++) {
        if (head.readUIntBE(i * 4, 3) !== 0) chunks += 1
      }
    } catch {
      /* 坏文件也列出来，只是统计为 0 */
    }
    out.push({ name, bytes, mtime, chunks })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** 看一个存档：世界信息 + 区块统计 */
export function inspectSave(instanceId: string, folder: string): SaveInspect {
  const dir = worldDirOf(instanceId, folder)
  const levelFile = path.join(dir, 'level.dat')
  const agg = dirBytes(dir)
  const world: SaveWorld = {
    folder: path.basename(dir),
    name: path.basename(dir),
    bytes: agg.bytes,
    files: agg.files,
    mtime: agg.mtime,
    hasLevel: fs.existsSync(levelFile)
  }
  const result: SaveInspect = { world, regions: scanRegions(dir), editable: [] }
  if (!fs.existsSync(levelFile)) return result
  const raw = fs.statSync(levelFile)
  let nbt
  try {
    nbt = readNbtFile(levelFile)
  } catch (e) {
    throw new Error(`level.dat 读不了：${(e as Error).message}`)
  }
  result.level = readLevelInfo(nbt.root)
  if (result.level.levelName) world.name = result.level.levelName
  result.raw = { bytes: raw.size, compression: nbt.compression, sha1: sha1Of(levelFile) }
  result.editable = LEVEL_FIELDS.filter((f) => getPath(nbt.root, f) !== undefined)
  return result
}

/** 强制快照：把 level.dat 原样复制一份，返回快照路径 */
export function snapshotLevel(instanceId: string, folder: string): string {
  const dir = worldDirOf(instanceId, folder)
  const levelFile = path.join(dir, 'level.dat')
  if (!fs.existsSync(levelFile)) throw new Error('这个存档没有 level.dat，不动它')
  const out = path.join(store.dataDir, 'backups', 'levels', instanceId)
  fs.mkdirSync(out, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const dest = path.join(out, `${folder}-${stamp}.dat`)
  fs.copyFileSync(levelFile, dest)
  return dest
}

/** 定点改白名单字段：快照 → 写 → 复读校验，失败自动还原 */
export function patchLevel(instanceId: string, folder: string, patch: LevelPatch): PatchResult {
  const dir = worldDirOf(instanceId, folder)
  const levelFile = path.join(dir, 'level.dat')
  if (!fs.existsSync(levelFile)) throw new Error('这个存档没有 level.dat，不动它')

  const nbt = readNbtFile(levelFile)
  const before: Record<string, unknown> = {}
  for (const f of LEVEL_FIELDS) {
    const t = getPath(nbt.root, f)
    if (t) before[f] = toPlain(t)
  }

  const plan: { field: LevelField; tag: ReturnType<typeof tagString> }[] = []
  const skipped: PatchResult['skipped'] = []
  const consider = (field: LevelField, value: unknown, make: () => ReturnType<typeof tagString>) => {
    if (value === undefined) return
    if (getPath(nbt.root, field) === undefined) {
      skipped.push({ field, reason: '存档里没有这个字段（不新造字段）' })
      return
    }
    plan.push({ field, tag: make() })
  }

  consider('Data.LevelName', patch.levelName, () => tagString(String(patch.levelName)))
  consider('Data.GameType', patch.gameType, () => tagNumber(Number(patch.gameType), 3))
  consider('Data.Difficulty', patch.difficulty, () => tagByte(Number(patch.difficulty)))
  consider('Data.hardcore', patch.hardcore, () => tagByte(!!patch.hardcore))
  consider('Data.allowCommands', patch.allowCommands, () => tagByte(!!patch.allowCommands))
  consider('Data.DayTime', patch.dayTime, () => tagNumber(Number(patch.dayTime), 4))
  consider('Data.Time', patch.time, () => tagNumber(Number(patch.time), 4))

  if (!plan.length) {
    return { changed: [], skipped, backup: '', before, after: before }
  }

  const backup = snapshotLevel(instanceId, folder)
  const changed: LevelField[] = []
  for (const step of plan) {
    if (setPath(nbt.root, step.field, step.tag)) changed.push(step.field)
    else skipped.push({ field: step.field, reason: '路径写不进去（结构不认识）' })
  }

  try {
    writeNbtFile(levelFile, nbt)
    // 复读校验：读得回来、值对得上才算成功
    const check = readNbtFile(levelFile)
    for (const step of plan) {
      const t = getPath(check.root, step.field)
      if (!t || JSON.stringify(toPlain(t)) !== JSON.stringify(toPlain(step.tag))) {
        throw new Error(`写回后校验失败：${step.field}`)
      }
    }
  } catch (e) {
    fs.copyFileSync(backup, levelFile)
    throw new Error(`改存档失败，已从快照还原：${(e as Error).message}`)
  }

  const after: Record<string, unknown> = {}
  const reread = readNbtFile(levelFile)
  for (const f of LEVEL_FIELDS) {
    const t = getPath(reread.root, f)
    if (t) after[f] = toPlain(t)
  }
  return { changed, skipped, backup, before, after }
}
