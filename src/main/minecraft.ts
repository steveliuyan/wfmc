import fs from 'node:fs'
import path from 'node:path'
import { Version, MinecraftFolder } from '@xmcl/core'
import { installFabric, installQuiltVersion, getForgeVersionList } from '@xmcl/installer'
import type { Instance, LoaderOption, LoaderType, ProgressFn, RemoteVersion } from '../shared/types'
import { downloadFile, fetchJson, fetchText, sources } from './net'
import { runProcess } from './proc'
import { store } from './store'
import { ensureJava } from './java'
import { installResolvedGame, installVanilla, libraryRelPath, type SpawnFn } from './game'
import { readFileInsideZip } from './zip'

export { installVanilla }

interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: { id: string; type: string; url: string; releaseTime: string }[]
}

/**
 * 愚人节版本：官方清单里它们的 type 也是 snapshot，只能按 id 认。
 * 名单来自官方 version_manifest_v2（1.8 那年的「2.0」从没进过清单，就只能靠整合包/自备 jar）。
 */
const APRIL_FOOLS = new Set([
  '15w14a', // 2015：爱的抱抱
  '1.rv-pre1', // 2016：熔岩生存
  '3d shareware v1.34', // 2019：3D 共享软件
  '20w14infinite', // 2020：无限维度
  '22w13oneblockatatime', // 2022：一个方块
  '23w13a_or_b', // 2023：投票更新
  '24w14potato', // 2024：毒土豆
  '25w14craftmine', // 2025：合成挖矿
  '2.0',
  '2.0_blue'
])

/** 这个 id 是不是愚人节版本 */
export function isAprilFools(id: string): boolean {
  return APRIL_FOOLS.has(id.trim().toLowerCase())
}

let manifestCache: { at: number; data: RemoteVersion[] } | undefined

/** 拉取远程版本列表（官方/镜像，一个不通自动换另一个） */
export async function listRemoteVersions(): Promise<RemoteVersion[]> {
  if (manifestCache && Date.now() - manifestCache.at < 10 * 60 * 1000) {
    return manifestCache.data
  }
  const preferMirror = store.settings.downloadSource !== 'official'
  const urls = preferMirror
    ? [sources(true).versionManifest, sources(false).versionManifest]
    : [sources(false).versionManifest, sources(true).versionManifest]

  let data: VersionManifest | undefined
  let lastErr: unknown
  for (const url of urls) {
    try {
      data = await fetchJson<VersionManifest>(url)
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!data) throw new Error(`版本清单拉不下来（两个源都不通）：${(lastErr as Error)?.message ?? '网络错误'}`)
  const list: RemoteVersion[] = data.versions.map((v) => ({
    id: v.id,
    type: v.type,
    releaseTime: v.releaseTime,
    url: v.url,
    aprilFools: isAprilFools(v.id) || undefined
  }))
  manifestCache = { at: Date.now(), data: list }
  return list
}

/** 本地已安装版本 */
export function listLocalVersions(gameDir: string): string[] {
  const dir = path.join(gameDir, 'versions')
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => fs.existsSync(path.join(dir, name, `${name}.json`)))
    .sort()
}

/** 实例目录下所有可启动版本（含原版 + 加载器） */
export function listInstanceVersions(instanceId: string) {
  return listLocalVersions(store.instanceGameDir(instanceId))
}

function instanceKey(gameDir: string) {
  return path.basename(path.dirname(gameDir))
}

/* ------------------------------ 加载器元数据 ------------------------------ */

const META_UA = { 'User-Agent': 'WFMC/1.0 (Electron)' }
const META_TIMEOUT = 12_000

/** 镜像优先还是官方优先（跟「下载源」设置走） */
function mirrorFirst(mirror: string, official: string): string[] {
  return store.settings.downloadSource === 'official' ? [official, mirror] : [mirror, official]
}

async function fetchJsonAny<T>(urls: string[], ms = META_TIMEOUT): Promise<T> {
  let lastErr: unknown
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: META_UA, signal: AbortSignal.timeout(ms) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`拉取失败（两个源都不通）：${(lastErr as Error)?.message ?? '网络错误'}`)
}

async function fetchTextAny(urls: string[], ms = META_TIMEOUT): Promise<string> {
  let lastErr: unknown
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: META_UA, signal: AbortSignal.timeout(ms) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.text()
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`拉取失败（两个源都不通）：${(lastErr as Error)?.message ?? '网络错误'}`)
}

/** 给不认 signal 的第三方调用加个超时壳，免得界面一直「加载中」 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} 超时（${Math.round(ms / 1000)} 秒没响应）`)), ms))
  ])
}

interface FabricLoaderArtifactLike {
  loader: { version: string; stable?: boolean }
  intermediary: unknown
  launcherMeta: unknown
}

/** Fabric 的 loader 版本列表（镜像 ≡ 官方同一份 JSON） */
async function fabricArtifacts(mcVersion: string): Promise<FabricLoaderArtifactLike[]> {
  return fetchJsonAny<FabricLoaderArtifactLike[]>(
    mirrorFirst(
      `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`
    )
  )
}

