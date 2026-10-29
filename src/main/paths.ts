import fs from 'node:fs'
import path from 'node:path'
import type { Instance } from '../shared/types'
import { store } from './store'

/**
 * 实例的「游戏数据目录」。
 *
 * - 默认（不隔离）：就是实例的 minecraft 根目录，所有版本共享存档/模组/配置
 * - 开启 `isolate`：改用 `minecraft/versions/<原版版本号>/game`，一套独立存档、mods、
 *   config、options.txt（libraries / assets 仍然共享，不多占空间）
 *
 * 目录名按 **原版版本号（mcVersion）**，不按 versionId：versionId 会随加载器变
 * （`1.21.11` → `fabric-loader-0.20.1-1.21.11`），拿它当目录名的话，
 * 装完 Fabric / 切换「用这个启动」之后 mods 和存档会集体"消失"（其实是指向了另一个空目录）。
 */
export function gamePathFor(instance: Instance): string {
  const root = store.instanceGameDir(instance.id)
  if (!instance.isolate) return root

  const base = instance.mcVersion
  const target = path.join(root, 'versions', base, 'game')

  // 搬老目录：早先用 versionId 拼路径，带加载器的那份数据搬回原版版本号下面
  const legacyVersion = instance.versionId
  if (legacyVersion && legacyVersion !== base) {
    const legacy = path.join(root, 'versions', legacyVersion, 'game')
    if (fs.existsSync(legacy) && !fs.existsSync(target)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.renameSync(legacy, target)
      } catch {
        /* 搬不动就先用新目录，别让游戏起不来 */
      }
    }
  }
  return target
}

export function ensureGamePath(instance: Instance): string {
  const dir = gamePathFor(instance)
  fs.mkdirSync(dir, { recursive: true })
  for (const sub of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'config', 'logs', 'crash-reports']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return dir
}

export function resourcePathFor(instance: Instance): string {
  return store.instanceGameDir(instance.id)
}
