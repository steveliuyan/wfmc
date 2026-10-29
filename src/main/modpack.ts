import fs from 'node:fs'
import path from 'node:path'
import type { LoaderType, ProgressFn } from '../shared/types'
import { downloadAll, downloadFile, fetchJson } from './net'
import { store } from './store'
import { installInstanceGame } from './minecraft'
import { createInstance } from './instances'
import { extractZipPrefixes, readFileInsideZip } from './zip'
import { ModrinthV2Client } from '@xmcl/modrinth'

const client = new ModrinthV2Client()

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
  meta?: { projectId?: string; versionId?: string; versionNumber?: string; url?: string }
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

  await installInstanceGame(instance, onProgress)

  const gameDir = store.instanceGameDir(instance.id)
  const key = `modpack-${instance.id}`
  onProgress?.({ key, phase: '下载整合包文件', current: 0, total: index.files.length })
  const errors = await downloadAll(
    index.files.map((f) => ({ url: f.downloads, dest: path.join(gameDir, f.path), skipIfExists: true })),
    6,
    (done, total) => onProgress?.({ key, phase: '下载整合包文件', current: done, total })
  )

  onProgress?.({ key, phase: '解压 overrides', current: 0, total: 1 })
  const extracted = await extractZipPrefixes(mrpackPath, ['overrides/', 'client-overrides/'], gameDir)
  onProgress?.({ key, phase: `整合包安装完成（解压 ${extracted} 个文件）`, current: 1, total: 1, done: true })

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
  onProgress?: ProgressFn
): Promise<string> {
  const tmp = path.join(store.dataDir, 'temp', `pack-${Date.now()}.mrpack`)
  onProgress?.({ key: 'modpack-download', phase: '下载整合包', current: 0, total: 1 })
  await downloadFile(url, tmp, undefined, { skipIfExists: false })
  try {
    return await installMrpackFile(tmp, displayName, onProgress)
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
  onProgress?: ProgressFn
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
  await installInstanceGame(instance, onProgress)

  const apiKey = store.settings.curseforgeApiKey.trim()
  const gameDir = store.instanceGameDir(instance.id)
  const key = `modpack-${instance.id}`

  if (apiKey) {
    const ids = manifest.files.map((f) => f.fileID)
    const chunks: number[][] = []
    for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100))
    const files: { url: string; dest: string }[] = []
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
        files.push({ url: f.downloadUrl, dest: path.join(gameDir, 'mods', f.fileName) })
      }
      done += chunk.length
      onProgress?.({ key, phase: '解析 CurseForge 文件', current: done, total: ids.length })
    }
    await downloadAll(files, 6, (d, t) => onProgress?.({ key, phase: '下载模组', current: d, total: t }))
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
