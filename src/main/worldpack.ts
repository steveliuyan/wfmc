import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  PackEntry,
  PackProblem,
  WorldPackCheck,
  WorldPackInfo,
  WorldPackResult,
  WorldRestoreResult
} from '../shared/types'
import { gamePathFor } from './paths'
import { store } from './store'
import { collectDirFiles, listZipEntries, readZipEntry, readZipFromFile, writeZipCompressed } from './zip'

/** 清单固定放在 zip 根目录 */
export const PACK_MANIFEST = 'wfmc-worldpack.json'
/** 存档文件在 zip 里的前缀，跟清单分开，免得撞名 */
export const PACK_PREFIX = 'world/'
export const PACK_FORMAT = 1
export const PACK_EXT = '.wfmcworld.zip'

/** 单个包超过这个大小就不在内存里解了 */
const MAX_PACK_BYTES = 1536 * 1024 * 1024

export interface PackProgress {
  phase: string
  current: number
  total: number
}

function sha1Of(buf: Buffer): string {
  return crypto.createHash('sha1').update(buf).digest('hex')
}

function sha1OfFile(file: string): string {
  return sha1Of(fs.readFileSync(file))
}

function fmtMB(n: number): string {
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function savesDirOf(instanceId: string): { mcVersion: string; dir: string } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  return { mcVersion: instance.mcVersion, dir: path.join(gamePathFor(instance), 'saves') }
}

/** 全部条目排序后再算一个总指纹：包整体有没有被动过，看这一个值就够 */
export function digestOf(entries: PackEntry[]): string {
  const text = entries
    .slice()
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((e) => `${e.path}|${e.size}|${e.sha1}`)
    .join('\n')
  return sha1Of(Buffer.from(text, 'utf8'))
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** 存档名可能带路径分隔符或非法字符，恢复时统一洗一遍 */
function safeWorldName(name: string): string {
  return (name || 'world').replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'world'
}

/**
 * 打包一个存档目录 → 一个带校验清单的 zip。
 * 清单里逐文件记 size + sha1，另外算一个总 digest，恢复时按它比对。
 */
export function packWorld(
  instanceId: string,
  world: string,
  outPath: string,
  onProgress?: (p: PackProgress) => void
): WorldPackResult {
  const { mcVersion, dir } = savesDirOf(instanceId)
  const src = path.join(dir, world)
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`找不到存档：${world}`)

  const files = collectDirFiles(src)
  if (files.length === 0) throw new Error('这个存档目录是空的')

  const entries: PackEntry[] = []
  let bytes = 0
  files.forEach((f, i) => {
    const sha1 = sha1OfFile(f.full)
    entries.push({ path: f.name, size: f.size, sha1 })
    bytes += f.size
    if (i % 25 === 0) onProgress?.({ phase: `读取并校验 ${f.name}`, current: i + 1, total: files.length })
  })

  const info: WorldPackInfo = {
    format: PACK_FORMAT,
    app: 'WFMC',
    name: world,
    mcVersion,
    createdAt: Date.now(),
    fileCount: entries.length,
    bytes,
    digest: digestOf(entries)
  }

  // 清单先落到临时文件，一起写进 zip 根目录
  const tmp = path.join(store.backupsDir, `.${Date.now()}-${PACK_MANIFEST}`)
  fs.mkdirSync(store.backupsDir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ ...info, entries }), 'utf8')

  try {
    const items = [
      { name: PACK_MANIFEST, full: tmp },
      ...files.map((f) => ({ name: PACK_PREFIX + f.name, full: f.full }))
    ]
    writeZipCompressed(outPath, items, (name, done, total) => {
      if (done % 25 === 0 || done === total) onProgress?.({ phase: `打包 ${name}`, current: done, total })
    })
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }

  return { path: outPath, info, zipBytes: fs.statSync(outPath).size }
}

interface ParsedPack {
  buf: Buffer
  /** zip 内路径 → 解出来的内容 */
  data: Map<string, Buffer>
  manifest?: { info: WorldPackInfo; entries: PackEntry[] }
  check: WorldPackCheck
}

