import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ModrinthV2Client } from '@xmcl/modrinth'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { downloadFile } from './net'
import { gamePathFor, ensureGamePath } from './paths'

const client = new ModrinthV2Client()

export interface ModUpdateItem {
  /** mods 里的文件名 */
  file: string
  path: string
  hash: string
  /** 查到的项目 id（Modrinth） */
  projectId?: string
  latestVersionId?: string
  latestVersionNumber?: string
  latestFileName?: string
  downloadUrl?: string
  gameVersions?: string[]
  loaders?: string[]
  /** 是否真的需要更新 */
  updateAvailable: boolean
  /** 不在 Modrinth / 查不到的情况 */
  note?: string
}

function sha1File(file: string): string {
  const hash = crypto.createHash('sha1')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

/**
 * 用文件 sha1 去 Modrinth 反查 mod 的最新版本 —— 这就是 Daybreak 里
 * 「Mod 更新检查（按文件名搜索）」的升级版做法，不用靠猜文件名。
 */
export async function checkModUpdates(instanceId: string, onProgress?: ProgressFn): Promise<ModUpdateItem[]> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(ensureGamePath(instance), 'mods')
  if (!fs.existsSync(modsDir)) return []

  const jars = fs
    .readdirSync(modsDir)
    .filter((n) => n.toLowerCase().endsWith('.jar'))
    .map((name) => ({ name, path: path.join(modsDir, name) }))

  if (jars.length === 0) return []
  onProgress?.({ key: 'mod-updates', phase: '计算文件指纹', current: 0, total: jars.length })

  const hashed = jars.map((jar) => ({ ...jar, hash: sha1File(jar.path) }))
  const loader = instance.loader === 'vanilla' ? undefined : instance.loader

  let latest: Record<string, { id: string; version_number: string; files: { url: string; filename: string; primary: boolean }[]; loaders: string[]; game_versions: string[] }> = {}
  try {
    latest = (await client.getLatestVersionsFromHashes(
      hashed.map((h) => h.hash),
      { algorithm: 'sha1', loaders: loader ? [loader] : undefined, gameVersions: [instance.mcVersion] }
    )) as never
  } catch {
    /* 网络失败时降级为全部未知 */
  }

  return hashed.map((item) => {
    const hit = latest[item.hash]
    if (!hit) {
      const miss: ModUpdateItem = {
        file: item.name,
        path: item.path,
        hash: item.hash,
        updateAvailable: false,
        note: 'Modrinth 上查不到（可能是本地 / 整合包自带 / 未上传）'
      }
      return miss
    }
    const file = hit.files.find((f) => f.primary) ?? hit.files[0]
    const found: ModUpdateItem = {
      file: item.name,
      path: item.path,
      hash: item.hash,
      latestVersionId: hit.id,
      latestVersionNumber: hit.version_number,
      latestFileName: file?.filename,
      downloadUrl: file?.url,
      gameVersions: hit.game_versions,
      loaders: hit.loaders,
      updateAvailable: !!file && file.filename !== item.name
    }
    return found
  })
}

/** 下载新版本并替换旧文件（旧文件改名留底，方便回滚） */
export async function applyModUpdate(
  instanceId: string,
  input: { path: string; url: string; filename: string },
  onProgress?: ProgressFn
): Promise<string> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(ensureGamePath(instance), 'mods')
  const target = path.join(modsDir, input.filename)
  onProgress?.({ key: 'mod-updates', phase: `下载 ${input.filename}`, current: 0, total: 1 })
  await downloadFile(input.url, target, undefined, { skipIfExists: false })
  onProgress?.({ key: 'mod-updates', phase: `${input.filename} 已更新`, current: 1, total: 1 })
  if (fs.existsSync(input.path) && path.resolve(input.path) !== path.resolve(target)) {
    fs.renameSync(input.path, `${input.path}.old`)
  }
  return target
}
