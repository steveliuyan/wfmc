import fs from 'node:fs'
import path from 'node:path'
import { ensureGamePath } from './paths'
import { diagnoseMods, type ModIssue } from './moddoctor'
import { store } from './store'

/**
 * 体检常驻：盯着实例的 mods 目录，一有增删改就在后台重跑一遍体检，
 * 结果直接推给界面。用户不用再手动点「体检模组」才发现一堆红的。
 */

export interface ModsDiagnosisPayload {
  instanceId: string
  issues: ModIssue[]
  /** 启用的 mod 数量 */
  activeCount: number
  at: number
}

let watcher: fs.FSWatcher | null = null
let watchedKey = ''
let timer: NodeJS.Timeout | null = null
let running = false
let pending = false
let listener: ((payload: ModsDiagnosisPayload) => void) | null = null
const RETRY_MS = 3000

/** 主进程启动时挂上，用来往渲染层推 */
export function setModsDiagnosisListener(fn: ((payload: ModsDiagnosisPayload) => void) | null) {
  listener = fn
}

function schedule(instanceId: string) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runDiagnosis(instanceId)
  }, 1200)
}

/** 跑一遍体检并推送（也用于打开页面时的首帧） */
export async function runDiagnosis(instanceId: string): Promise<ModsDiagnosisPayload | undefined> {
  if (running) {
    pending = true
    return undefined
  }
  running = true
  const keyAtStart = watchedKey
  try {
    const res = await diagnoseMods(instanceId)
    const payload: ModsDiagnosisPayload = {
      instanceId,
      issues: res.issues,
      activeCount: res.mods.filter((m) => !m.disabled).length,
      at: Date.now()
    }
    // 扫描期间用户切了实例，就别把旧结果推上去
    if (keyAtStart && !watchedKey.startsWith(instanceId)) return payload
    listener?.(payload)
    return payload
  } catch {
    return undefined
  } finally {
    running = false
    if (pending) {
      pending = false
      schedule(instanceId)
    }
  }
}

export function startModWatch(instanceId: string): void {
  const instance = store.getInstance(instanceId)
  if (!instance) return
  const modsDir = path.join(ensureGamePath(instance), 'mods')
  const key = `${instanceId}|${modsDir}`
  if (key === watchedKey && watcher) return

  stopModWatch()
  watchedKey = key

  const attach = () => {
    if (watchedKey !== key) return
    try {
      if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true })
      watcher = fs.watch(modsDir, { persistent: false }, (_event, name) => {
        // 只关心 jar 相关的变动，别的（比如索引文件）忽略
        const n = name ? String(name).toLowerCase() : ''
        if (n && !n.endsWith('.jar') && !n.endsWith('.jar.disabled') && !n.endsWith('.old')) {
          if (!n.includes('mods')) return
        }
        schedule(instanceId)
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
        // 目录被删/被替换（比如换整合包）后重挂
        setTimeout(() => {
          if (watchedKey === key) attach()
        }, RETRY_MS)
      })
    } catch {
      watcher = null
      setTimeout(() => {
        if (watchedKey === key) attach()
      }, RETRY_MS)
    }
  }

  attach()
  // 打开就先跑一遍，界面立刻有结果
  schedule(instanceId)
}

export function stopModWatch(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (watcher) {
    try {
      watcher.close()
    } catch {
      /* 忽略 */
    }
    watcher = null
  }
  watchedKey = ''
}

export function currentWatchedInstance(): string {
  return watchedKey ? watchedKey.split('|')[0] : ''
}
