import fs from 'node:fs'
import path from 'node:path'
import type { Instance } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'

export interface ShotItem {
  name: string
  path: string
  size: number
  time: number
}

/** 截图列表（按时间倒序） */
export function listScreenshots(instanceId: string): ShotItem[] {
  const instance = store.getInstance(instanceId)
  if (!instance) return []
  const dir = path.join(gamePathFor(instance), 'screenshots')
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.(png|jpe?g)$/i.test(n))
      .map((n) => {
        const full = path.join(dir, n)
        const stat = fs.statSync(full)
        return { name: n, path: full, size: stat.size, time: stat.mtimeMs }
      })
      .sort((a, b) => b.time - a.time)
  } catch {
    return []
  }
}

export function deleteScreenshot(instanceId: string, target: string) {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const root = path.resolve(gamePathFor(instance))
  const full = path.resolve(target)
  if (!full.startsWith(root + path.sep)) throw new Error('路径不在实例目录内')
  fs.rmSync(full, { force: true })
}

export function screenshotsDir(instanceId: string): string {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const dir = path.join(gamePathFor(instance), 'screenshots')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ *
 * 性能预设：一键套 JVM 参数 + options.txt 渲染项
 * ------------------------------------------------------------------ */

export interface PerfPreset {
  id: 'low' | 'balanced' | 'high' | 'shader'
  name: string
  desc: string
  memoryMb: number
  jvmArgs: string[]
  options: Record<string, string>
}

export const PERF_PRESETS: PerfPreset[] = [
  {
    id: 'low',
    name: '低配（核显 / 老电脑）',
    desc: '2G 内存、视距 6、流畅优先',
    memoryMb: 2048,
    jvmArgs: ['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200', '-Dfile.encoding=UTF-8'],
    options: {
      renderDistance: '6',
      simulationDistance: '6',
      graphicsMode: '0',
      particles: '2',
      maxFps: '60',
      ao: 'false',
      entityShadows: 'false'
    }
  },
  {
    id: 'balanced',
    name: '均衡（默认推荐）',
    desc: '4G 内存、视距 10、画质标准',
    memoryMb: 4096,
    jvmArgs: ['-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:MaxGCPauseMillis=200', '-Dfile.encoding=UTF-8'],
    options: {
      renderDistance: '10',
      simulationDistance: '8',
      graphicsMode: '1',
      particles: '1',
      maxFps: '120',
      ao: 'true',
      entityShadows: 'true'
    }
  },
  {
    id: 'high',
    name: '高配（独显）',
    desc: '6G 内存 + Aikar G1GC、视距 16',
    memoryMb: 6144,
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-Dfile.encoding=UTF-8'
    ],
    options: {
      renderDistance: '16',
      simulationDistance: '12',
      graphicsMode: '1',
      particles: '0',
      maxFps: '144',
      ao: 'true',
      entityShadows: 'true'
    }
  },
  {
    id: 'shader',
    name: '光影（吃配置）',
    desc: '8G 内存、视距 12，给光影留性能',
    memoryMb: 8192,
    jvmArgs: [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=150',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:G1NewSizePercent=40',
      '-XX:G1MaxNewSizePercent=50',
      '-XX:G1HeapRegionSize=16M',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-Dfile.encoding=UTF-8'
    ],
    options: {
      renderDistance: '12',
      simulationDistance: '10',
      graphicsMode: '1',
      particles: '0',
      maxFps: '120',
      ao: 'true',
      entityShadows: 'true'
    }
  }
]

/** 把预设写进实例 + 该实例（或版本隔离目录）的 options.txt */
export function applyPerfPreset(instanceId: string, presetId: PerfPreset['id']): Instance {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const preset = PERF_PRESETS.find((p) => p.id === presetId)
  if (!preset) throw new Error('预设不存在')

  const optionsFile = path.join(gamePathFor(instance), 'options.txt')
  const map = new Map<string, string>()
  try {
    for (const line of fs.readFileSync(optionsFile, 'utf-8').split(/\r?\n/)) {
      const idx = line.indexOf(':')
      if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1))
    }
  } catch {
    /* 还没有 options.txt，创建一份 */
  }
  for (const [k, v] of Object.entries(preset.options)) map.set(k, v)
  fs.mkdirSync(path.dirname(optionsFile), { recursive: true })
  fs.writeFileSync(
    optionsFile,
    [...map.entries()].map(([k, v]) => `${k}:${v}`).join('\n') + '\n',
    'utf-8'
  )

  const updated: Instance = {
    ...instance,
    maxMemory: preset.memoryMb,
    minMemory: Math.min(1024, Math.round(preset.memoryMb / 4)),
    extraJvmArgs: preset.jvmArgs,
    perfPreset: preset.id
  }
  store.saveInstance(updated)
  return updated
}
