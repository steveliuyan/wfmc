import fs from 'node:fs'
import path from 'node:path'
import { Version, type ResolvedVersion } from '@xmcl/core'
import type { ProgressFn } from '../shared/types'
import { downloadAll, downloadFile, fetchJson, sources } from './net'
import { MultiDownloader, isDownloadPaused, registerDownloader, unregisterDownloader } from './fastdl'
import { isPaused } from './pause'
import { store } from './store'
import type { TaskContext, TaskKind } from './tasks'

/** 派生子任务（任务树）：由 runTask 的 ctx.spawn 传下来，直接调用时（脚本/测试）可以不给 */
export type SpawnFn = <T>(
  kind: TaskKind,
  title: string,
  fn: (ctx: TaskContext) => Promise<T>
) => Promise<T>

/**
 * 自己实现的原版文件安装（json / client.jar / libraries / assets）。
 *
 * 为什么不用 @xmcl/installer 的 install()：它走 undici 直连下载，遇到 BMCLAPI 的
 * 302 跳转会在 undici 6/7 之间踩到 `maxRedirections is not supported` 直接失败；
 * 而且并发/重试不好控。这里统一用全局 fetch（自动跟随重定向，Electron 里也稳），
 * 配合并发限制、断点跳过和进度回调。
 */

const OAUTH_UA = { 'User-Agent': 'ZhuDongLauncher/1.0 (Electron)' }

/** 本次安装的线程数（0/未设 → 16；上限 32，再多只会被 CDN 限速） */
function threads(defaultN = 16) {
  const n = Number(store.settings.downloadThreads ?? 0)
  return n >= 4 ? Math.min(n, 32) : defaultN
}

/** 字节计：只统计已下载字节和"真正在跑的时间"，速度/剩余时间交给渲染层显示一份就够 */
function makeMeter() {
  let bytes = 0
  const startAt = Date.now()
  /** 暂停时把计时也停住：否则分母一直涨，速度会一路往下掉、剩余时间一路往上爬，看着像还在下 */
  let pausedAt = 0
  let pausedMs = 0
  return {
    add(delta: number) {
      bytes += delta
    },
    get total() {
      return bytes
    },
    /** p=true 记下暂停起点，p=false 把这段暂停时间从分母里扣掉 */
    setPaused(p: boolean) {
      if (p) {
        if (!pausedAt) pausedAt = Date.now()
      } else if (pausedAt) {
        pausedMs += Date.now() - pausedAt
        pausedAt = 0
      }
    },
    /** 真正在跑的时间（不含暂停） */
    get activeSecs() {
      const end = pausedAt || Date.now()
      return Math.max(0, (end - startAt - pausedMs) / 1000)
    },
    /** 全程平均速度：只给日志/兜底用。正文里不再显示速度——渲染层已经有实时 ↓ 速度，两处都显示会打架 */
    get avgSpeed() {
      const secs = this.activeSecs
      return secs > 0.3 ? bytes / secs : 0
    }
  }
}

/**
 * 选一个本次安装用的资源源：先各拉一个小文件测速，谁快用谁。
 * 结果缓存 10 分钟，避免每次点下载都测。官方 CDN 和 BMCLAPI 在不同网络下快慢相反。
 */
let hostCache: { at: number; fastest: 'mirror' | 'official' } | undefined
async function pickFastestHost(probeHash: string): Promise<'mirror' | 'official'> {
  const forced = store.settings.downloadSource
  if (forced === 'mirror' || forced === 'official') return forced
  if (hostCache && Date.now() - hostCache.at < 10 * 60 * 1000) return hostCache.fastest
  const path = `/${probeHash.slice(0, 2)}/${probeHash}`
  const cands: [ 'mirror' | 'official', string][] = [
    ['mirror', 'https://bmclapi2.bangbang93.com/assets' + path],
    ['official', 'https://resources.download.minecraft.net' + path]
  ]
  const results = await Promise.all(
    cands.map(async ([name, url]) => {
      const t = Date.now()
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
        const buf = await r.arrayBuffer()
        return { name, ms: Date.now() - t, ok: r.ok && buf.byteLength > 0 }
      } catch {
        return { name, ms: 99999, ok: false }
      }
    })
  )
  const good = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms)
  const fastest = good[0]?.name ?? 'official'
  hostCache = { at: Date.now(), fastest }
  return fastest
}

/**
 * 镜像探活：BMCLAPI 挂掉是常事（DNS 通、端口不通最坑，会一直等到超时）。
 * 装之前先花几秒探一下版本清单，不通这次就走官方，别让用户对着超时干等。
 */
let mirrorHealth: { at: number; ok: boolean } | undefined

export function resetMirrorHealth() {
  mirrorHealth = undefined
}

