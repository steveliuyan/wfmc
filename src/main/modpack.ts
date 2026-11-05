import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import type { LoaderType, ProgressFn } from '../shared/types'
import { AbortError, fetchJson } from './net'
import { MultiDownloader, registerDownloader, unregisterDownloader } from './fastdl'
import { store } from './store'
import { installInstanceGame } from './minecraft'
import type { SpawnFn } from './game'
import { createInstance } from './instances'
import { extractZipPrefixes, listZipEntries, readFileInsideZip } from './zip'
import { ModrinthV2Client } from '@xmcl/modrinth'

const client = new ModrinthV2Client()

/**
 * 整合包里的文件（模组、资源包…）统一走下载引擎：
 * 多个下载源自动换、多连接并发、断点续传、失效连接自动重连。
 * 老实现是 net.ts 的 downloadAll（每个文件一条串行连接），模组一多就慢得离谱。
 */
async function downloadPackFiles(
  key: string,
  items: { urls: string[]; dest: string }[],
  phase: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<string[]> {
  if (items.length === 0) return []
  const dl = new MultiDownloader({ threads: store.settings.downloadThreads ?? 32, chunks: 8, signal })
  registerDownloader(key, dl)
  const onAbort = () => dl.cancel()
  if (signal) {
    if (signal.aborted) dl.cancel()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    return await dl.downloadAll(
      items.map((i) => ({ urls: i.urls.filter(Boolean), dest: i.dest })),
      (done, total) => onProgress?.({ key, phase, current: done, total })
    )
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    unregisterDownloader(key)
  }
}

interface MrpackIndex {
  formatVersion: number
  name: string
  versionId: string
  summary?: string
  files: {
    path: string
    hashes: { sha1?: string; sha512?: string }
    downloads: string[]
    fileSize: number
  }[]
  dependencies: Record<string, string>
}

function loaderFromDependencies(deps: Record<string, string>): { loader: LoaderType; loaderVersion?: string } {
  if (deps['fabric-loader']) return { loader: 'fabric', loaderVersion: deps['fabric-loader'] }
  if (deps['quilt-loader']) return { loader: 'quilt', loaderVersion: deps['quilt-loader'] }
  if (deps['neoforge']) return { loader: 'neoforge', loaderVersion: deps['neoforge'] }
  if (deps['forge']) return { loader: 'forge', loaderVersion: deps['forge'] }
  return { loader: 'vanilla' }
}

/** 安装 Modrinth 整合包（.mrpack 本地文件） */
export async function installMrpackFile(
  mrpackPath: string,
  displayName?: string,
  onProgress?: ProgressFn,
  meta?: { projectId?: string; versionId?: string; versionNumber?: string; url?: string },
  signal?: AbortSignal,
  spawn?: SpawnFn
): Promise<string> {
  const indexBuf = readFileInsideZip(mrpackPath, 'modrinth.index.json')
  if (!indexBuf) throw new Error('不是有效的 Modrinth 整合包（缺少 modrinth.index.json）')

  const index = JSON.parse(indexBuf.toString('utf-8')) as MrpackIndex
  const mcVersion = index.dependencies.minecraft
  const { loader, loaderVersion } = loaderFromDependencies(index.dependencies)

  const instance = createInstance({
    name: displayName || index.name || `整合包-${Date.now()}`,
    mcVersion,
    loader,
    loaderVersion
  })

  // installInstanceGame 返回的是「装完加载器之后」的实例：versionId 已经改成
  // fabric-loader-x-y 这类。下面写 packSource 必须用它的返回值 ——
  // 拿 createInstance 那个旧对象去 save，会把 versionId 又写回原版，
  // 结果整合包装好了却按原版启动，模组一个都不加载。
  const installed = await installInstanceGame(instance, onProgress, { signal, spawn })

  const gameDir = store.instanceGameDir(instance.id)
  const key = `modpack-${instance.id}`
  onProgress?.({ key, phase: '下载整合包文件', current: 0, total: index.files.length })
  const errors = await downloadPackFiles(
    key,
    index.files.map((f) => ({ urls: f.downloads, dest: path.join(gameDir, f.path) })),
    '下载整合包文件',
    onProgress,
    signal
  )

  onProgress?.({ key, phase: '解压 overrides', current: 0, total: 1 })
  const extracted = await extractZipPrefixes(mrpackPath, ['overrides/', 'client-overrides/'], gameDir)
  onProgress?.({
    key,
    phase: `整合包安装完成（解压 ${extracted} 个文件${errors.length ? `，${errors.length} 个文件没下下来，见 download-errors.log` : ''}）`,
    current: 1,
    total: 1,
    done: true
  })

  if (errors.length) {
    fs.writeFileSync(path.join(store.instanceDir(instance.id), 'download-errors.log'), errors.join('\n'), 'utf-8')
  }
  store.saveInstance({
    ...installed,
    packSource: {
      kind: meta?.projectId ? 'modrinth' : 'local',
      projectId: meta?.projectId,
      versionId: meta?.versionId ?? index.versionId,
      versionNumber: meta?.versionNumber,
      packName: index.name,
      url: meta?.url
    }
  })
  // 记下「这个包本来长什么样」：以后升级才知道哪些文件是用户自己改过的
  try {
    writePackManifest(instance.id, {
      packVersionId: meta?.versionId ?? index.versionId,
      packVersionNumber: meta?.versionNumber,
      updatedAt: Date.now(),
      files: collectPackHashes(gameDir, mrpackPath, index.files.map((f) => f.path))
    })
  } catch {
    /* 清单写不上不影响安装，只是升级时没法判断「哪些是用户改的」 */
  }
  return instance.id
}

/** 从 Modrinth 在线安装整合包 */
export async function installMrpackFromUrl(
  url: string,
  displayName: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  spawn?: SpawnFn
): Promise<string> {
  const tmp = path.join(store.dataDir, 'temp', `pack-${Date.now()}.mrpack`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  onProgress?.({ key: 'modpack-download', phase: '下载整合包', current: 0, total: 1 })
  // 本体也走下载引擎：cdn.modrinth.com 单连接只有 ~50KB/s（还被墙），
  // 一个 100MB 的包能下半小时；多连接 + 代理分流后才勉强能用。
  const key = 'modpack-download'
  const dl = new MultiDownloader({ threads: store.settings.downloadThreads ?? 32, chunks: 8, signal })
  registerDownloader(key, dl)
  const onAbort = () => dl.cancel()
  if (signal) {
    if (signal.aborted) dl.cancel()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const errs = await dl.downloadAll(
      [{ urls: [url], dest: tmp, conns: 8 }],
      (done, total) => onProgress?.({ key, phase: '下载整合包', current: done, total: total || 1 })
    )
    if (errs.length > 0) throw new Error(errs[0].split('\u0000').pop() ?? '下载失败')
    if (!fs.existsSync(tmp)) throw new Error('下载失败（没有生成文件）')
  } catch (e) {
    if (signal?.aborted) throw new AbortError()
    if (e instanceof AbortError) throw e
    // 本体没下来就没法继续：告诉用户能用浏览器下 .mrpack 再本地导入
    throw new Error(
      `整合包本体没下下来（${(e as Error).message}）。可以在浏览器里打开下面的链接下载 .mrpack，再用「导入本地 .mrpack / .zip」安装：${url}`
    )
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    unregisterDownloader(key)
  }
  try {
    return await installMrpackFile(tmp, displayName, onProgress, undefined, signal, spawn)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

interface CurseManifest {
  minecraft: {
    version: string
    modLoaders: { id: string; primary: boolean }[]
  }
  manifestType: string
  manifestVersion: number
  name: string
  files: { projectID: number; fileID: number; required: boolean }[]
  overrides: string
}

/** 安装 CurseForge 整合包（本地 zip，模组下载需要在设置里填 CurseForge API Key） */
export async function installCurseforgeZip(
  zipPath: string,
  displayName?: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  spawn?: SpawnFn
): Promise<string> {
  const manifestBuf = readFileInsideZip(zipPath, 'manifest.json')
  if (!manifestBuf) throw new Error('不是有效的 CurseForge 整合包（缺少 manifest.json）')

  const manifest = JSON.parse(manifestBuf.toString('utf-8')) as CurseManifest
  const primary = manifest.minecraft.modLoaders.find((l) => l.primary) ?? manifest.minecraft.modLoaders[0]
  let loader: LoaderType = 'vanilla'
  let loaderVersion: string | undefined
  if (primary) {
    const [kind, version] = primary.id.split('-')
    if (kind === 'forge') {
      loader = 'forge'
      loaderVersion = version
    } else if (kind === 'fabric') {
      loader = 'fabric'
      loaderVersion = version
    } else if (kind === 'neoforge') {
      loader = 'neoforge'
      loaderVersion = version
    } else if (kind === 'quilt') {
      loader = 'quilt'
      loaderVersion = version
    }
  }

  const instance = createInstance({
    name: displayName || manifest.name || `CF整合包-${Date.now()}`,
    mcVersion: manifest.minecraft.version,
    loader,
    loaderVersion
  })
  await installInstanceGame(instance, onProgress, { signal, spawn })

  const apiKey = store.settings.curseforgeApiKey.trim()
  const gameDir = store.instanceGameDir(instance.id)
  const key = `modpack-${instance.id}`

  if (apiKey) {
    const ids = manifest.files.map((f) => f.fileID)
    const chunks: number[][] = []
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
    const files: { urls: string[]; dest: string }[] = []
    let done = 0
    for (const chunk of chunks) {
      const res = await fetchJson<{
        data: { id: number; fileName: string; downloadUrl: string | null; modId: number }[]
      }>('https://api.curseforge.com/v1/mods/files', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: chunk })
      })
      for (const f of res.data ?? []) {
        if (!f.downloadUrl) continue
        files.push({ urls: [f.downloadUrl], dest: path.join(gameDir, 'mods', f.fileName) })
      }
      done += chunk.length
      onProgress?.({ key, phase: '解析 CurseForge 文件', current: done, total: ids.length })
    }
    await downloadPackFiles(key, files, '下载模组', onProgress, signal)
  } else {
    onProgress?.({
      key,
      phase: '未配置 CurseForge API Key：只解压了配置，模组需要填 Key 后重新导入',
      current: 1,
      total: 1
    })
  }

  await extractZipPrefixes(zipPath, [`${manifest.overrides ?? 'overrides'}/`], gameDir)
  onProgress?.({ key, phase: '整合包安装完成', current: 1, total: 1, done: true })
  return instance.id
}

/** 整合包更新检测：只对「从 Modrinth 装进来」的实例有效 */export async function checkPackUpdate(instanceId: string): Promise<{
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  latestVersionId?: string
  downloadUrl?: string
  note: string
}> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const src = instance.packSource
  if (!src || src.kind !== 'modrinth' || !src.projectId) {
    return {
      hasUpdate: false,
      currentVersion: src?.versionNumber,
      note: '这个实例不是从 Modrinth 整合包装出来的（本地包 / CF 包没有可比对的版本号）'
    }
  }

  const versions = (await client.getProjectVersions(src.projectId, {
    gameVersions: [instance.mcVersion]
  })) as { id: string; version_number: string; files: { url: string; primary: boolean }[] }[]

  const latest = versions[0]
  if (!latest) return { hasUpdate: false, currentVersion: src.versionNumber, note: `Modrinth 上没有 ${instance.mcVersion} 的包版本` }

  const hasUpdate = latest.id !== src.versionId
  return {
    hasUpdate,
    currentVersion: src.versionNumber ?? src.versionId,
    latestVersion: latest.version_number,
    latestVersionId: latest.id,
    downloadUrl: latest.files.find((f) => f.primary)?.url ?? latest.files[0]?.url,
    note: hasUpdate ? `发现新版本 ${latest.version_number}` : '已经是最新版本'
  }
}

