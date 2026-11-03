import fs from 'node:fs'
import path from 'node:path'
import type { LoaderType, ProgressFn } from '../shared/types'
import { AbortError, fetchJson } from './net'
import { MultiDownloader, registerDownloader, unregisterDownloader } from './fastdl'
import { store } from './store'
import { installInstanceGame } from './minecraft'
import type { SpawnFn } from './game'
import { createInstance } from './instances'
import { extractZipPrefixes, readFileInsideZip } from './zip'
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

  await installInstanceGame(instance, onProgress, { signal, spawn })

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
    ...instance,
    packSource: {
      kind: meta?.projectId ? 'modrinth' : 'local',
      projectId: meta?.projectId,
      versionId: meta?.versionId ?? index.versionId,
      versionNumber: meta?.versionNumber,
      packName: index.name,
      url: meta?.url
    }
  })
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

/** 整合包更新检测：只对「从 Modrinth 装进来」的实例有效 */
export async function checkPackUpdate(instanceId: string): Promise<{
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