/** 读包 + 按清单逐文件比对，报告不写盘 */
function parsePack(zipPath: string): ParsedPack {
  const size = fs.statSync(zipPath).size
  if (size > MAX_PACK_BYTES) {
    throw new Error(`这个包有 ${fmtMB(size)}，太大了，先在解压软件里解开再放进 saves`)
  }

  const { buf, entries } = readZipFromFile(zipPath)
  const data = new Map<string, Buffer>()
  for (const e of entries) {
    if (e.isDirectory) continue
    data.set(e.name, readZipEntry(buf, e))
  }

  const problems: PackProblem[] = []
  const manifestBuf = data.get(PACK_MANIFEST)
  if (!manifestBuf) {
    // 老版本「备份所有存档」生成的普通 zip：没有清单，只能按普通压缩包处理
    const plain = [...data.keys()].filter((n) => !n.startsWith(PACK_PREFIX))
    return {
      buf,
      data,
      check: {
        ok: true,
        signed: false,
        checked: data.size,
        problems: plain.length
          ? [{ path: plain[0], kind: 'unsafe', detail: '包里没有 WFMC 校验清单，无法逐文件核对' }]
          : []
      }
    }
  }

  let parsed: { info: WorldPackInfo; entries: PackEntry[] }
  try {
    parsed = JSON.parse(manifestBuf.toString('utf8')) as { info: WorldPackInfo; entries: PackEntry[] }
  } catch {
    return {
      buf,
      data,
      check: {
        ok: false,
        signed: false,
        checked: 0,
        problems: [{ path: PACK_MANIFEST, kind: 'sha1', detail: '清单文件坏了（不是合法 JSON）' }]
      }
    }
  }
  const info = { ...(parsed as unknown as WorldPackInfo) }
  const list: PackEntry[] = Array.isArray((parsed as unknown as { entries?: PackEntry[] }).entries)
    ? ((parsed as unknown as { entries: PackEntry[] }).entries ?? [])
    : []
  // JSON 里 info 与 entries 平级，取回来时把 entries 从 info 上剥掉
  delete (info as unknown as { entries?: unknown }).entries

  if (info.format !== PACK_FORMAT) {
    problems.push({
      path: PACK_MANIFEST,
      kind: 'unsafe',
      detail: `清单格式是 ${info.format}，这个版本只认 ${PACK_FORMAT}`
    })
  }
  if (info.digest && info.digest !== digestOf(list)) {
    problems.push({ path: PACK_MANIFEST, kind: 'sha1', detail: '总指纹对不上，包被改过或没写完' })
  }

  let checked = 0
  for (const item of list) {
    if (item.path.includes('..') || path.isAbsolute(item.path)) {
      problems.push({ path: item.path, kind: 'unsafe', detail: '路径越界，已拒绝' })
      continue
    }
    const raw = data.get(PACK_PREFIX + item.path)
    if (!raw) {
      problems.push({ path: item.path, kind: 'missing' })
      continue
    }
    if (raw.length !== item.size) {
      problems.push({ path: item.path, kind: 'size', detail: `${raw.length} ≠ ${item.size}` })
      continue
    }
    const got = sha1Of(raw)
    if (got !== item.sha1) {
      problems.push({ path: item.path, kind: 'sha1', detail: `${got.slice(0, 8)} ≠ ${item.sha1.slice(0, 8)}` })
      continue
    }
    checked++
  }

  return {
    buf,
    data,
    manifest: { info, entries: list },
    check: { ok: problems.length === 0, signed: true, info, checked, problems }
  }
}

/** 只校验，不写盘 */
export function inspectWorldPack(zipPath: string): WorldPackCheck {
  if (!fs.existsSync(zipPath)) throw new Error('找不到这个文件')
  return parsePack(zipPath).check
}

/**
 * 恢复存档到实例的 saves 目录。
 * 先逐文件核对 sha1：只要有一个对不上就整个不动，绝不写半个存档进去。
 */
export function restoreWorldPack(
  instanceId: string,
  zipPath: string,
  onProgress?: (p: PackProgress) => void
): WorldRestoreResult {
  const { dir } = savesDirOf(instanceId)
  const pack = parsePack(zipPath)
  const { check } = pack

  if (!check.ok) {
    const head = check.problems
      .slice(0, 5)
      .map((p) => `${p.path}（${p.kind}${p.detail ? ' ' + p.detail : ''}）`)
      .join('；')
    const more = check.problems.length > 5 ? ` 等 ${check.problems.length} 个问题` : ''
    throw new Error(`校验没通过，一个文件都没动：${head}${more}`)
  }

  const baseName = safeWorldName(
    check.info?.name ?? path.basename(zipPath).replace(/\.wfmcworld\.zip$|\.zip$/i, '')
  )
  let name = baseName
  let renamed = false
  if (fs.existsSync(path.join(dir, name))) {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    name = `${baseName} (恢复 ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())})`
    renamed = true
  }
  const dest = path.join(dir, name)

  const items: [string, Buffer][] = []
  if (check.info) {
    const missing = (check.info.fileCount ?? 0) - (pack.manifest?.entries.length ?? 0)
    if (missing !== 0) throw new Error('清单里的文件数和条目数对不上，包可能被截断')
    for (const item of pack.manifest?.entries ?? []) {
      const raw = pack.data.get(PACK_PREFIX + item.path)
      if (!raw) throw new Error(`包里缺 ${item.path}`)
      items.push([item.path, raw])
    }
  } else {
    // 没有清单的老包：把 world/ 下的都算上，没有前缀就整包当存档
    for (const [n, raw] of pack.data) {
      if (n === PACK_MANIFEST) continue
      items.push([n.startsWith(PACK_PREFIX) ? n.slice(PACK_PREFIX.length) : n, raw])
    }
  }

  if (items.length === 0) throw new Error('包里没有可恢复的文件')

  fs.mkdirSync(dest, { recursive: true })
  let bytes = 0
  items.forEach(([rel, raw], i) => {
    const target = path.join(dest, ...rel.split('/'))
    const safe = path.resolve(target).startsWith(path.resolve(dest) + path.sep)
    if (!safe) throw new Error(`包里有个路径不合法：${rel}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, raw)
    bytes += raw.length
    if (i % 25 === 0) onProgress?.({ phase: `写入 ${rel}`, current: i + 1, total: items.length })
  })

  // 存档里记录的游戏版本跟实例不一致时，只在结果里说明，不改包内容
  return {
    dir: dest,
    name,
    fileCount: items.length,
    bytes,
    renamed,
    check
  }
}