export async function probeMirror(force = false): Promise<boolean> {
  if (!force && mirrorHealth && Date.now() - mirrorHealth.at < 5 * 60 * 1000) return mirrorHealth.ok
  const mirror = sources(true)
  try {
    const r = await fetch(mirror.versionManifest, { signal: AbortSignal.timeout(6000) })
    const ok = r.ok && (await r.text()).length > 100
    mirrorHealth = { at: Date.now(), ok }
  } catch {
    mirrorHealth = { at: Date.now(), ok: false }
  }
  if (!mirrorHealth.ok) console.warn('[source] 国内镜像不通，本次改用官方源')
  return mirrorHealth.ok
}

/**
 * 已经下过、这次会被跳过的文件有多少字节。
 * 进度条要按字节算，就得把跳过的那部分也算成「已完成」，不然装到一半就卡在 40% 不动。
 */
function alreadyDoneBytes(items: { dest: string; size?: number }[]): number {
  let done = 0
  for (const it of items) {
    try {
      const st = fs.statSync(it.dest)
      if (!it.size || st.size === it.size) done += it.size ?? st.size
    } catch {
      /* 没下过：不算 */
    }
  }
  return done
}

function mirrorBase() {
  let mirror = store.settings.downloadSource === 'mirror'
  // 镜像探活失败：这次安装整体走官方（单个文件仍然会 mirror→official 兜底）
  if (mirror && mirrorHealth && !mirrorHealth.ok) mirror = false
  return { src: sources(mirror), mirror }
}

/** 把官方地址改写到镜像源 */
function rewriteUrl(url: string): string[] {
  const { src, mirror } = mirrorBase()
  if (!mirror) return [url]
  const out: string[] = []
  if (url.includes('libraries.minecraft.net')) {
    out.push(url.replace('https://libraries.minecraft.net', src.maven))
  } else if (url.includes('maven.minecraftforge.net')) {
    out.push(url.replace('https://maven.minecraftforge.net', src.maven))
  } else if (url.includes('maven.neoforged.net')) {
    out.push(url.replace('https://maven.neoforged.net/releases', src.maven))
  } else if (url.includes('maven.fabricmc.net')) {
    // Legacy Fabric 的 asm / sponge-mixin / fabric-loader 都在 maven.fabricmc.net 上，bmclapi 有镜像
    out.push(url.replace('https://maven.fabricmc.net', src.maven))
  } else if (url.includes('resources.download.minecraft.net')) {
    out.push(url.replace('https://resources.download.minecraft.net', src.assets))
  }
  // 镜像失败再退回官方
  out.push(url)
  return [...new Set(out)]
}

interface AssetIndexJson {
  objects: Record<string, { hash: string; size: number }>
}

/**
 * maven 坐标 → 仓库里的相对路径：`group:artifact:version[:classifier][@ext]`。
 * 有些版本 json（比如 Cleanroom 的）里 natives 那批 classifiers 只给了 url/sha1/size，
 * 没给 path，下游按 path 拼磁盘位置会炸，所以缺的时候从名字算。
 */
