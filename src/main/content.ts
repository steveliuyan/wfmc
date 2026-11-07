import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  ContentItem,
  ContentKind,
  CrashReport,
  Instance,
  ModMeta,
  RestoreBackupResult,
  SaveBackup
} from '../shared/types'
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
import { diagnoseMods } from './moddoctor'
import { disableResourcePack } from './options'
import { createBackup, listBackups, pruneBackups, restoreBackup, type SavesBackupResult } from './savebackup'
import {
  createModsBackup,
  listModsBackups,
  pruneModsBackups,
  restoreModsBackup,
  type ModsBackupItem
} from './modbackup'
import { DiskCache } from './metacache'

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

/**
 * jar 元数据缓存：内存 + data/cache/jar-meta.json（几百个 mod 的整合包冷启动不用再拆一遍压缩包）。
 * 键是「路径|修改时间|启用状态」，jar 一换就自然失效。
 */
let jarMetaCache: DiskCache<ModMeta> | undefined
function metaCache(): DiskCache<ModMeta> {
  if (!jarMetaCache) jarMetaCache = new DiskCache<ModMeta>(path.join(store.dataDir, 'cache', 'jar-meta.json'))
  return jarMetaCache
}

/** 退出前把元数据缓存写盘（攒的那些还没来得及落盘） */
export function flushMetaCache(): void {
  try {
    jarMetaCache?.flush()
  } catch {
    /* 缓存写不进去不影响退出 */
  }
}

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
  const cached = metaCache().get(key)
  if (cached) return cached
  const meta: ModMeta = {}
  let buf: Buffer
  let entries: { name: string; isDirectory: boolean }[]
  try {
    const z = readZipFromFile(jarPath)
    buf = z.buf
    entries = z.entries
  } catch {
    metaCache().set(key, meta)
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
      metaCache().set(key, meta)
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
    metaCache().set(key, meta)
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

  metaCache().set(key, meta)
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

/** 批量启用（把 xxx.jar.disabled 改回 xxx.jar），体检里「前置被禁用了」一键修复用 */
export function enableContent(instanceId: string, kind: ContentKind, names: string[]): ContentItem[] {
  const dir = path.join(instanceRoot(instanceId), kind)
  for (const name of names) {
    const full = path.join(dir, name)
    if (full !== dir && !full.startsWith(dir + path.sep)) continue
    if (!fs.existsSync(full)) continue
    if (!full.toLowerCase().endsWith('.disabled')) continue
    try {
      fs.renameSync(full, full.slice(0, -'.disabled'.length))
    } catch {
      /* 单个失败不影响其它 */
    }
  }
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

/**
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
}

/** 列出这个实例的存档快照（新的在前） */
export function listSaveBackups(instanceId: string): SaveBackup[] {
  return listBackups(store.backupsDir, instanceId)
}

/** 只保留最近 keep 份快照 */
export function pruneSaveBackups(instanceId: string, keep = 12): number {
  return pruneBackups(store.backupsDir, instanceId, keep)
}

/**
 * 回滚到某个快照：先把当前存档再打一份「回滚前」的后悔药，再把快照覆盖写回。
 * 覆盖不清空 —— 快照里没有的存档保持原样，不会误删新世界。
 */
export function restoreSaveBackup(instanceId: string, backupFile: string): RestoreBackupResult {
  const root = instanceRoot(instanceId)
  const safetyBackup = backupSaves(instanceId)?.file
  const { restored, worlds } = restoreBackup(path.join(root, 'saves'), store.backupsDir, backupFile)
  pruneSaveBackups(instanceId)
  return { restored, safetyBackup, worlds }
}

/**
 * 备份整个 mods 目录（折腾模组之前的后悔药）。
 * jar 本来就压过，这里是 store 模式直接打包，几个 G 也只花几秒。
 */
export function backupMods(instanceId: string): string | undefined {
  const root = instanceRoot(instanceId)
  const out = createModsBackup(path.join(root, 'mods'), store.backupsDir, instanceId, {
    note: '手动备份'
  })
  pruneModsBackups(store.backupsDir, instanceId)
  return out
}

/** 列出这个实例的 mods 快照（新的在前） */
export function listModsBackupFiles(instanceId: string): ModsBackupItem[] {
  return listModsBackups(store.backupsDir, instanceId)
}

/**
 * 回滚到某个 mods 快照：先给当前状态打一份（回滚本身也能后悔），再覆盖写回。
 */
export function restoreModsBackupSnapshot(
  instanceId: string,
  backupFile: string
): { restored: number; removed: number; safetyBackup?: string } {
  const root = instanceRoot(instanceId)
  const modsDir = path.join(root, 'mods')
  const safetyBackup = createModsBackup(modsDir, store.backupsDir, instanceId, { note: '回滚前自动' })
  const res = restoreModsBackup(modsDir, store.backupsDir, backupFile)
  pruneModsBackups(store.backupsDir, instanceId)
  return { ...res, safetyBackup }
}

/** 崩溃报告列表 */export function listCrashReports(instanceId: string): CrashReport[] {
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

/** 把一段文本里的敏感串换掉（路径、账号名） */
function scrubText(text: string, subs: [string, string][]): string {
  let out = text
  for (const [from, to] of subs) {
    if (!from || from.length < 3) continue
    out = out.split(from).join(to)
    // Windows 日志里路径的反斜杠偶尔会成转义形式
    const alt = from.replace(/\\/g, '/')
    if (alt !== from) out = out.split(alt).join(to)
  }
  return out
}

const TEXT_LIKE = /\.(log|txt|json|json5|toml|ya?ml|cfg|conf|properties|ini|md)$/i

export function exportDiagnostics(instanceId: string): string {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const root = instanceRoot(instanceId)
  const files: { name: string; full: string }[] = []

  // 脱敏表：数据目录 / 实例目录 / 用户目录 / 账号名都换成占位符，发出去不泄露路径和人名
  const subs: [string, string][] = [
    [root, '<实例目录>'],
    [store.instanceDir(instanceId), '<实例配置目录>'],
    [store.dataDir, '<数据目录>'],
    [os.homedir(), '<用户目录>']
  ]
  for (const acc of store.accounts ?? []) {
    if (acc.name) subs.push([acc.name, '<玩家名>'])
    if ((acc as { uuid?: string }).uuid) subs.push([(acc as { uuid?: string }).uuid!, '<UUID>'])
  }

  const tmpDir = path.join(store.dataDir, 'temp', `diag-${instanceId}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  /** 文本类文件读出来脱敏后写临时文件，二进制直接复制 */
  const addFile = (zipName: string, full: string) => {
    if (!fs.existsSync(full)) return
    if (TEXT_LIKE.test(zipName)) {
      try {
        const scrubbed = scrubText(fs.readFileSync(full, 'utf-8'), subs)
        const tmp = path.join(tmpDir, zipName.replace(/[/\\]/g, '_'))
        fs.writeFileSync(tmp, scrubbed, 'utf-8')
        files.push({ name: zipName, full: tmp })
        return
      } catch {
        /* 读不了就按原样带上 */
      }
    }
    files.push({ name: zipName, full })
  }

  addFile('logs/latest.log', path.join(root, 'logs', 'latest.log'))
  addFile('logs/debug.log', path.join(root, 'logs', 'debug.log'))
  addFile('instance.json', path.join(store.instanceDir(instanceId), 'instance.json'))

  const crashDir = path.join(root, 'crash-reports')
  if (fs.existsSync(crashDir)) {
    for (const f of collectDirFiles(crashDir).slice(-10)) {
      addFile(`crash-reports/${f.name}`, f.full)
    }
  }

  // 启动器自己的错误日志也一起带上
  addFile('launcher-errors.log', path.join(store.dataDir, 'logs', 'errors.log'))

  // mod 清单 + 体检结果
  const modsDir = path.join(root, 'mods')
  const modList = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar') || n.toLowerCase().endsWith('.jar.disabled'))
    : []
  let diagLines: string[] = []
  try {
    const res = diagnoseMods(instanceId)
    const active = res.mods.filter((m) => !m.disabled).length
    diagLines = [
      '',
      `体检（启用 ${active} 个，共 ${res.mods.length} 个文件）：`,
      ...res.issues.map((x) => `  [${x.level}] ${x.title} —— ${x.detail}`)
    ]
  } catch {
    diagLines = ['', '体检：未跑成功（不影响其它信息）']
  }

  const totalMem = Math.round(os.totalmem() / 1024 ** 3)
  const summary = [
    `WFMC 诊断包`,
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `实例: ${instance.name} (${instance.id})`,
    `版本: ${instance.mcVersion} / ${instance.loader} ${instance.loaderVersion ?? ''}`,
    `启动版本 ID: ${instance.versionId ?? instance.mcVersion}`,
    `内存: ${instance.maxMemory ?? '默认'}MB（最小 ${instance.minMemory ?? '-'}MB）`,
    `隔离: ${instance.isolate ? '开' : '关'}`,
    `JVM 参数: ${(instance.extraJvmArgs ?? []).join(' ') || '无'}`,
    '',
    `系统: ${os.type()} ${os.release()} ${os.arch()}`,
    `CPU: ${os.cpus()[0]?.model ?? '未知'} × ${os.cpus().length}`,
    `物理内存: ${totalMem} GB`,
    `Node / Electron 运行时: ${process.versions.node} / ${process.versions.electron ?? '-'}`,
    ...diagLines,
    '',
    `mods 文件（${modList.length}）:`,
    ...modList.map((m) => `  - ${m}`)
  ].join('\n')
  const summaryFile = path.join(tmpDir, '概要.txt')
  fs.writeFileSync(
    summaryFile,
    scrubText(summary, subs.filter(([from]) => from !== store.dataDir)),
    'utf-8'
  )
  files.push({ name: '概要.txt', full: summaryFile })

  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const out = path.join(store.exportsDir, `诊断包-${instance.name}-${stamp}.zip`)
  fs.mkdirSync(store.exportsDir, { recursive: true })
  writeZip(out, files)
  fs.rmSync(tmpDir, { recursive: true, force: true })
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
