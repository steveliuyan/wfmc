import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Instance, LoaderType } from '../shared/types'
import { store } from './store'
import { listLocalVersions } from './minecraft'

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

export function deleteInstance(id: string, removeFiles: boolean) {
  const dir = store.instanceDir(id)
  if (!fs.existsSync(dir)) return
  if (removeFiles) {
    fs.rmSync(dir, { recursive: true, force: true })
  } else {
    fs.rmSync(store.instanceFile(id), { force: true })
  }
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
  fs.cpSync(store.instanceGameDir(id), store.instanceGameDir(target.id), { recursive: true })
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
  fs.rmSync(dir, { recursive: true, force: true })
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
