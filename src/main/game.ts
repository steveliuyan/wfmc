import fs from 'node:fs'
import path from 'node:path'
import { Version, type ResolvedVersion } from '@xmcl/core'
import type { ProgressFn } from '../shared/types'
import { downloadAll, downloadFile, fetchJson, sources } from './net'
import { MultiDownloader, registerDownloader, unregisterDownloader } from './fastdl'
import { store } from './store'

/**
 * 自己实现的原版文件安装（json / client.jar / libraries / assets）。
 *
 * 为什么不用 @xmcl/installer 的 install()：它走 undici 直连下载，遇到 BMCLAPI 的
 * 302 跳转会在 undici 6/7 之间踩到 `maxRedirections is not supported` 直接失败；
 * 而且并发/重试不好控。这里统一用全局 fetch（自动跟随重定向，Electron 里也稳），
 * 配合并发限制、断点跳过和进度回调。
 */

const OAUTH_UA = { 'User-Agent': 'ZhuDongLauncher/1.0 (Electron)' }

/** 本次安装的线程数（0/未设 → 48） */
function threads(defaultN = 48) {
  const n = Number(store.settings.downloadThreads ?? 0)
  return n >= 4 && n <= 128 ? n : defaultN
}

/** 速度计：把字节流变成 "3.2 MB/s · 剩 1:20" */
function makeMeter() {
  let bytes = 0
  let markAt = Date.now()
  let markBytes = 0
  let speed = 0
  return {
    add(delta: number) {
      bytes += delta
      const now = Date.now()
      if (now - markAt >= 600) {
        speed = ((bytes - markBytes) * 1000) / (now - markAt)
        markAt = now
        markBytes = bytes
      }
    },
    get total() {
      return bytes
    },
    text(remainingBytes?: number) {
      const mb = (speed / 1024 / 1024).toFixed(2)
      if (!remainingBytes || speed <= 0) return `${mb} MB/s`
      const left = Math.max(0, remainingBytes / speed)
      const mm = Math.floor(left / 60)
      const ss = Math.floor(left % 60)
      return `${mb} MB/s · 剩 ${mm}:${String(ss).padStart(2, '0')}`
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

function mirrorBase() {
  const mirror = store.settings.downloadSource === 'mirror'
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

/** 下载 json 里描述的所有 libraries（含 natives 包） */
async function installLibraries(
  version: ResolvedVersion,
  gameDir: string,
  key: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<string[]> {
  const meter = makeMeter()
  const dl = new MultiDownloader({ threads: threads(), chunks: 8, onBytes: (d) => meter.add(d) })
  registerDownloader(key, dl)
  const items = version.libraries.map((lib) => ({
    urls: rewriteUrl(lib.download.url),
    dest: path.join(gameDir, 'libraries', lib.download.path),
    size: lib.download.size
  }))
  const remaining = items.reduce((s, i) => s + (i.size ?? 0), 0)
  try {
    return await dl.downloadAll(items, (done, total) =>
      onProgress?.({ key, phase: `下载依赖库 libraries（${meter.text(remaining)}）`, current: done, total })
    )
  } finally {
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
  const dl = new MultiDownloader({ threads: threads(), chunks: 4, onBytes: (d) => meter.add(d) })
  registerDownloader(key, dl)
  const items = objects.map((obj) => ({
    urls: [src.assets + `/${obj.hash.slice(0, 2)}/${obj.hash}`, `https://resources.download.minecraft.net/${obj.hash.slice(0, 2)}/${obj.hash}`],
    dest: path.join(gameDir, 'assets', 'objects', obj.hash.slice(0, 2), obj.hash),
    size: (obj as { size?: number }).size
  }))
  const remaining = items.reduce((s, i) => s + (i.size ?? 0), 0)
  try {
    return await dl.downloadAll(items, (done, total) =>
      onProgress?.({
        key,
        phase: `下载游戏资源 assets（${objects.length} 个 · ${meter.text(remaining)}）`,
        current: done,
        total
      })
    )
  } finally {
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
  onProgress?.({ key, phase: '下载游戏客户端 client.jar', current: 0, total: 1 })
  await downloadFile(
    urls,
    dest,
    (cur, total) => onProgress?.({ key, phase: '下载游戏客户端 client.jar', current: cur, total }),
    { signal }
  )
}

/** 安装一个已解析版本的完整文件（libraries + assets + jar），已存在的自动跳过 */
export async function installResolvedGame(
  version: ResolvedVersion,
  gameDir: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<string[]> {
  const key = `install-${path.basename(path.dirname(gameDir))}`
  await fs.promises.mkdir(path.join(gameDir, 'libraries'), { recursive: true })
  await fs.promises.mkdir(path.join(gameDir, 'assets'), { recursive: true })

  const errors: string[] = []
  await installClientJar(version, gameDir, key, onProgress, signal).catch((e) => errors.push(`client.jar: ${e.message}`))
  errors.push(...(await installLibraries(version, gameDir, key, onProgress, signal)))
  errors.push(...(await installAssets(version, gameDir, key, onProgress, signal)))
  return errors
}

/** 安装原版（写 json → 解析 → 下载全部文件） */
export async function installVanilla(
  mcVersion: string,
  gameDir: string,
  onProgress?: ProgressFn,
  metaOverride?: { id: string; url: string },
  signal?: AbortSignal
): Promise<void> {
  const key = `install-${path.basename(path.dirname(gameDir))}`
  onProgress?.({ key, phase: `获取 ${mcVersion} 版本信息`, current: 0, total: 1 })

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
    versionJson = await fetchJson<{ id?: string }>(meta.url)
    await fs.promises.writeFile(jsonFile, JSON.stringify(versionJson), 'utf-8')
  }

  const resolved = await Version.parse(gameDir, mcVersion)
  const errors = await installResolvedGame(resolved, gameDir, onProgress, signal)
  if (errors.length > 0) {
    throw new Error(`有 ${errors.length} 个文件下载失败，例如：${errors[0]}`)
  }
  onProgress?.({ key, phase: `${mcVersion} 安装完成`, current: 1, total: 1, done: true })
}

async function findVersionMeta(mcVersion: string): Promise<{ id: string; url: string }> {
  const { src } = mirrorBase()
  const manifest = await fetchJson<{ versions: { id: string; url: string }[] }>(src.versionManifest)
  const meta = manifest.versions.find((v) => v.id === mcVersion)
  if (!meta) throw new Error(`版本清单里没有 ${mcVersion}`)
  return meta
}