/** 单个 Fabric loader 版本清单（装的时候要这一份） */
async function fabricArtifact(mcVersion: string, loaderVersion: string): Promise<FabricLoaderArtifactLike> {
  return fetchJsonAny<FabricLoaderArtifactLike>(
    mirrorFirst(
      `https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}`,
      `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}`
    )
  )
}

interface LegacyFabricArtifactLike {
  loader: { version: string; stable?: boolean }
}

const LEGACY_FABRIC_META = 'https://meta.legacyfabric.net/v2'

/**
 * Legacy Fabric 的 loader 版本列表。
 * 没有镜像（bmclapi 只镜像了官方 fabric-meta），而且这站偶尔超时，所以自己重试几轮。
 */
async function legacyFabricArtifacts(mcVersion: string): Promise<LegacyFabricArtifactLike[]> {
  const url = `${LEGACY_FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`
  let lastErr: unknown
  for (let i = 1; i <= 3; i++) {
    try {
      return await fetchJsonAny<LegacyFabricArtifactLike[]>([url], 25_000)
    } catch (e) {
      lastErr = e
      if (i < 3) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  throw new Error(`拉取 Legacy Fabric 版本列表失败：${(lastErr as Error)?.message ?? '网络错误'}`)
}

/** Cleanroom 的 maven 仓库：官方域名对 jar 会 307 到 nexus.jsdu.cn 镜像 */
const CLEANROOM_REPOS = ['https://repo.cleanroommc.com/releases', 'https://nexus.jsdu.cn/repository']

function cleanroomMavenPath(version: string, file: string): string {
  return `com/cleanroommc/cleanroom/${version}/${file}`
}

/** Cleanroom 的版本列表（读 maven-metadata.xml，和 NeoForge 一个套路） */
async function cleanroomVersions(): Promise<string[]> {
  const urls = CLEANROOM_REPOS.map((r) => `${r}/com/cleanroommc/cleanroom/maven-metadata.xml`)
  let xml = ''
  let lastErr: unknown
  for (let i = 1; i <= 3 && !xml; i++) {
    xml = await fetchTextAny(urls, 25_000).catch((e) => {
      lastErr = e
      return ''
    })
    if (!xml && i < 3) await new Promise((r) => setTimeout(r, 600 * i))
  }
  if (!xml) throw new Error(`拉取 Cleanroom 版本列表失败：${(lastErr as Error)?.message ?? '网络错误'}`)
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]).filter(Boolean)
}

const loaderVersionCache = new Map<string, { at: number; data: LoaderOption[] }>()
const LOADER_TTL = 30 * 60 * 1000

