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
  SaveBackup,
  SaveBackupKind
} from '../shared/types'
import { store } from './store'
import { adopt, shareable } from './blobstore'
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
import {
  backupFileName,
  createBackup,
  deleteBackup,
  listBackups,
  markBackupSynced,
  pruneBackups,
  restoreBackup,
  type SavesBackupResult
} from './savebackup'
import * as savescloud from './savescloud'
import { hasCloudToken } from './cloudsync'
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

/* ------------------------------------------------------------------ *
 * 大整合包（几百个 mod）的内容管理：先给列表，元数据后台补
 *
 * 为什么：readJarMeta 要拆 zip（zip.ts 是整文件读进内存再解压），
 * 400 个 mod 冷启动一次要好几秒，而且**同步**跑在主进程 —— 界面直接卡死。
 * 所以 content:list 只返回目录信息（毫秒级），元数据交给
 * enrichContentChunked 分批算，算一批推一批（event:content-meta）。
 * ------------------------------------------------------------------ */

/** 元数据缓存键：必须和 readJarMeta 内部用的键一模一样，否则永远命中不了 */
function jarMetaKey(item: ContentItem): string | undefined {
  if (item.isDir) return undefined
  if (!/\.(jar|zip)(\.disabled)?$/i.test(item.name)) return undefined
  return `${item.path}|${Math.round(item.mtime)}|${item.name.endsWith('.disabled') ? 'd' : 'e'}`
}

/** 快速列表：只读目录，不碰压缩包（几百个 mod 也是毫秒级） */
export function listContentQuick(instanceId: string, kind: ContentKind): ContentItem[] {
  return readFolder(path.join(instanceRoot(instanceId), kind))
}

export interface ContentMetaPatch {
  path: string
  meta: ModMeta
}

/**
 * 后台补元数据。每算 chunk 个就让出事件循环一次，算完一批立刻回调，
 * 主进程不会被一个长时间的同步循环堵住。
 * 返回「这次真正需要读的条数」（缓存命中的不算）。
 */
