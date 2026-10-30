import fs from 'node:fs'
import path from 'node:path'
import type { ContentItem, ContentKind, CrashReport, Instance, ModMeta } from '../shared/types'
import { store } from './store'
import {
  zipDirectory,
  listZipEntries,
  readZipEntry,
  readZipFromFile,
  writeZip,
  collectDirFiles
} from './zip'
import { gamePathFor } from './paths'
import { disableResourcePack } from './options'

/** 内容所在的游戏数据目录（受「版本隔离」影响） */
function instanceRoot(instanceId: string) {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  return gamePathFor(instance)
}

/** 保证操作路径在实例游戏目录内（防越界删除） */
function assertInside(root: string, target: string) {
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (t !== r && !t.startsWith(r + path.sep)) throw new Error('路径不在实例目录内')
  return t
}

function readFolder(dir: string): ContentItem[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => {
        const full = path.join(dir, d.name)
        const stat = fs.statSync(full)
        return {
          name: d.name,
          size: stat.isDirectory() ? 0 : stat.size,
          mtime: stat.mtimeMs,
          path: full,
          isDir: d.isDirectory(),
          disabled: d.name.endsWith('.disabled')
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * jar / zip 元数据：把每个模组的名字、简介、图标读出来（内容管理里显示缩略图）
 * ------------------------------------------------------------------ */

const metaCache = new Map<string, ModMeta>()

function iconCacheDir(): string {
  const dir = path.join(store.dataDir, 'cache', 'icons')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function saveIcon(name: string, data: Buffer): string | undefined {
  try {
    if (data.length < 32 || data.length > 2_000_000) return undefined
    const ext = data[0] === 0x89 && data[1] === 0x50 ? 'png' : data[0] === 0xff ? 'jpg' : 'png'
    const file = path.join(iconCacheDir(), `${name}.${ext}`)
    fs.writeFileSync(file, data)
    return file
  } catch {
    return undefined
  }
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80)
}

/** 从 jar 里读 fabric.mod.json / mods.toml / quilt.mod.json */
function readJarMeta(jarPath: string, stamp: string): ModMeta {
  const key = `${jarPath}|${stamp}`
  const cached = metaCache.get(key)
  if (cached) return cached
  const meta: ModMeta = {}
  let buf: Buffer
  let entries: { name: string; isDirectory: boolean }[]
  try {
    const z = readZipFromFile(jarPath)
    buf = z.buf
    entries = z.entries
  } catch {
    metaCache.set(key, meta)
    return meta
  }

  const readText = (fileName: string): string | undefined => {
    const entry = entries.find((e) => e.name.toLowerCase() === fileName.toLowerCase())
    if (!entry) return undefined
    try {
      return readZipEntry(buf, entry as never).toString('utf-8')
    } catch {
      return undefined
    }
  }
  const readBinary = (fileName: string): Buffer | undefined => {
    const entry = entries.find((e) => e.name.toLowerCase() === fileName.toLowerCase())
    if (!entry) return undefined
    try {
      return readZipEntry(buf, entry as never)
    } catch {
      return undefined
    }
  }

  // Fabric / Quilt
  const fabricRaw = readText('fabric.mod.json') ?? readText('quilt.mod.json')
  if (fabricRaw) {
    try {
      const j = JSON.parse(fabricRaw) as {
        id?: string
        name?: string
        version?: string
        description?: string
        icon?: string | Record<string, string>
        quilt_loader?: { metadata?: { name?: string; description?: string; icon?: string } }
      }
      const md = j.quilt_loader?.metadata
      meta.title = j.name ?? md?.name ?? j.id
      meta.description = (j.description ?? md?.description ?? '').toString()
      meta.version = j.version
      meta.loader = 'fabric'
      const iconField = j.icon ?? md?.icon
      const rel = typeof iconField === 'string' ? iconField : iconField ? Object.values(iconField)[0] : undefined
      const icon =
        (rel ? readBinary(rel.replace(/^\//, '')) : undefined) ??
        readBinary('icon.png') ??
        (j.id ? readBinary(`assets/${j.id}/icon.png`) : undefined)
      if (icon) meta.iconPath = saveIcon(safeName(`${path.basename(jarPath)}-${stamp}`), icon)
      metaCache.set(key, meta)
      return meta
    } catch {
      /* 元数据坏了就当没有 */
    }
  }

  // Forge / NeoForge: META-INF/mods.toml 或 META-INF/neoforge.mods.toml
  const toml = readText('META-INF/neoforge.mods.toml') ?? readText('META-INF/mods.toml')
  if (toml) {
    const grab = (field: string) => {
      const m = toml.match(new RegExp(`^\\s*${field}\\s*=\\s*["']([^"']*)["']`, 'm'))
      return m?.[1]
    }
    meta.title = grab('displayName') ?? grab('modId')
    meta.description = grab('description')
    meta.version = grab('version')
    meta.loader = readText('META-INF/neoforge.mods.toml') ? 'neoforge' : 'forge'
    const logo = grab('logoFile')
    const icon =
      (logo ? readBinary(logo.replace(/^\//, '')) : undefined) ??
      readBinary('icon.png') ??
      readBinary('logo.png')
    if (icon) meta.iconPath = saveIcon(safeName(`${path.basename(jarPath)}-${stamp}`), icon)
    metaCache.set(key, meta)
    return meta
  }

  // 资源包 / 光影：pack.mcmeta + pack.png
  const mcmeta = readText('pack.mcmeta')
  if (mcmeta) {
    try {
      const j = JSON.parse(mcmeta) as { pack?: { description?: unknown; pack_format?: number } }
      const d = j.pack?.description
      meta.description =
        typeof d === 'string'
          ? d
          : d && typeof d === 'object' && 'text' in (d as Record<string, unknown>)
            ? String((d as { text?: string }).text ?? '')
            : ''
      meta.version = j.pack?.pack_format ? `pack_format ${j.pack.pack_format}` : undefined
    } catch {
      /* 忽略 */
    }
    const png = readBinary('pack.png')
    if (png) meta.iconPath = saveIcon(safeName(`${path.basename(jarPath)}-${stamp}`), png)
  }

  metaCache.set(key, meta)
  return meta
}

/** 列表里补上模组元数据（名字 / 简介 / 图标），读不到就保持原样 */
function enrich(items: ContentItem[]): ContentItem[] {
  for (const item of items) {
    if (item.isDir) continue
    // 注意：被禁用的文件是 xxx.jar.disabled，一样要读元数据，不然一禁用缩略图就没了
    if (!/\.(jar|zip)(\.disabled)?$/i.test(item.name)) continue
    const meta = readJarMeta(item.path, `${Math.round(item.mtime)}|${item.name.endsWith('.disabled') ? 'd' : 'e'}`)
    Object.assign(item, meta)
  }
  return items
}

/** 列出实例里的模组 / 资源包 / 光影 / 存档 */
export function listContent(instanceId: string, kind: ContentKind): ContentItem[] {
  const root = instanceRoot(instanceId)
  return enrich(readFolder(path.join(root, kind)))
}

/** 启用 / 禁用（改后缀 .disabled） */
export function toggleContent(instanceId: string, target: string): ContentItem[] {
  const root = instanceRoot(instanceId)
  const full = assertInside(root, target)
  if (full.endsWith('.disabled')) {
    fs.renameSync(full, full.slice(0, -'.disabled'.length))
  } else {
    fs.renameSync(full, `${full}.disabled`)
  }
  const kind = path.basename(path.dirname(full)) as ContentKind
  return listContent(instanceId, kind)
}

/** 删除单个文件/存档目录 */
export function deleteContent(instanceId: string, target: string) {
  const root = instanceRoot(instanceId)
  const full = assertInside(root, target)
  // 删资源包时把 options.txt 里的 file/xxx.zip 一起摘掉
  if (path.basename(path.dirname(full)) === 'resourcepacks' && /\.zip$/i.test(full)) {
    try {
      disableResourcePack(root, path.basename(full))
    } catch {
      /* options.txt 动不了就别拦着删 */
    }
  }
  fs.rmSync(full, { recursive: true, force: true })
}

/** 从本地文件导入（模组/资源包/光影直接丢进对应目录） */
export function importContent(instanceId: string, kind: ContentKind, files: string[]): ContentItem[] {
  const root = instanceRoot(instanceId)
  const dir = path.join(root, kind)
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    fs.cpSync(file, path.join(dir, path.basename(file)), { recursive: true })
  }
  return listContent(instanceId, kind)
}

/** 打开某个内容目录 */
export function contentDir(instanceId: string, kind: ContentKind): string {
  const dir = path.join(instanceRoot(instanceId), kind)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 备份存档目录成 zip，返回备份文件路径 */
export function backupSaves(instanceId: string): string | undefined {
  const root = instanceRoot(instanceId)
  const savesDir = path.join(root, 'saves')
  if (!fs.existsSync(savesDir)) return undefined
  const stamp = new Date()
    .toLocaleString('zh-CN', { hour12: false })
    .replace(/[/:\s]/g, '-')
  const out = path.join(store.backupsDir, `${instanceId}-saves-${stamp}.zip`)
  const count = zipDirectory(savesDir, out)
  return count > 0 ? out : undefined
}

/** 崩溃报告列表 */
export function listCrashReports(instanceId: string): CrashReport[] {
  const root = instanceRoot(instanceId)
  const dir = path.join(root, 'crash-reports')
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.txt') || n.endsWith('.log'))
      .map((n) => {
        const full = path.join(dir, n)
        const stat = fs.statSync(full)
        return { name: n, path: full, time: stat.mtimeMs, size: stat.size }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

/** 读崩溃报告正文（截断到 200KB，避免刷爆界面） */
export function readCrashReport(instanceId: string, target: string): string {
  const root = instanceRoot(instanceId)
  const full = assertInside(root, target)
  const buf = fs.readFileSync(full)
  return buf.slice(Math.max(0, buf.length - 200_000)).toString('utf-8')
}

/* ------------------------------------------------------------------ *
 * 数据包（存档级 datapacks）
 * ------------------------------------------------------------------ */

export function listWorlds(instanceId: string): string[] {
  const dir = path.join(instanceRoot(instanceId), 'saves')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

export function listDatapacks(instanceId: string, world: string): ContentItem[] {
  const dir = path.join(instanceRoot(instanceId), 'saves', world, 'datapacks')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() || d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name)
      const stat = fs.statSync(full)
      return {
        name: d.name,
        path: full,
        size: d.isDirectory() ? 0 : stat.size,
        mtime: stat.mtimeMs,
        isDir: d.isDirectory(),
        disabled: d.name.endsWith('.disabled')
      }
    })
}

export function importDatapack(instanceId: string, world: string, files: string[]): ContentItem[] {
  const dir = path.join(instanceRoot(instanceId), 'saves', world, 'datapacks')
  fs.mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const dest = path.join(dir, path.basename(file))
    fs.copyFileSync(file, dest)
  }
  return listDatapacks(instanceId, world)
}

export function toggleDatapack(instanceId: string, world: string, name: string): ContentItem[] {
  const dir = path.join(instanceRoot(instanceId), 'saves', world, 'datapacks')
  const full = path.join(dir, name)
  if (!fs.existsSync(full)) return listDatapacks(instanceId, world)
  if (name.endsWith('.disabled')) fs.renameSync(full, path.join(dir, name.replace(/\.disabled$/, '')))
  else fs.renameSync(full, path.join(dir, `${name}.disabled`))
  return listDatapacks(instanceId, world)
}

export function deleteDatapack(instanceId: string, world: string, name: string): ContentItem[] {
  const dir = path.join(instanceRoot(instanceId), 'saves', world, 'datapacks')
  const full = path.join(dir, name)
  if (full.startsWith(dir + path.sep)) fs.rmSync(full, { recursive: true, force: true })
  return listDatapacks(instanceId, world)
}

/* ------------------------------------------------------------------ *
 * 资源包顺序（写 options.txt 里的 resourcePacks=["file/a.zip",...]）
 * ------------------------------------------------------------------ */

export function readResourcePackOrder(instanceId: string): string[] {
  const root = instanceRoot(instanceId)
  const file = path.join(root, 'options.txt')
  if (!fs.existsSync(file)) return []
  const line = fs
    .readFileSync(file, 'utf-8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('resourcePacks:'))
  if (!line) return []
  const raw = line.slice('resourcePacks:'.length)
  try {
    const arr = JSON.parse(raw) as string[]
    return arr.filter((x) => x.startsWith('file/'))
  } catch {
    return []
  }
}

/** dir = -1 上移（优先加载），1 下移 */
export function moveResourcePack(instanceId: string, name: string, dir: -1 | 1): string[] {
  const root = instanceRoot(instanceId)
  const order = readResourcePackOrder(instanceId)
  const target = order.indexOf(name)
  if (target < 0) return order
  const next = target + dir
  if (next < 0 || next >= order.length) return order
  ;[order[target], order[next]] = [order[next], order[target]]
  writeResourcePackOrder(root, order)
  return order
}

export function toggleResourcePack(instanceId: string, name: string, enabled: boolean): string[] {
  const root = instanceRoot(instanceId)
  const order = readResourcePackOrder(instanceId)
  const has = order.includes(name)
  const next = enabled && !has ? [...order, name] : !enabled && has ? order.filter((x) => x !== name) : order
  writeResourcePackOrder(root, next)
  return next
}

function writeResourcePackOrder(root: string, order: string[]) {
  const file = path.join(root, 'options.txt')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split(/\r?\n/) : []
  const value = JSON.stringify([...order, 'vanilla'])
  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'))
  if (idx >= 0) lines[idx] = `resourcePacks:${value}`
  else lines.push(`resourcePacks:${value}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.filter((l) => l !== '').join('\n') + '\n', 'utf-8')
}

/* ------------------------------------------------------------------ *
 * 一键导出诊断包（给作者/朋友排查）
 * ------------------------------------------------------------------ */

export function exportDiagnostics(instanceId: string): string {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const root = instanceRoot(instanceId)
  const files: { name: string; full: string }[] = []

  const candidates = [
    ['logs/latest.log', path.join(root, 'logs', 'latest.log')],
    ['logs/debug.log', path.join(root, 'logs', 'debug.log')],
    ['instance.json', path.join(store.instanceDir(instanceId), 'instance.json')]
  ] as [string, string][]
  for (const [name, full] of candidates) if (fs.existsSync(full)) files.push({ name, full })

  const crashDir = path.join(root, 'crash-reports')
  if (fs.existsSync(crashDir)) {
    for (const f of collectDirFiles(crashDir).slice(-10)) {
      files.push({ name: `crash-reports/${f.name}`, full: f.full })
    }
  }

  // 启动器自己的错误日志也一起带上
  const errFile = path.join(store.dataDir, 'logs', 'errors.log')
  if (fs.existsSync(errFile)) files.push({ name: 'launcher-errors.log', full: errFile })

  // mod 清单（从 mods 目录文件名 + 体检结果）
  const modsDir = path.join(root, 'mods')
  const modList = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((n) => n.endsWith('.jar')) : []
  const summary = [
    `WFMC 诊断包`,
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `实例: ${instance.name} (${instance.id})`,
    `版本: ${instance.mcVersion} / ${instance.loader} ${instance.loaderVersion ?? ''}`,
    `启动版本 ID: ${instance.versionId ?? instance.mcVersion}`,
    `内存: ${instance.maxMemory ?? '默认'}MB`,
    `隔离: ${instance.isolate ? '开' : '关'}`,
    `JVM 参数: ${(instance.extraJvmArgs ?? []).join(' ') || '无'}`,
    '',
    `mods (${modList.length}):`,
    ...modList.map((m) => `  - ${m}`)
  ].join('\n')
  const summaryFile = path.join(store.dataDir, 'temp', `diag-${instanceId}.txt`)
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true })
  fs.writeFileSync(summaryFile, summary, 'utf-8')
  files.push({ name: '概要.txt', full: summaryFile })

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const out = path.join(store.exportsDir, `诊断包-${instance.name}-${stamp}.zip`)
  fs.mkdirSync(store.exportsDir, { recursive: true })
  writeZip(out, files)
  fs.rmSync(summaryFile, { force: true })
  return out
}

/** 导出实例（打包成 zip，方便备份/搬机器） */
export function exportInstance(instanceId: string): string {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const dir = store.instanceDir(instanceId)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const out = path.join(store.exportsDir, `${instance.name}-${instance.mcVersion}-${stamp}.zip`)
  zipDirectory(dir, out)
  return out
}

/**
 * 导入实例 zip（自己导出的包，或别人分享的同结构包）。
 * 会读包里的 instance.json，按新 id 建实例并把文件铺开。
 */
export function importInstanceZip(zipPath: string): Instance {
  const buf = fs.readFileSync(zipPath)
  const entries = listZipEntries(buf)

  // 兼容「包根目录下直接是 instance.json」和「外面套了一层文件夹」两种情况
  const metaEntry = entries.find((e) => e.name === 'instance.json') ?? entries.find((e) => e.name.endsWith('/instance.json'))
  if (!metaEntry) throw new Error('不是有效的实例包（缺少 instance.json）')
  const prefix = metaEntry.name.slice(0, metaEntry.name.length - 'instance.json'.length)

  const meta = JSON.parse(readZipEntry(buf, metaEntry).toString('utf-8')) as Instance

  // 动态 require 避免 content ↔ instances 的加载顺序问题
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createInstance } = require('./instances') as typeof import('./instances')
  const created = createInstance({
    name: `${meta.name || '导入实例'}（导入）`,
    mcVersion: meta.mcVersion,
    loader: meta.loader,
    loaderVersion: meta.loaderVersion
  })

  const targetRoot = store.instanceDir(created.id)
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (prefix && !entry.name.startsWith(prefix)) continue
    const rel = prefix ? entry.name.slice(prefix.length) : entry.name
    if (!rel || rel === 'instance.json') continue
    const dest = path.join(targetRoot, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readZipEntry(buf, entry))
    count++
  }

  const merged: Instance = {
    ...created,
    versionId: meta.versionId ?? created.mcVersion,
    maxMemory: meta.maxMemory,
    minMemory: meta.minMemory,
    extraJvmArgs: meta.extraJvmArgs,
    resolution: meta.resolution,
    isolate: meta.isolate,
    installed: meta.installed,
    playTimeMs: 0
  }
  store.saveInstance(merged)
  void count
  return merged
}