export function libraryRelPath(name: string): string | undefined {
  const [coords, ext = 'jar'] = name.split('@')
  const parts = coords.split(':')
  if (parts.length < 3) return undefined
  const [group, artifact, version, classifier] = parts
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${artifact}-${version}${
    classifier ? `-${classifier}` : ''
  }.${ext}`
}

/** 下载 json 里描述的所有 libraries（含 natives 包） */
async function installLibraries(
  version: ResolvedVersion,
  gameDir: string,
  key: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<string[]> {
  const meter = makeMeter()
  const dl = new MultiDownloader({ threads: threads(), chunks: 8, onBytes: (d) => meter.add(d), signal })
  registerDownloader(key, dl)
  const items = version.libraries.map((lib) => ({
    urls: rewriteUrl(lib.download.url),
    dest: path.join(gameDir, 'libraries', lib.download.path ?? libraryRelPath(lib.name) ?? ''),
    size: lib.download.size
  }))
  const remaining = items.reduce((s, i) => s + (i.size ?? 0), 0)
  const skipped = alreadyDoneBytes(items)
  // downloadAll 的回调是「按文件」触发的，单个大文件根本不动；
  // 所以再挂一个 500ms 的心跳，按已下载字节数上报，进度条才是连续的
  let doneCount = 0
  // 暂停中（下载面板的暂停、或任务面板的暂停）要把文本冻住，别让速度/剩余时间继续爬
  const pausedNow = () => isDownloadPaused(key) || isPaused(signal)
  const emit = (cur: number, tot: number) => {
    const p = pausedNow()
    meter.setPaused(p)
    onProgress?.({
      key,
      phase: `${p ? '已暂停 · ' : ''}下载依赖库 libraries`,
      current: cur,
      total: tot,
      bytes: Math.min(remaining, skipped + meter.total),
      totalBytes: remaining
    })
  }
  const ticker = setInterval(() => emit(doneCount, items.length), 500)
  try {
    return await dl.downloadAll(items, (done, total) => {
      doneCount = done
      emit(done, total)
    })
  } finally {
    clearInterval(ticker)
    unregisterDownloader(key)
  }
}

/** 下载 assets 索引 + 所有资源对象 */
async function installAssets(
  version: ResolvedVersion,
  gameDir: string,
  key: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<string[]> {
  if (!version.assetIndex) return []
  const indexDir = path.join(gameDir, 'assets', 'indexes')
  await fs.promises.mkdir(indexDir, { recursive: true })
  const indexId = version.assetIndex.id ?? version.assets
  const indexFile = path.join(indexDir, `${indexId}.json`)

  if (!fs.existsSync(indexFile)) {
    onProgress?.({ key, phase: '下载 assets 索引', current: 0, total: 1 })
    await downloadFile(rewriteUrl(version.assetIndex.url), indexFile, undefined, { skipIfExists: false, signal })
  }

  let index: AssetIndexJson
  try {
    index = JSON.parse(await fs.promises.readFile(indexFile, 'utf-8'))
  } catch {
    return [`assets 索引解析失败: ${indexFile}`]
  }

  const { src } = mirrorBase()
  const objects = Object.values(index.objects ?? {})
  if (objects.length === 0) return []

  const meter = makeMeter()
  const dl = new MultiDownloader({ threads: threads(), chunks: 4, onBytes: (d) => meter.add(d), signal })
  registerDownloader(key, dl)
  const items = objects.map((obj) => ({
    urls: [src.assets + `/${obj.hash.slice(0, 2)}/${obj.hash}`, `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`],
    dest: path.join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash),
    size: (obj as { size?: number }).size
  }))
  const remaining = items.reduce((s, i) => s + (i.size ?? 0), 0)
  const skipped = alreadyDoneBytes(items)
  let doneCount = 0
  const pausedNow = () => isDownloadPaused(key) || isPaused(signal)
  const emit = (cur: number, tot: number) => {
    const p = pausedNow()
    meter.setPaused(p)
    onProgress?.({
      key,
      phase: `${p ? '已暂停 · ' : ''}下载游戏资源 assets（${objects.length} 个）`,
      current: cur,
      total: tot,
      bytes: Math.min(remaining, skipped + meter.total),
      totalBytes: remaining
    })
  }
  const ticker = setInterval(() => emit(doneCount, items.length), 500)
  try {
    return await dl.downloadAll(items, (done, total) => {
      doneCount = done
      emit(done, total)
    })
  } finally {
    clearInterval(ticker)
    unregisterDownloader(key)
  }
}

/** 下载 client.jar */
async function installClientJar(
  version: ResolvedVersion,
  gameDir: string,
  key: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<void> {
  const client = version.downloads.client
  if (!client) return
  const versionId = version.id
  const dest = path.join(gameDir, 'versions', versionId, `${versionId}.jar`)
  if (fs.existsSync(dest) && fs.statSync(dest).size === client.size) return

  const { src } = mirrorBase()
  const urls = [src.versionClient ? src.versionClient(versionId) : '', client.url].filter(Boolean)
  onProgress?.({ key, phase: '下载游戏客户端 client.jar', current: 0, total: 1, bytes: 0, totalBytes: client.size })
  const meter = makeMeter()
  const dl = new MultiDownloader({ threads: threads(), chunks: 8, onBytes: (d) => meter.add(d), signal })
  registerDownloader(key, dl)
  // 单个大 jar：靠 500ms 心跳上报字节，不然进度会一直是 0% 然后突然 100%
  const emit = () => {
    const p = isDownloadPaused(key) || isPaused(signal)
    meter.setPaused(p)
    onProgress?.({
      key,
      phase: `${p ? '已暂停 · ' : ''}下载游戏客户端 client.jar`,
      current: meter.total,
      total: client.size,
      bytes: Math.min(client.size, meter.total),
      totalBytes: client.size
    })
  }
  const ticker = setInterval(emit, 500)
  try {
    const errs = await dl.downloadAll([{ urls, dest, size: client.size, conns: 8 }], () => emit())
    if (errs.length > 0) throw new Error(errs[0].split('\u0000')[1] ?? 'client.jar 下载失败')
  } finally {
    clearInterval(ticker)
    unregisterDownloader(key)
  }
}

/** 安装一个已解析版本的完整文件（libraries + assets + jar），已存在的自动跳过 */
export async function installResolvedGame(
  version: ResolvedVersion,
  gameDir: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  spawn?: SpawnFn
): Promise<string[]> {
  const key = `install-${path.basename(path.dirname(gameDir))}`
  await fs.promises.mkdir(path.join(gameDir, 'libraries'), { recursive: true })
  await fs.promises.mkdir(path.join(gameDir, 'assets'), { recursive: true })

  const errors: string[] = []
  const jar = async (report?: (p: { phase?: string; current?: number; total?: number }) => void) =>
    installClientJar(version, gameDir, key, (p) => {
      onProgress?.(p)
      report?.({ phase: p.phase, current: p.current, total: p.total })
    }, signal).catch((e) => errors.push(`client.jar: ${e.message}`))
  const libs = async (report?: (p: { phase?: string; current?: number; total?: number }) => void) =>
    errors.push(...(await installLibraries(version, gameDir, key, (p) => {
      onProgress?.(p)
      report?.({ phase: p.phase, current: p.current, total: p.total })
    }, signal)))
  const assets = async (report?: (p: { phase?: string; current?: number; total?: number }) => void) =>
    errors.push(...(await installAssets(version, gameDir, key, (p) => {
      onProgress?.(p)
      report?.({ phase: p.phase, current: p.current, total: p.total })
    }, signal)))

  if (spawn) {
    // 任务树：客户端 / 库 / 资源各占一个子步骤，父任务按大小加权聚合进度
    await spawn('install', `${version.id} 客户端 client.jar`, async (c) => {
      await jar((p) => c.report(p))
    })
    await spawn('install', `${version.id} 库文件 libraries`, async (c) => {
      await libs((p) => c.report(p))
    })
    await spawn('install', `${version.id} 资源文件 assets`, async (c) => {
      await assets((p) => c.report(p))
    })
  } else {
    await jar()
    await libs()
    await assets()
  }
  return errors
}

/** 安装原版（写 json → 解析 → 下载全部文件） */
export async function installVanilla(
  mcVersion: string,
  gameDir: string,
  onProgress?: ProgressFn,
  metaOverride?: { id: string; url: string },
  signal?: AbortSignal,
  spawn?: SpawnFn
): Promise<void> {
  const key = `install-${path.basename(path.dirname(gameDir))}`
  onProgress?.({ key, phase: `获取 ${mcVersion} 版本信息`, current: 0, total: 1 })
  // 先探一下镜像还活着没：挂了就整体走官方，省得每个文件都等一次超时
  await probeMirror()

  const versionDir = path.join(gameDir, 'versions', mcVersion)
  await fs.promises.mkdir(versionDir, { recursive: true })
  const jsonFile = path.join(versionDir, `${mcVersion}.json`)

  let versionJson: { id?: string } | undefined
  if (fs.existsSync(jsonFile)) {
    try {
      versionJson = JSON.parse(await fs.promises.readFile(jsonFile, 'utf-8'))
    } catch {
      versionJson = undefined
    }
  }
  if (!versionJson) {
    const meta = metaOverride ?? (await findVersionMeta(mcVersion))
    versionJson = await fetchVersionJson(meta)
    await fs.promises.writeFile(jsonFile, JSON.stringify(versionJson), 'utf-8')
  }

  const resolved = await Version.parse(gameDir, mcVersion)
  const errors = await installResolvedGame(resolved, gameDir, onProgress, signal, spawn)
  if (errors.length > 0) {
    throw new Error(`有 ${errors.length} 个文件下载失败，例如：${errors[0]}`)
  }
  onProgress?.({ key, phase: `${mcVersion} 安装完成`, current: 1, total: 1, done: true })
}

/** 版本清单：按「下载源」设置的顺序都试一遍，谁先通谁算数 */
async function findVersionMeta(mcVersion: string): Promise<{ id: string; url: string }> {
  const order =
    store.settings.downloadSource === 'official'
      ? [sources(false), sources(true)]
      : [sources(true), sources(false)]
  let lastErr: unknown
  for (const src of order) {
    try {
      const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(src.versionManifest, {
        signal: AbortSignal.timeout(12_000)
      })
      const meta = manifest.versions.find((v) => v.id === mcVersion)
      if (!meta) throw new Error(`版本清单里没有 ${mcVersion}`)
      return meta
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`拿不到 ${mcVersion} 的版本清单（镜像和官方都不通）：${(lastErr as Error)?.message ?? '网络错误'}`)
}

/** 版本 json：清单给的地址不通就换另一家的同一个路径再试 */
async function fetchVersionJson(meta: { id: string; url: string }): Promise<{ id?: string }> {
  const urls = [
    meta.url,
    meta.url.replace(/^https?:\/\/[^/]+/, 'https://piston-meta.mojang.com'),
    meta.url.replace(/^https?:\/\/[^/]+/, 'https://launchermeta.mojang.com')
  ]
  let lastErr: unknown
  for (const url of [...new Set(urls)]) {
    try {
      return await fetchJson<{ id?: string }>(url, { signal: AbortSignal.timeout(20_000) })
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`版本 json 拉不下来：${(lastErr as Error)?.message ?? '网络错误'}`)
}