export async function enrichContentChunked(
  instanceId: string,
  kind: ContentKind,
  onPatch: (patches: ContentMetaPatch[]) => void,
  opts: { chunk?: number; isCancelled?: () => boolean } = {}
): Promise<number> {
  const chunk = Math.max(1, opts.chunk ?? 8)
  const items = listContentQuick(instanceId, kind)
  const todo = items.filter((it) => {
    const key = jarMetaKey(it)
    return !!key && !metaCache().get(key)
  })
  if (todo.length === 0) return 0

  let batch: ContentMetaPatch[] = []
  for (let i = 0; i < todo.length; i++) {
    if (opts.isCancelled?.()) break
    const item = todo[i]
    const key = jarMetaKey(item)
    if (!key) continue
    // readJarMeta 自己会写缓存；这里补上 item 的元数据
    const meta = readJarMeta(item.path, `${Math.round(item.mtime)}|${item.name.endsWith('.disabled') ? 'd' : 'e'}`)
    batch.push({ path: item.path, meta })
    if (batch.length >= chunk) {
      onPatch(batch)
      batch = []
      // 让出一次事件循环：界面 / 其它 IPC 才有机会插进来
      await new Promise<void>((r) => setImmediate(r))
    }
  }
  if (batch.length > 0) onPatch(batch)
  return todo.length
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
    const dest = path.join(dir, path.basename(file))
    fs.cpSync(file, dest, { recursive: true })
    // 模组 / 资源包丢进来时顺手收进内容仓库：同一份东西换个实例再导入也不重复占空间
    if (shareable(dest)) adopt(dest)
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
export function backupSaves(
  instanceId: string,
  opts: { kind?: SaveBackupKind } = {}
): SavesBackupResult | undefined {
  const root = instanceRoot(instanceId)
  const inst = store.getInstance(instanceId)
  const r = createBackup(path.join(root, 'saves'), store.backupsDir, instanceId, new Date(), {
    instanceName: inst?.name,
    mcVersion: inst?.mcVersion,
    loader: inst?.loader,
    loaderVersion: inst?.loaderVersion,
    kind: opts.kind
  })
  // 本地成功之后才异步上云：云端失败完全不影响本地这份
  if (r && cloudSavesReady()) void uploadSaveBackupCloud(instanceId, r.file).catch(() => undefined)
  return r
}

/* ------------------------------------------------------------------ 云端存档 */

/** 云端存档能不能用：登录了 + 云备份开关没关 */
export function cloudSavesReady(): boolean {
  return store.settings.cloud?.enabled !== false && hasCloudToken()
}

/** 手动打包的实例信息（上传 meta 用；不含 sha256，网络层自己算） */
function uploadMetaOf(instanceId: string, worlds: string[], files: number, createdAt: number): savescloud.UploadMeta {
  const inst = store.getInstance(instanceId)
  return {
    instance: instanceId,
    instanceName: inst?.name,
    mcVersion: inst?.mcVersion,
    loader: inst?.loader,
    loaderVersion: inst?.loaderVersion,
    worlds,
    files,
    createdAt
  }
}

/**
 * 把一份本地快照传上云端。
 * 传成功后在那份 .zip.json 里记下 cloudId，列表上就能显示「已同步」。
 */
export async function uploadSaveBackupCloud(instanceId: string, file?: string): Promise<{ ok: boolean; message: string; id?: string }> {
  if (!cloudSavesReady()) return { ok: false, message: '还没登录统一账号（或云备份被关掉了），先登录再传' }
  // 没指定文件就现打一份（直接走 createBackup，别走 backupSaves —— 那条会自动触发上传，成了自己叫自己）
  let zip = file
  if (!zip) {
    const root = instanceRoot(instanceId)
    const inst = store.getInstance(instanceId)
    zip = createBackup(path.join(root, 'saves'), store.backupsDir, instanceId, new Date(), {
      instanceName: inst?.name,
      mcVersion: inst?.mcVersion,
      loader: inst?.loader,
      loaderVersion: inst?.loaderVersion,
      kind: 'manual'
    })?.file
  }
  if (!zip) return { ok: false, message: '存档目录是空的，没什么可备份' }
  if (!fs.existsSync(zip)) return { ok: false, message: '这份快照文件不在了' }
  const stat = fs.statSync(zip)
  const limitMb = 500
  if (stat.size > limitMb * 1024 * 1024) {
    return { ok: false, message: `这份备份 ${(stat.size / 1024 / 1024).toFixed(0)}MB，超过云端单份 ${limitMb}MB 上限` }
  }
  const meta = readBackupMetaSafe(zip)
  const r = await savescloud.upload(
    zip,
    uploadMetaOf(instanceId, meta?.worlds ?? [], meta?.files ?? 0, meta?.createdAt ?? Date.now())
  )
  markBackupSynced(zip, r.id)
  return {
    ok: true,
    id: r.id,
    message: r.deduped ? '云端已有完全相同的这份存档，没有重复占用空间' : `已传到云端（${formatMb(r.bytes)}）`
  }
}

function readBackupMetaSafe(zip: string) {
  try {
    const p = `${zip}.json`
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      worlds?: string[]
      files?: number
      createdAt?: number
      instanceName?: string
      mcVersion?: string
    }
  } catch {
    return undefined
  }
}

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

/** 云端存档列表（按实例 / 版本 / 整合包 / 时间排序，界面直接用） */
export async function listCloudSaveBackups(instanceId?: string): Promise<{
  items: import('../shared/types').CloudSaveItem[]
  limits: import('../shared/types').CloudSaveLimits
}> {
  const r = await savescloud.list(instanceId)
  const items = (r.items ?? []).map((it) => ({
    id: it.id,
    instance: it.instance,
    instanceName: it.instance_name,
    mcVersion: it.mc_version,
    loader: it.loader,
    loaderVersion: it.loader_version,
    worlds: it.worlds ?? [],
    files: Number(it.files ?? 0),
    bytes: Number(it.bytes ?? 0),
    sha256: it.sha256,
    createdAt: Number(it.created_at ?? 0)
  }))
  return {
    items,
    limits: {
      savesKeep: Number(r.limits?.saves_keep ?? 10),
      maxFileMb: Number(r.limits?.max_file_mb ?? 500),
      quotaBytes: Number(r.limits?.quota_bytes ?? 2 * 1024 * 1024 * 1024),
      usedBytes: Number(r.limits?.used_bytes ?? 0)
    }
  }
}

/** 云端用量（“已用 X / 2GB”） */
export async function cloudSaveUsage() {
  return savescloud.usage()
}

/** 删掉云端某一份（幂等） */
export async function deleteCloudSaveBackup(id: string): Promise<{ ok: boolean; message: string }> {
  await savescloud.remove(id)
  return { ok: true, message: '已从云端删掉' }
}

/**
 * 从云端恢复：下载 → 校验 sha256 → 落到备份目录（这样它也会出现在本地快照列表里）
 * → 复用 restoreSaveBackup（回滚前先本地备份 + zip-slip 防护）。
 */
