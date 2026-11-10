import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Instance, LoaderType } from '../shared/types'
import { store } from './store'
import { listLocalVersions } from './minecraft'
import { measureTree, removeTreeWithProgress, type RemoveProgress } from './fsdel'
import { scheduleConfigSync, type ConfigSyncResult } from './cloudsync'
import { copyTreeSharing, gcBlobs } from './blobstore'

export interface CreateInstanceInput {
  name: string
  mcVersion: string
  loader?: LoaderType
  loaderVersion?: string
}

function slug(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'instance'
  )
}

export function createInstance(input: CreateInstanceInput): Instance {
  const settings = store.settings
  let id = slug(input.name)
  let suffix = 1
  while (fs.existsSync(store.instanceDir(id))) id = `${slug(input.name)}-${suffix++}`

  const instance: Instance = {
    id,
    name: input.name,
    mcVersion: input.mcVersion,
    loader: input.loader ?? 'vanilla',
    loaderVersion: input.loaderVersion,
    versionId: input.mcVersion,
    maxMemory: settings.maxMemory,
    minMemory: settings.minMemory,
    extraJvmArgs: [],
    playTimeMs: 0,
    createdAt: Date.now(),
    installed: false
  }
  fs.mkdirSync(store.instanceGameDir(id), { recursive: true })
  store.saveInstance(instance)
  return instance
}

export function updateInstance(id: string, patch: Partial<Instance>): Instance {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  const updated = { ...instance, ...patch, id: instance.id }
  store.saveInstance(updated)
  return updated
}

/**
 * 改实例的显示名。
 *
 * 只改 `name` 字段：**id 和目录名一律不动**。id 是 slug(创建时的名字)，同时是
 * `instances\<id>` 目录名、存档/备份/配置包里的键；跟着改名会把游戏文件、云备份、
 * 房间共享全部对不上。用户看到的名字就是 name，改它不影响任何已落盘的东西。
 *
 * 改完顺手把配置包推一次云端（打快照太贵，只推 KV），这样别的设备看到的就是新名字。
 */
export function renameInstance(id: string, rawName: string): { instance: Instance; cloudSync: ConfigSyncResult } {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  // 控制字符会把界面排版搞乱（换行/制表），统一压成空格
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!name) throw new Error('名字不能为空')
  if (name.length > 40) throw new Error('名字最多 40 个字符')
  if (name === instance.name) return { instance, cloudSync: 'off' }
  const clash = (store.listInstances() as Instance[]).some((i) => i.id !== id && i.name.trim() === name)
  if (clash) throw new Error('已经有一个叫这个名字的实例了，换个名字')

  const updated: Instance = { ...instance, name }
  store.saveInstance(updated)
  const cloudSync = scheduleConfigSync(`实例改名「${name}」`)
  return { instance: updated, cloudSync }
}

/**
 * 给实例换封面。
 *
 * 图片**拷贝进实例目录**（`instances/<id>/icon.<ext>`）而不是记别人机器上的绝对路径 ——
 * 用户挑完随手删了原图，卡片就白了。换的时候顺手把旧的图标文件删掉，不留垃圾。
 * 注意：图标是二进制文件，**不进云端配置包**（包里只有 instance.json），换机器会退回色块。
 */
export function setInstanceIcon(id: string, srcPath: string): Instance {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  if (!fs.existsSync(srcPath)) throw new Error('这张图找不到了，重新选一张')
  const ext = (path.extname(srcPath) || '.png').toLowerCase()
  const dir = store.instanceDir(id)
  fs.mkdirSync(dir, { recursive: true })
  for (const junk of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    if (junk === ext) continue
    try {
      fs.rmSync(path.join(dir, `icon${junk}`), { force: true })
    } catch {
      /* 删不掉无所谓，下面会覆盖 */
    }
  }
  const dest = path.join(dir, `icon${ext}`)
  fs.copyFileSync(srcPath, dest)
  const updated: Instance = { ...instance, icon: dest }
  store.saveInstance(updated)
  return updated
}

export function clearInstanceIcon(id: string): Instance {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  const dir = store.instanceDir(id)
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    try {
      fs.rmSync(path.join(dir, `icon${ext}`), { force: true })
    } catch {
      /* 没这个文件就算了 */
    }
  }
  const updated: Instance = { ...instance, icon: undefined }
  store.saveInstance(updated)
  return updated
}