/* ------------------------------------------------------------------ *
 * 整合包升级（就地升级 + 保留用户配置）
 * ------------------------------------------------------------------ */

const PACK_MANIFEST = 'pack-manifest.json'

export interface PackManifest {
  packVersionId?: string
  packVersionNumber?: string
  updatedAt: number
  /** 相对实例游戏目录的路径 → sha1（整合包给这个文件的样子） */
  files: Record<string, string>
}

function manifestPath(instanceId: string): string {
  return path.join(store.instanceDir(instanceId), PACK_MANIFEST)
}

export function readPackManifest(instanceId: string): PackManifest | undefined {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(instanceId), 'utf-8')) as PackManifest
  } catch {
    return undefined
  }
}

function writePackManifest(instanceId: string, manifest: PackManifest): void {
  fs.mkdirSync(path.dirname(manifestPath(instanceId)), { recursive: true })
  fs.writeFileSync(manifestPath(instanceId), JSON.stringify(manifest, null, 2), 'utf-8')
}

function sha1OfFile(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

/** 安装完/升级完，把「包拥有的文件」逐个哈希，写成清单 */
function collectPackHashes(gameDir: string, mrpackPath: string, indexPaths: string[]): Record<string, string> {
  const files: Record<string, string> = {}
  const add = (rel: string) => {
    const abs = path.join(gameDir, rel)
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files[rel.replace(/\\/g, '/')] = sha1OfFile(abs)
    } catch {
      /* 单个文件读不了就跳过 */
    }
  }
  for (const p of indexPaths) add(p)

  // overrides 里的文件：直接读 zip 的中央目录拿名字
  try {
    const buf = fs.readFileSync(mrpackPath)
    for (const entry of listZipEntries(buf)) {
      if (entry.isDirectory) continue
      const prefix = ['overrides/', 'client-overrides/'].find((p) => entry.name.startsWith(p))
      if (!prefix) continue
      const rel = entry.name.slice(prefix.length)
      if (rel) add(rel)
    }
  } catch {
    /* zip 读不了就只记 index 里的文件 */
  }
  return files
}