export async function restoreCloudSaveBackup(
  instanceId: string,
  id: string,
  label?: string
): Promise<RestoreBackupResult & { file: string; downloadedBytes: number }> {
  const inst = store.getInstance(instanceId)
  if (!inst) throw new Error('实例不存在')
  const name = backupFileName(instanceId, new Date()).replace(/\.zip$/, `-cloud-${id.slice(-6)}.zip`)
  const dest = path.join(store.backupsDir, name)
  const got = await savescloud.download(id, dest)
  // 补一份说明文件，本地列表里也能看出它是什么、从哪来
  try {
    fs.writeFileSync(
      `${dest}.json`,
      JSON.stringify(
        {
          worlds: [],
          files: 0,
          instanceId,
          instanceName: inst.name,
          mcVersion: inst.mcVersion,
          loader: inst.loader,
          loaderVersion: inst.loaderVersion,
          createdAt: Date.now(),
          cloudId: id,
          cloudAt: Date.now(),
          note: label
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch {
    /* 说明写不上不影响恢复 */
  }
  const r = restoreSaveBackup(instanceId, dest, { avoidOverwrite: true })
  return { ...r, file: dest, downloadedBytes: got.bytes }
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

/** 删掉一份快照（用户在列表里点删除） */
export function deleteSaveBackup(file: string): boolean {
  return deleteBackup(store.backupsDir, file)
}

/**
 * 回滚到某个快照：先把当前存档再打一份「回滚前」的后悔药，再把快照覆盖写回。
 * 覆盖不清空 —— 快照里没有的存档保持原样，不会误删新世界。
 */
export function restoreSaveBackup(
  instanceId: string,
  backupFile: string,
  opts: { avoidOverwrite?: boolean } = {}
): RestoreBackupResult {
  const root = instanceRoot(instanceId)
  const safetyBackup = backupSaves(instanceId, { kind: 'safety' })?.file
  const { restored, worlds } = restoreBackup(path.join(root, 'saves'), store.backupsDir, backupFile, opts)
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
    if (shareable(dest)) adopt(dest)
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

/** 给 AI / 命令行看的诊断摘要（不走 zip，直接把结论和关键报错行读到上下文里） */
export interface DiagnosticsReport {
  /** 一句话体检结论 */
  conclusion: string
  /** 体检逐条问题（error / warn / info） */
  issues: { level: string; title: string; detail: string }[]
  /** latest.log 里最像「报错」的若干行（已去空、截断，最多 maxErrorLines 行） */
  errorLines: string[]
}

/**
 * 体检结论 + 关键报错行。用的是和导出诊断包同一个 `diagnoseMods`，口径一致；
 * 区别是它**不打包、不落地**，直接把文字给调用方（AI 助手读路径没用，要能读到内容）。
 */
export function diagnosticsReport(instanceId: string, maxErrorLines = 30): DiagnosticsReport {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const root = instanceRoot(instanceId)

  const issues: { level: string; title: string; detail: string }[] = []
  let conclusion = ''
  try {
    const res = diagnoseMods(instanceId)
    const active = res.mods.filter((m) => !m.disabled).length
    for (const x of res.issues) issues.push({ level: x.level, title: x.title, detail: x.detail })
    const errors = res.issues.filter((x) => x.level === 'error').length
    const warns = res.issues.filter((x) => x.level === 'warn').length
    conclusion =
      errors + warns === 0
        ? `体检通过：启用 ${active} 个模组（共 ${res.mods.length} 个文件），没发现 error / warn 级问题。`
        : `体检发现 ${errors} 个 error、${warns} 个 warn：启用 ${active} 个模组（共 ${res.mods.length} 个文件）。`
  } catch (e) {
    conclusion = `体检没跑成功（不影响看日志）：${(e as Error)?.message ?? e}`
  }

  const errorLines: string[] = []
  try {
    const logPath = path.join(root, 'logs', 'latest.log')
    if (fs.existsSync(logPath)) {
      const re = /\b(error|fatal|severe|exception|caused by|failed|could not|cannot|crash)\b/i
      for (const raw of fs.readFileSync(logPath, 'utf-8').split(/\r?\n/)) {
        if (re.test(raw)) {
          const line = raw.trim()
          if (line) errorLines.push(line.length > 500 ? `${line.slice(0, 500)}…` : line)
        }
      }
      if (errorLines.length > maxErrorLines) errorLines.splice(0, errorLines.length - maxErrorLines)
    }
  } catch {
    /* 没日志 / 读不了就不给，不影响结论 */
  }

  return { conclusion, issues, errorLines }
}

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
    if (shareable(dest)) adopt(dest)
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