/** 逐段比数字：47.4.28 > 47.3.0（纯字符串比会把 47.10 排到 47.9 前面） */
function compareDotted(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((s) => parseInt(s, 10) || 0)
  const pb = b.split(/[.\-+]/).map((s) => parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** 拉取各加载器可选版本 */
export async function listLoaderVersions(loader: LoaderType, mcVersion: string): Promise<LoaderOption[]> {
  if (loader === 'vanilla') return []
  const cacheKey = `${loader}|${mcVersion}`
  const hit = loaderVersionCache.get(cacheKey)
  if (hit && Date.now() - hit.at < LOADER_TTL) return hit.data

  let data: LoaderOption[] = []

  if (loader === 'fabric') {
    const artifacts = await fabricArtifacts(mcVersion)
    data = artifacts
      .map((a) => ({ value: a.loader.version, label: a.loader.version, stable: a.loader.stable }))
      .sort((a, b) => (a.stable === b.stable ? 0 : a.stable ? -1 : 1))
  } else if (loader === 'quilt') {
    const list = await fetchJsonAny<{ loader?: { version: string }; version?: string }[]>([
      `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`
    ])
    data = list
      .map((v) => v.loader?.version ?? v.version ?? '')
      .filter(Boolean)
      .map((v) => ({ value: v, label: v }))
  } else if (loader === 'forge') {
    try {
      const builds = await fetchJsonAny<{ version: string }[]>(
        [`https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mcVersion)}`],
        15_000
      )
      const promos = await fetchJsonAny<{ promos?: Record<string, string> }>(
        ['https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'],
        12_000
      ).catch(() => ({ promos: {} as Record<string, string> }))
      const recommended = promos.promos?.[`${mcVersion}-recommended`]
      const latest = promos.promos?.[`${mcVersion}-latest`]
      const uniq = [...new Set(builds.map((b) => b.version).filter(Boolean))]
      data = uniq.sort((a, b) => compareDotted(b, a)).map((v) => ({
        value: v,
        label: `${mcVersion}-${v}${v === recommended ? '（推荐）' : v === latest ? '（最新）' : ''}`,
        stable: v === recommended
      }))
    } catch {
      const list = await withDeadline(getForgeVersionList({ minecraft: mcVersion }), 25_000, 'Forge 版本列表')
      data = list.versions.map((v) => ({
        value: v.version,
        label: `${mcVersion}-${v.version}`,
        stable: v.type === 'recommended'
      }))
    }
  } else if (loader === 'neoforge') {
    const xml = await fetchTextAny(
      mirrorFirst(
        'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml',
        'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
      )
    )
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
    const prefix = mcVersion.replace(/^1\./, '').split('.').slice(0, 2).join('.')
    data = all
      .filter((v) => v.startsWith(prefix + '.') || v.startsWith(prefix + '-'))
      .reverse()
      .map((v) => ({ value: v, label: v }))
  } else if (loader === 'legacyfabric') {
    const artifacts = await legacyFabricArtifacts(mcVersion)
    data = artifacts
      .map((a) => ({ value: a.loader.version, label: a.loader.version, stable: a.loader.stable }))
      .sort((a, b) => (a.stable === b.stable ? 0 : a.stable ? -1 : 1))
  } else if (loader === 'cleanroom') {
    // Cleanroom 只跑 1.12.2：别的版本给了也装不上，干脆不给
    if (mcVersion === '1.12.2') {
      const all = await cleanroomVersions()
      data = all
        .reverse()
        .map((v) => ({ value: v, label: v, stable: !/-(alpha|beta|pre|snapshot)/i.test(v) }))
    }
  }

  if (data.length) loaderVersionCache.set(cacheKey, { at: Date.now(), data })
  return data
}

/**
 * 这套「加载器 + 版本」装完之后版本目录叫什么。
 *
 * 装之前就能算出来，所以可以先看本地有没有、有就不再下一遍 ——
 * 用户来回切加载器时以前会把几百 MB 依赖重下一遍。
 */
export function loaderTargetVersionId(loader: LoaderType, mcVersion: string, loaderVersion: string): string {
  if (loader === 'fabric') return `fabric-loader-${loaderVersion}-${mcVersion}`
  if (loader === 'quilt') return `quilt-loader-${loaderVersion}-${mcVersion}`
  if (loader === 'neoforge') return `neoforge-${loaderVersion}`
  if (loader === 'forge') return `${mcVersion}-forge-${loaderVersion}`
  // 加前缀是为了不和官方 Fabric 的 fabric-loader-x-y 撞名（两个加载器的库完全不一样）
  if (loader === 'legacyfabric') return `legacyfabric-loader-${loaderVersion}-${mcVersion}`
  if (loader === 'cleanroom') return `cleanroom-${loaderVersion}`
  return mcVersion
}

/** 版本 json 在 + 依赖库文件齐 → 这个加载器版本已经装好了，不用再下载 */
export async function loaderAlreadyInstalled(gameDir: string, versionId: string): Promise<boolean> {
  if (!versionId) return false
  if (!fs.existsSync(path.join(gameDir, 'versions', versionId, `${versionId}.json`))) return false
  try {
    const resolved = await Version.parse(new MinecraftFolder(gameDir), versionId)
    for (const lib of resolved.libraries ?? []) {
      const rel = lib.download?.path
      if (!rel) continue
      if (!fs.existsSync(path.join(gameDir, 'libraries', rel))) return false
    }
    return true
  } catch {
    return false
  }
}

const LOADER_NAME: Record<string, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  legacyfabric: 'Legacy Fabric',
  cleanroom: 'Cleanroom'
}

/* --------------------------- Legacy Fabric / Cleanroom --------------------------- */

export interface RawLibraryLike {
  name?: string
  url?: string
  downloads?: {
    artifact?: { path?: string; url?: string }
    classifiers?: Record<string, { path?: string; url?: string }>
  }
}

/**
 * 把「有 downloads.artifact 但 url 是空字符串」的库补上地址。
 *
 * Cleanroom 的 version.json 里 com.cleanroommc:cleanroom 那条就是这样（它指望安装器
 * 按 install_profile 的 repositories 去填）；@xmcl 遇到空 url 会默认当成
 * libraries.minecraft.net，装完就是 404 —— 所以必须自己按 group 前缀挑仓库。
 *
 * 顺手把 classifiers 里缺 path 的补上（路径能从坐标算出来）。
 */
export function fixLibraryDownloads(
  libs: RawLibraryLike[],
  repositories: Record<string, string>
): { urlFixed: number; pathFixed: number } {
  const repos = Object.entries(repositories).sort((a, b) => b[0].length - a[0].length)
  let urlFixed = 0
  let pathFixed = 0
  for (const lib of libs) {
    const art = lib.downloads?.artifact
    if (art && !art.url) {
      const group = (lib.name ?? '').split(':')[0]
      const repo = repos.find(([prefix]) => group === prefix || group.startsWith(prefix + '.'))?.[1]
      if (repo) {
        art.url = `${repo.replace(/\/+$/, '')}/${art.path ?? ''}`
        urlFixed++
      }
    }
    for (const [classifier, cls] of Object.entries(lib.downloads?.classifiers ?? {})) {
      if (!fillClassifierPath(cls, lib.name, classifier)) continue
      pathFixed++
    }
  }
  return { urlFixed, pathFixed }
}

function fillClassifierPath(cls: { path?: string }, name: string | undefined, classifier: string): boolean {
  if (cls.path || !name) return false
  const rel = libraryRelPath(`${name}:${classifier}`)
  if (!rel) return false
  cls.path = rel
  return true
}

/** 版本 json 原子落盘（先写 .part 再改名，中途断了不会留半个坏 json） */
async function writeVersionJson(gameDir: string, versionId: string, json: unknown): Promise<string> {
  const dir = path.join(gameDir, 'versions', versionId)
  await fs.promises.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${versionId}.json`)
  await fs.promises.writeFile(`${file}.part`, JSON.stringify(json), 'utf-8')
  await fs.promises.rename(`${file}.part`, file)
  return file
}

/**
 * 失败了也得报一次终态进度。
 * 否则进度条会永远停在「下载依赖库」那一格上转圈，用户以为还在装。
 */
async function runWithTerminalProgress(
  key: string,
  name: string,
  total: number,
  onProgress: ProgressFn | undefined,
  run: () => Promise<string>
): Promise<string> {
  try {
    return await run()
  } catch (e) {
    onProgress?.({
      key,
      phase: `${name} 安装失败：${(e as Error).message}`,
      current: total,
      total,
      done: true
    })
    throw e
  }
}

/**
 * Legacy Fabric 官方 profile json → 我们的版本 json（纯函数，方便单测）。
 * 它给的 id 是 fabric-loader-x-y，会跟官方 Fabric 撞名；改名并挂在原版下面继承。
 */
export function makeLegacyFabricVersionJson(
  profile: Record<string, unknown>,
  versionId: string,
  mcVersion: string
): Record<string, unknown> {
  return { ...profile, id: versionId, inheritsFrom: mcVersion, type: 'release' }
}

async function installLegacyFabric(
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<string> {
  const key = `install-${instanceKey(gameDir)}`
  const versionId = loaderTargetVersionId('legacyfabric', mcVersion, loaderVersion)
  onProgress?.({ key, phase: `获取 Legacy Fabric ${loaderVersion} 版本信息`, current: 0, total: 2 })

  const url = `${LEGACY_FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(
    loaderVersion
  )}/profile/json`
  let profile: Record<string, unknown> | undefined
  let lastErr: unknown
  for (let i = 1; i <= 3 && !profile; i++) {
    try {
      profile = await fetchJsonAny<Record<string, unknown>>([url], 30_000)
    } catch (e) {
      lastErr = e
      if (i < 3) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  if (!profile) throw new Error(`Legacy Fabric 版本信息拉不下来：${(lastErr as Error)?.message ?? '网络错误'}`)

  // 官方给的 json 里 id 是 fabric-loader-x-y，会跟官方 Fabric 撞名；改成我们自己的，并挂在原版下面
  await writeVersionJson(gameDir, versionId, makeLegacyFabricVersionJson(profile, versionId, mcVersion))

  onProgress?.({ key, phase: '下载 Legacy Fabric 依赖库', current: 1, total: 2 })
  const resolved = await Version.parse(gameDir, versionId)
  const errors = await installResolvedGame(resolved, gameDir, onProgress)
  if (errors.length) throw new Error(`Legacy Fabric 依赖下载失败 ${errors.length} 个：${errors[0]}`)
  onProgress?.({ key, phase: 'Legacy Fabric 安装完成', current: 2, total: 2, done: true })
  return versionId
}

/**
 * Cleanroom installer 里的两份 json → 我们的版本 json（纯函数，方便单测）。
 *
 * version.json 是自包含的完整版本（自带 1.12.2 的 client/downloads/assetIndex，自己的
 * minecraftArguments 里已经有 --tweakClass FMLTweaker，javaVersion 是 25），所以：
 * · 只补那个空 download url；
 * · 改成我们的 id；
 * · **不能**加 inheritsFrom —— @xmcl 合并 legacy 版本时会把父子两边的 minecraftArguments
 *   拼在一起，参数会重复一遍。
 */
export function makeCleanroomVersionJson(
  profile: { repositories?: Record<string, string> },
  versionJson: Record<string, unknown> & { libraries?: RawLibraryLike[] },
  versionId: string
): {
  json: Record<string, unknown>
  urlFixed: number
  pathFixed: number
  libraries: number
} {
  const finalJson: Record<string, unknown> & { libraries?: RawLibraryLike[] } = {
    ...versionJson,
    id: versionId,
    type: 'release'
  }
  delete finalJson.inheritsFrom
  const { urlFixed, pathFixed } = fixLibraryDownloads(finalJson.libraries ?? [], profile.repositories ?? {})
  return { json: finalJson, urlFixed, pathFixed, libraries: finalJson.libraries?.length ?? 0 }
}

/**
 * 装 Cleanroom。
 *
 * 不走官方安装器（它的 processors 是空的，压根没东西要处理）：直接把 installer jar 里的
 * version.json 掏出来用。
 */
async function installCleanroom(
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<string> {
  const key = `install-${instanceKey(gameDir)}`
  const versionId = loaderTargetVersionId('cleanroom', mcVersion, loaderVersion)
  const installer = path.join(gameDir, '.installers', `cleanroom-${loaderVersion}-installer.jar`)

  onProgress?.({ key, phase: `下载 Cleanroom ${loaderVersion} 安装包`, current: 0, total: 3 })
  await downloadFile(
    CLEANROOM_REPOS.map((r) => `${r}/${cleanroomMavenPath(loaderVersion, `cleanroom-${loaderVersion}-installer.jar`)}`),
    installer,
    undefined,
    { skipIfExists: false }
  )

  const profileBytes = readFileInsideZip(installer, 'install_profile.json')
  const versionBytes = readFileInsideZip(installer, 'version.json')
  if (!profileBytes || !versionBytes) {
    throw new Error('Cleanroom 安装包里没找到 install_profile.json / version.json（下载可能不完整，重试一次）')
  }
  const profile = JSON.parse(profileBytes.toString('utf-8')) as {
    minecraft?: string
    repositories?: Record<string, string>
    java?: { minimum?: number; recommended?: number }
  }
  const json = JSON.parse(versionBytes.toString('utf-8')) as {
    id?: string
    arguments?: unknown
    libraries?: RawLibraryLike[]
    javaVersion?: { majorVersion?: number }
  }
  if (json.arguments) {
    throw new Error('这个 Cleanroom 版本用的是新式 arguments 格式，本启动器还不支持（请换 0.7.x）')
  }

  // Cleanroom 要 Java 25：官方运行时清单只到 21，交给 ensureJava 走 Adoptium
  const needJava = profile.java?.recommended ?? profile.java?.minimum ?? 25
  onProgress?.({ key, phase: `准备 Java ${needJava}（Cleanroom 需要）`, current: 0, total: 3 })
  await ensureJava(mcVersion, undefined, undefined, needJava)

  // 自带的 javaVersion（25）要保留：启动时靠它决定用哪个 Java；inheritsFrom 一定不能加
  const { json: finalJson, urlFixed, pathFixed, libraries: libCount } = makeCleanroomVersionJson(
    profile,
    json,
    versionId
  )
  if (urlFixed || pathFixed) {
    console.log(`[WFMC] Cleanroom：补了 ${urlFixed} 个下载地址、${pathFixed} 个 natives 路径`)
  }
  await writeVersionJson(gameDir, versionId, finalJson)

  onProgress?.({ key, phase: `下载 Cleanroom 依赖库（${libCount} 个）`, current: 1, total: 3 })
  const resolved = await Version.parse(gameDir, versionId)
  const errors = await installResolvedGame(resolved, gameDir, onProgress)
  if (errors.length) throw new Error(`Cleanroom 依赖下载失败 ${errors.length} 个：${errors[0]}`)
  onProgress?.({ key, phase: `Cleanroom ${loaderVersion} 安装完成`, current: 3, total: 3, done: true })
  return versionId
}

/** 安装加载器，返回可启动的版本 id */
export async function installLoader(
  loader: LoaderType,
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  onProgress?: ProgressFn
): Promise<string> {
  const key = `install-${instanceKey(gameDir)}`

  // 已经装过的加载器版本直接复用：本地文件都在，没有再下一遍的道理
  const reusable = loaderTargetVersionId(loader, mcVersion, loaderVersion)
  if (await loaderAlreadyInstalled(gameDir, reusable)) {
    onProgress?.({
      key,
      phase: `${LOADER_NAME[loader] ?? loader} ${loaderVersion} 之前就装好了，直接用（不重新下载）`,
      current: 1,
      total: 1,
      done: true
    })
    return reusable
  }

  // Cleanroom 要 Java 25（官方清单只到 21），由 installCleanroom 自己按 install_profile 的
  // java.minimum 去 ensureJava；其余加载器照旧先确保有一个够新的 Java 能跑安装器
  const java = loader === 'cleanroom' ? '' : await ensureJava(mcVersion)

  if (loader === 'legacyfabric') {
    return runWithTerminalProgress(key, `Legacy Fabric ${loaderVersion}`, 2, onProgress, () =>
      installLegacyFabric(mcVersion, loaderVersion, gameDir, onProgress)
    )
  }

  if (loader === 'cleanroom') {
    return runWithTerminalProgress(key, `Cleanroom ${loaderVersion}`, 3, onProgress, () =>
      installCleanroom(mcVersion, loaderVersion, gameDir, onProgress)
    )
  }

  if (loader === 'fabric') {
    onProgress?.({ key, phase: `安装 Fabric ${loaderVersion}`, current: 0, total: 2 })
    const artifact = await fabricArtifact(mcVersion, loaderVersion)
    const versionId = `fabric-loader-${loaderVersion}-${mcVersion}`
    await installFabric(artifact as never, gameDir, { versionId })
    onProgress?.({ key, phase: '下载 Fabric 依赖库', current: 1, total: 2 })
    const resolved = await Version.parse(gameDir, versionId)
    const errors = await installResolvedGame(resolved, gameDir, onProgress)
    if (errors.length) throw new Error(`Fabric 依赖下载失败 ${errors.length} 个：${errors[0]}`)
    onProgress?.({ key, phase: 'Fabric 安装完成', current: 2, total: 2, done: true })
    return versionId
  }

  if (loader === 'quilt') {
    onProgress?.({ key, phase: `安装 Quilt ${loaderVersion}`, current: 0, total: 2 })
    const versionId = await installQuiltVersion({ minecraftVersion: mcVersion, version: loaderVersion, minecraft: gameDir })
    onProgress?.({ key, phase: '下载 Quilt 依赖库', current: 1, total: 2 })
    const resolved = await Version.parse(gameDir, versionId)
    const errors = await installResolvedGame(resolved, gameDir, onProgress)
    if (errors.length) throw new Error(`Quilt 依赖下载失败 ${errors.length} 个：${errors[0]}`)
    onProgress?.({ key, phase: 'Quilt 安装完成', current: 2, total: 2, done: true })
    return versionId
  }

  if (loader === 'forge' || loader === 'neoforge') {
    onProgress?.({
      key,
      phase: `安装 ${loader === 'forge' ? 'Forge' : 'NeoForge'} ${loaderVersion}（运行官方安装器，需要几分钟）`,
      current: 0,
      total: 3
    })
    const versionId = await installByInstallerJar(loader, mcVersion, loaderVersion, gameDir, java, onProgress)
    onProgress?.({ key, phase: `${loader === 'forge' ? 'Forge' : 'NeoForge'} 安装完成`, current: 3, total: 3, done: true })
    return versionId
  }

  return mcVersion
}

/**
 * 用加载器官方的 installer jar 装 Forge / NeoForge。
 *
 * 不用 @xmcl/installer 的 installForge：它内部要遍历 installer 这个 zip（依赖 yauzl 流式读取，
 * 在本机 Node 24 下会卡住）。直接跑官方安装器最稳，也是 PCL / HMCL 的做法。
 */
/**
 * 用加载器官方的 installer jar 装 Forge / NeoForge。
 *
 * 不用 @xmcl/installer 的 installForge：它内部要遍历 installer 这个 zip（依赖 yauzl 流式读取，
 * 在本机 Node 24 下会卡住）。直接跑官方安装器最稳，也是 PCL / HMCL 的做法。
 */
interface ProfileLike {
  libraries?: { name: string; downloads?: { artifact?: { path?: string; url?: string } } }[]
  version?: string
  jar?: string
}

/** maven 坐标 → libraries/ 下的相对路径（group:artifact:version[:classifier][@ext]） */
function mavenPath(coords: string): string | undefined {
  const [rest, ext] = coords.split('@')
  const parts = rest.split(':')
  if (parts.length < 3) return undefined
  const [group, artifact, version, classifier] = parts
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext || 'jar'}`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}

/** 从安装器 jar 里读出它要的库，提前用我们自己的下载器（镜像可用）拉到 libraries/ */
async function prefetchInstallerLibraries(
  jarPath: string,
  gameDir: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ done: number; failed: string[] }> {
  const want = new Map<string, string[]>() // 相对路径 → 候选下载地址
  const mavenRoots = ['https://bmclapi2.bangbang93.com/maven/', 'https://libraries.minecraft.net/']
  const add = (rel: string, url?: string) => {
    const list = want.get(rel) ?? []
    if (url) list.push(url)
    for (const root of mavenRoots) {
      const cand = root + rel
      if (!list.includes(cand)) list.push(cand)
    }
    want.set(rel, list)
  }

  for (const file of ['install_profile.json', 'version.json']) {
    const buf = readFileInsideZip(jarPath, file)
    if (!buf) continue
    let json: ProfileLike
    try {
      json = JSON.parse(buf.toString('utf-8')) as ProfileLike
    } catch {
      continue
    }
    for (const lib of json.libraries ?? []) {
      const rel = lib.downloads?.artifact?.path ?? (lib.name ? mavenPath(lib.name) : undefined)
      if (!rel) continue
      add(rel, lib.downloads?.artifact?.url)
    }
  }

  const libsDir = path.join(gameDir, 'libraries')
  const entries = [...want.entries()].filter(([rel]) => !fs.existsSync(path.join(libsDir, rel.replace(/\//g, path.sep))))
  const failed: string[] = []
  let done = 0
  const queue = [...entries]
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      const [rel, urls] = item
      const dest = path.join(libsDir, rel.replace(/\//g, path.sep))
      try {
        await downloadFile(urls, dest, undefined, { skipIfExists: false })
      } catch {
        failed.push(rel)
      }
      done++
      onProgress?.(done, entries.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  return { done: entries.length - failed.length, failed }
}

async function installByInstallerJar(
  loader: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  java: string,
  onProgress?: ProgressFn
): Promise<string> {
  const key = `install-${instanceKey(gameDir)}`
  const name = loader === 'forge' ? 'Forge' : 'NeoForge'
  try {
    return await runInstallerJar(loader, mcVersion, loaderVersion, gameDir, java, onProgress)
  } catch (e) {
    // 失败必须给进度条一个**终态**。
    // 以前这里直接往外抛：进度条最后一条还停在安装器的 stdout 上（比如
    // 「Host: authserver.mojang.com [Unknown]」），渲染层的 live 判断认为它还活着，
    // 于是界面显示「2/3 67%」一动不动，用户以为卡了一晚上（1.3.2 修的就是这个）。
    const msg = ((e as Error)?.message ?? String(e)).replace(/\s+/g, ' ').trim().slice(0, 200)
    onProgress?.({ key, phase: `${name} 安装失败：${msg}`, current: 3, total: 3, done: true })
    throw e
  }
}

/** 真正干活的那半边；失败由上面的 installByInstallerJar 兜成终态进度 */
async function runInstallerJar(
  loader: 'forge' | 'neoforge',
  mcVersion: string,
  loaderVersion: string,
  gameDir: string,
  java: string,
  onProgress?: ProgressFn
): Promise<string> {
  const key = `install-${instanceKey(gameDir)}`
  const mirror = store.settings.downloadSource !== 'official'
  const full = loader === 'forge' ? `${mcVersion}-${loaderVersion}` : loaderVersion

  // 安装器本身也要能从国内镜像拿到：官方 maven 在国内经常连不上（或被解析到死 IP），
  // 所以镜像永远排在候选里，选了「官方优先」也留作兜底。
  const official =
    loader === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`
  const relPath =
    loader === 'forge'
      ? `net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
      : `net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`
  const mirrors = [
    `https://bmclapi2.bangbang93.com/maven/${relPath}`,
    `https://download.mcbbs.net/maven/${relPath}`,
    `https://maven.aliyun.com/repository/public/${relPath}`
  ]
  // 镜像优先（除非用户明确选了官方优先）；官方永远留作兜底
  const urls = mirror ? [...mirrors, official] : [official, ...mirrors]

  const dir = path.join(gameDir, '.installers')
  const jar = path.join(dir, `${loader}-${full}-installer.jar`)
  onProgress?.({ key, phase: `下载 ${loader} 安装器`, current: 0, total: 3 })
  try {
    await downloadFile(urls, jar, undefined, { skipIfExists: false })
  } catch (e) {
    throw new Error(
      `下载 ${loader} 安装器失败（官方源和国内镜像都不通）：${(e as Error).message}。` +
        '到「设置 → 下载与性能」把下载源改成「国内镜像」，或者挂代理后重试。'
    )
  }

  // 官方安装器自己下载依赖时会用 java.net 的 DNS：这台机器上 maven 域名被污染成
  // 死 IP（Java 里报 SocketTimeoutException），而我们自己的下载走系统栈是通的。
  // 所以先把安装器要的库全部预下载到 libraries/，安装器发现文件已存在就会跳过下载。
  onProgress?.({ key, phase: `预下载 ${loader} 依赖库（绕开安装器的网络）`, current: 1, total: 3 })
  const pre = await prefetchInstallerLibraries(jar, gameDir, (done, total) => {
    onProgress?.({ key, phase: `预下载依赖库 ${done} / ${total}`, current: 1, total: 3 })
  })
  if (pre.failed.length) {
    onProgress?.({ key, phase: `依赖库有 ${pre.failed.length} 个没下下来，继续尝试`, current: 1, total: 3 })
  }

  const profiles = path.join(gameDir, 'launcher_profiles.json')
  if (!fs.existsSync(profiles)) {
    fs.writeFileSync(
      profiles,
      JSON.stringify({ profiles: {}, settings: {}, version: 3, launcherVersion: { name: '1.0.0', format: 21 } }, null, 2),
      'utf-8'
    )
  }

  const before = new Set(listLocalVersions(gameDir))
  onProgress?.({ key, phase: `${loader} 安装器运行中（跑 processor）`, current: 2, total: 3 })
  const result = await runProcess(
    java,
    ['-Djava.net.preferIPv4Stack=true', '-jar', jar, '--installClient', gameDir],
    {
      cwd: gameDir,
      timeoutMs: 20 * 60 * 1000,
      // 安装器卡在一条不返回的连接上时会彻底静音：3 分钟没一行输出就判死，
      // 别让用户对着 20 分钟的保底超时干等（2026-11-10 那次卡了整晚的教训）
      idleTimeoutMs: 3 * 60 * 1000,
      onLine: (line) => onProgress?.({ key, phase: line.slice(0, 120), current: 2, total: 3 })
    }
  )
  if (result.code !== 0) {
    const tail = (result.stderr || result.stdout).split('\n').filter((l) => l.trim()).slice(-6).join(' ')
    throw new Error(
      `${loader} 安装器退出码 ${result.code}：${tail}${pre.failed.length ? `（另有 ${pre.failed.length} 个依赖库没下载成功）` : ''}`
    )
  }

  const after = listLocalVersions(gameDir)
  const created = after.filter((v) => !before.has(v))
  // 安装器生成的目录名是固定的：NeoForge -> neoforge-<ver>，Forge -> <mc>-forge-<ver>
  const expected = loader === 'neoforge' ? `neoforge-${full}` : `${mcVersion}-forge-${loaderVersion}`
  const versionId =
    (after.includes(expected) ? expected : undefined) ??
    created.find((v) => v.toLowerCase().includes(loader)) ??
    created[0]
  if (!versionId) throw new Error(`${loader} 安装器没有生成版本目录`)
  onProgress?.({ key, phase: `${loader} 版本 ${versionId} 就绪`, current: 2, total: 3 })
  return versionId
}

/** 给实例安装游戏（原版 + 可选加载器），完成后写回 instance.json */
export async function installInstanceGame(
  instance: Instance,
  onProgress?: ProgressFn,
  options?: { skipVanilla?: boolean; signal?: AbortSignal; spawn?: SpawnFn }
): Promise<Instance> {
  const gameDir = store.instanceGameDir(instance.id)
  if (!options?.skipVanilla) {
    await installVanilla(instance.mcVersion, gameDir, onProgress, undefined, options?.signal, options?.spawn)
  }
  let versionId = instance.mcVersion
  if (instance.loader !== 'vanilla' && instance.loaderVersion) {
    versionId = await installLoader(instance.loader, instance.mcVersion, instance.loaderVersion, gameDir, onProgress)
  }
  const updated: Instance = { ...instance, versionId, installed: true }
  store.saveInstance(updated)
  // 别急着报「安装完成」：文件可能只下了一半（下载卡住 / 用户取消 / 镜像挂掉）。
  // store.getInstance 会按磁盘实际情况重算 installed，这里用它当真值。
  const check = store.getInstance(updated.id)
  if (!check?.installed) {
    throw new Error('游戏文件还没下载完整（版本 jar / json 缺失），请重新点一次安装继续下载（已下载的会自动跳过）')
  }
  return check
}

/**
 * 给「已经存在」的实例补装加载器（Fabric / Forge / NeoForge / Quilt）。
 * 装完把 instance.json 的 loader / loaderVersion / versionId 一起改掉，下次启动就用新版本。
 */
export async function addLoaderToInstance(
  instanceId: string,
  loader: LoaderType,
  loaderVersion: string,
  onProgress?: ProgressFn
): Promise<Instance> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  if (loader === 'vanilla') throw new Error('原版不需要装加载器')
  if (!loaderVersion) throw new Error('没选加载器版本')

  const gameDir = store.instanceGameDir(instanceId)
  // 加载器的版本 json 是 inheritsFrom 原版的，原版没装先补上
  if (listLocalVersions(gameDir).length === 0) {
    await installVanilla(instance.mcVersion, gameDir, onProgress)
  }
  const versionId = await installLoader(loader, instance.mcVersion, loaderVersion, gameDir, onProgress)
  const updated: Instance = { ...instance, loader, loaderVersion, versionId, installed: true }
  store.saveInstance(updated)
  return updated
}

/** 修复/补全实例缺失文件 */export async function repairInstance(instanceId: string, onProgress?: ProgressFn) {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = store.instanceGameDir(instanceId)
  const versionId = instance.versionId || instance.mcVersion
  const key = `install-${instanceId}`
  const mc = new MinecraftFolder(gameDir)
  const resolved = await Version.parse(mc, versionId)
  onProgress?.({ key, phase: '检查并补全依赖', current: 0, total: 1 })
  const errors = await installResolvedGame(resolved, gameDir, onProgress)
  onProgress?.({ key, phase: '检查完成', current: 1, total: 1 })
  if (errors.length) throw new Error(`仍有 ${errors.length} 个文件缺失：${errors[0]}`)
  return listLocalVersions(gameDir)
}