export interface PackUpgradeResult {
  hasUpdate: boolean
  added: number
  updated: number
  removed: number
  /** 用户改过、这次主动保留本地的那几个文件 */
  keptModified: string[]
  /** 变更了但覆盖前留了 .packold 备份的文件（没有旧清单时的保守做法） */
  backedUp: number
  note: string
}

export interface PackCandidate {
  /** 相对实例游戏目录的路径 */
  rel: string
  /** 新包里这个文件应该长什么样（sha1） */
  sha1?: string
  /** 有就说明这个文件在 index 里，需要下载 */
  download?: { urls: string[] }
}

export interface PackMergePlan {
  added: number
  updated: number
  removed: number
  keptModified: string[]
  backedUp: number
  /** 还需要下载的文件（由调用方执行，好统一走下载引擎） */
  toDownload: { urls: string[]; dest: string }[]
}

/**
 * 三方合并的核心（纯文件系统逻辑，升级和单测都走这里）：
 * 新包给的样子 vs 旧清单记的样子 vs 本地现在的样子。
 */
export function applyPackMerge(opts: {
  gameDir: string
  /** 已经把新版 overrides 解压到的临时目录 */
  overridesDir: string
  candidates: PackCandidate[]
  /** 上一次安装/升级时记的清单：相对路径 → sha1 */
  oldFiles?: Record<string, string>
}): PackMergePlan {
  const { gameDir, overridesDir, candidates, oldFiles } = opts
  const trusted = !!oldFiles && Object.keys(oldFiles).length > 0
  const plan: PackMergePlan = { added: 0, updated: 0, removed: 0, keptModified: [], backedUp: 0, toDownload: [] }

  // 文本类的小配置才有必要留一份「新版长什么样」；jar / 大文件只记冲突
  const SMALL_TEXT = /\.(txt|json|json5|toml|ya?ml|cfg|conf|properties|ini|md)$/i
  const copyOverride = (rel: string, dest: string) => {
    const from = path.join(overridesDir, rel)
    if (!fs.existsSync(from)) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(from, dest)
    return true
  }

  for (const c of candidates) {
    const dest = path.join(gameDir, c.rel)
    const exists = fs.existsSync(dest)
    const localSha = exists ? sha1OfFile(dest) : undefined

    // 本地没有 → 直接装
    if (!exists) {
      if (c.download) plan.toDownload.push({ urls: c.download.urls, dest })
      else copyOverride(c.rel, dest)
      plan.added++
      continue
    }
    // 已经和新版一样 → 什么都不用做
    if (c.sha1 && localSha === c.sha1) continue

    // 和旧清单一致 = 用户没动过 → 放心覆盖
    const oldSha = oldFiles?.[c.rel]
    if (oldSha && localSha === oldSha) {
      if (c.download) plan.toDownload.push({ urls: c.download.urls, dest })
      else copyOverride(c.rel, dest)
      plan.updated++
      continue
    }

    // 本地被改过（或没有旧清单，判断不了）
    plan.keptModified.push(c.rel)
    if (trusted) {
      // 确定是用户改的：保留本地，新版放在旁边（只给小文本，jar 太重）
      if (SMALL_TEXT.test(c.rel) && !c.download) {
        try {
          fs.copyFileSync(path.join(overridesDir, c.rel), `${dest}.packnew`)
        } catch {
          /* 忽略 */
        }
      }
    } else {
      // 没有旧清单：覆盖成新版，但先把本地存一份 .packold，绝不丢用户配置
      try {
        const oldCopy = `${dest}.packold`
        if (!fs.existsSync(oldCopy)) fs.copyFileSync(dest, oldCopy)
      } catch {
        continue // 备份失败就不覆盖，安全第一
      }
      plan.backedUp++
      if (c.download) plan.toDownload.push({ urls: c.download.urls, dest })
      else copyOverride(c.rel, dest)
      plan.updated++
    }
  }

  // 新包删掉的文件：用户没动过才删
  const keepSet = new Set(candidates.map((c) => c.rel))
  for (const [rel, oldSha] of Object.entries(oldFiles ?? {})) {
    if (keepSet.has(rel)) continue
    const dest = path.join(gameDir, rel)
    if (!fs.existsSync(dest)) continue
    try {
      if (sha1OfFile(dest) === oldSha) {
        fs.rmSync(dest, { force: true })
        plan.removed++
      }
    } catch {
      /* 忽略 */
    }
  }

  return plan
}