/** 置顶 / 分组这类纯元数据改动：改完顺手把配置包推一次云端 */
export function setInstanceMeta(
  id: string,
  patch: { pinned?: boolean; group?: string }
): { instance: Instance; cloudSync: ConfigSyncResult } {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  const next: Instance = { ...instance }
  if ('pinned' in patch) next.pinned = patch.pinned || undefined
  if ('group' in patch) {
    const g = (patch.group ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
    next.group = g || undefined
  }
  store.saveInstance(next)
  return { instance: next, cloudSync: scheduleConfigSync('实例分组/置顶') }
}

export function deleteInstance(
  id: string,
  removeFiles: boolean,
  onProgress?: (p: RemoveProgress) => void
) {
  const dir = store.instanceDir(id)
  if (!fs.existsSync(dir)) return
  if (removeFiles) {
    // 带进度删：整合包实例动辄几 GB / 几万个小文件，静默 rmSync 看着像卡死
    removeTreeWithProgress(dir, onProgress)
    // 实例里的 jar 是指向内容仓库的硬链接，删完仓库里那份就成了孤儿，顺手清掉
    try {
      gcBlobs()
    } catch {
      /* 清不掉也不影响删除本身 */
    }
  } else {
    fs.rmSync(store.instanceFile(id), { force: true })
  }
}

/** 删之前先量一下，界面能提前说「要删 X 个文件 / Y GB」 */
export function instanceDeleteSize(id: string): { files: number; bytes: number } {
  const dir = store.instanceDir(id)
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0 }
  const m = measureTree(dir)
  return { files: m.files, bytes: m.bytes }
}

/** 复制实例（含游戏文件），用于开新档 */
export function duplicateInstance(id: string, newName?: string): Instance {
  const source = store.getInstance(id)
  if (!source) throw new Error('实例不存在')
  const target = createInstance({
    name: newName || `${source.name}-副本`,
    mcVersion: source.mcVersion,
    loader: source.loader,
    loaderVersion: source.loaderVersion
  })
  // 模组 / 资源包走硬链接（同一个 inode），只复制真正独有的文件
  copyTreeSharing(store.instanceGameDir(id), store.instanceGameDir(target.id))
  const merged: Instance = {
    ...target,
    versionId: source.versionId,
    maxMemory: source.maxMemory,
    minMemory: source.minMemory,
    extraJvmArgs: source.extraJvmArgs,
    resolution: source.resolution,
    server: source.server,
    installed: source.installed
  }
  store.saveInstance(merged)
  return merged
}

/** 删除某个版本目录（比如装坏的 Forge） */
export function deleteVersion(instanceId: string, versionId: string): string[] {
  const gameDir = store.instanceGameDir(instanceId)
  const dir = path.join(gameDir, 'versions', versionId)
  if (!fs.existsSync(dir)) throw new Error('版本不存在')
  removeTreeWithProgress(dir)
  const instance = store.getInstance(instanceId)
  if (instance && instance.versionId === versionId && versionId !== instance.mcVersion) {
    store.saveInstance({ ...instance, versionId: instance.mcVersion })
  }
  return listLocalVersions(gameDir)
}

function dirSize(dir: string): number {
  let total = 0
  const walk = (p: string) => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = path.join(p, item.name)
      if (item.isDirectory()) walk(full)
      else {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  walk(dir)
  return total
}

/** 实例概览：带本地版本 / 内容统计 / 体积 */
export function instanceDetail(id: string) {
  const instance = store.getInstance(id)
  if (!instance) throw new Error('实例不存在')
  const gameDir = store.instanceGameDir(id)
  const count = (folder: string) => {
    try {
      return fs.readdirSync(path.join(gameDir, folder)).filter((n) => !n.startsWith('.')).length
    } catch {
      return 0
    }
  }
  return {
    ...instance,
    gameDir,
    versions: listLocalVersions(gameDir),
    diskUsage: dirSize(store.instanceDir(id)),
    counts: {
      mods: count('mods'),
      resourcepacks: count('resourcepacks'),
      shaderpacks: count('shaderpacks'),
      saves: count('saves')
    }
  }
}

export function newId() {
  return randomUUID()
}