/**
 * 就地升级整合包。
 *
 * 三方比较：新包给的样子 vs 旧清单记的样子 vs 本地现在的样子 ——
 *  - 本地和旧清单一致  = 用户没动过 → 放心覆盖成新版
 *  - 本地被改过        → 保留本地，新版放到 <文件>.packnew 让用户自己比
 *  - 新包删掉的文件    → 用户没动过才删
 * 没有旧清单（老版本装的实例）时，覆盖前一律留 .packold 备份，至少不丢东西。
 */
export async function upgradeInstancePack(
  instanceId: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<PackUpgradeResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const src = instance.packSource
  if (!src || src.kind !== 'modrinth' || !src.projectId) {
    throw new Error('这个实例不是从 Modrinth 整合包装出来的，没法就地升级（本地包 / CF 包没有版本号可比对）')
  }

  const upd = await checkPackUpdate(instanceId)
  const empty: PackUpgradeResult = {
    hasUpdate: false,
    added: 0,
    updated: 0,
    removed: 0,
    keptModified: [],
    backedUp: 0,
    note: upd.note
  }
  if (!upd.hasUpdate || !upd.downloadUrl) return empty

  const stamp = Date.now()
  const tmpZip = path.join(store.dataDir, 'temp', `upgrade-${stamp}.mrpack`)
  const tmpOverrides = path.join(store.dataDir, 'temp', `upgrade-${stamp}-ov`)
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true })

  onProgress?.({ key: 'pack-upgrade', phase: '下载新版整合包', current: 0, total: 1 })
  try {
    const errs = await downloadPackFiles('pack-upgrade', [{ urls: [upd.downloadUrl], dest: tmpZip }], '下载新版整合包', onProgress, signal)
    if (errs.length > 0 || !fs.existsSync(tmpZip)) {
      throw new Error(`新版整合包没下下来（${errs[0]?.split('\u0000').pop() ?? '未知原因'}）`)
    }

    const indexBuf = readFileInsideZip(tmpZip, 'modrinth.index.json')
    if (!indexBuf) throw new Error('新版不是有效的 Modrinth 整合包（缺少 modrinth.index.json）')
    const index = JSON.parse(indexBuf.toString('utf-8')) as MrpackIndex

    // MC 版本变了就是「换游戏」了，就地升级会把存档搞坏
    if (index.dependencies.minecraft !== instance.mcVersion) {
      throw new Error(
        `新版整合包换成了 Minecraft ${index.dependencies.minecraft}（当前实例是 ${instance.mcVersion}），就地升级会把存档搞坏。请新建一个实例装新版。`
      )
    }

    onProgress?.({ key: 'pack-upgrade', phase: '解压新版配置', current: 0, total: 1 })
    await extractZipPrefixes(tmpZip, ['overrides/', 'client-overrides/'], tmpOverrides)

    const gameDir = store.instanceGameDir(instanceId)
    const old = readPackManifest(instanceId)
    const trusted = !!old && Object.keys(old.files).length > 0

    // 候选：相对路径 → 期望 sha1（index 文件用包里给的，overrides 用解出来的实际值）
    const candidates: { rel: string; sha1?: string; download?: { urls: string[] } }[] = []
    for (const f of index.files) candidates.push({ rel: f.path, sha1: f.hashes.sha1, download: { urls: f.downloads } })

    if (fs.existsSync(tmpOverrides)) {
      const walk = (dir: string, rel = '') => {
        for (const n of fs.readdirSync(dir)) {
          const full = path.join(dir, n)
          const relPath = rel ? `${rel}/${n}` : n
          if (fs.statSync(full).isDirectory()) walk(full, relPath)
          else candidates.push({ rel: relPath, sha1: sha1OfFile(full) })
        }
      }
      walk(tmpOverrides)
    }

    const plan = applyPackMerge({
      gameDir,
      overridesDir: tmpOverrides,
      candidates,
      oldFiles: old?.files
    })
    const { added, updated, removed, keptModified, backedUp, toDownload } = plan
    if (toDownload.length > 0) {
      onProgress?.({ key: 'pack-upgrade', phase: '下载新版模组', current: 0, total: toDownload.length })
      const errs = await downloadPackFiles('pack-upgrade', toDownload, '下载新版模组', onProgress, signal)
      if (errs.length > 0) {
        fs.writeFileSync(
          path.join(store.instanceDir(instanceId), 'download-errors.log'),
          errs.join('\n'),
          'utf-8'
        )
      }
    }

    // 新清单：按「安装后实际内容」哈希（覆盖过的就是新版的样子）
    const newFiles: Record<string, string> = {}
    for (const c of candidates) {
      const abs = path.join(gameDir, c.rel)
      try {
        if (fs.existsSync(abs)) newFiles[c.rel] = fs.statSync(abs).isFile() ? sha1OfFile(abs) : c.sha1 ?? ''
      } catch {
        if (c.sha1) newFiles[c.rel] = c.sha1
      }
    }
    writePackManifest(instanceId, {
      packVersionId: upd.latestVersionId,
      packVersionNumber: upd.latestVersion,
      updatedAt: Date.now(),
      files: newFiles
    })

    const current = store.getInstance(instanceId)
    if (current) {
      store.saveInstance({
        ...current,
        packSource: {
          ...current.packSource!,
          versionId: upd.latestVersionId,
          versionNumber: upd.latestVersion
        }
      })
    }

    const result: PackUpgradeResult = {
      hasUpdate: true,
      added,
      updated,
      removed,
      keptModified,
      backedUp,
      note:
        `已升级到 ${upd.latestVersion ?? upd.latestVersionId}：` +
        `新增 ${added}、更新 ${updated}、删除 ${removed}` +
        (keptModified.length ? `、保留了你改过的 ${keptModified.length} 个文件` : '') +
        (backedUp ? `、覆盖前备份了 ${backedUp} 个（.packold）` : '')
    }
    onProgress?.({ key: 'pack-upgrade', phase: result.note, current: 1, total: 1, done: true })
    return result
  } finally {
    try {
      fs.rmSync(tmpZip, { force: true })
      fs.rmSync(tmpOverrides, { recursive: true, force: true })
    } catch {
      /* 临时文件删不掉留着 */
    }
  }
}
