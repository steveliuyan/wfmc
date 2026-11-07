/**
 * 服主面板 2.0：计划任务 + 看门狗
 *
 * 设计约定（见 ROADMAP-1.2.0.md C 方向）：
 *  - 这里只放「纯逻辑 + 一个 20 秒的定时器」，真正起停服务端的动作由 ipc.ts 注入（hooks），
 *    所以本模块不 import serverhost，方便单测。
 *  - 配置落在 <dataDir>/servers/<id>/sched.json，删服务端目录就一起没了。
 *  - 所有任务默认关闭；用户开了才跑。
 *  - 看门狗跟「崩溃自动重启」是两件事：看门狗管「退出了要不要拉起来」，退避 5s/15s/45s 三次后
 *    认输并停手，避免无限重启把磁盘写满日志。
 */
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import type { ServerSched } from '../shared/types'

export type { SchedBackup, SchedRestart, SchedLog, SchedWatchdog, ServerSched } from '../shared/types'

const DEFAULTS: ServerSched = {
  backup: { enabled: false, everyMinutes: 60, keep: 5 },
  restart: { enabled: false, everyMinutes: 360 },
  logrotate: { enabled: true, maxMb: 20, keep: 5 },
  watchdog: { enabled: false }
}

function serverDir(id: string) {
  return path.join(store.dataDir, 'servers', id)
}

function schedFile(id: string) {
  return path.join(serverDir(id), 'sched.json')
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 读配置：缺字段用默认值补，坏文件当默认值（不让一个坏 json 把面板拖死） */
export function readSched(id: string): ServerSched {
  let raw: Partial<ServerSched> = {}
  try {
    if (fs.existsSync(schedFile(id))) raw = JSON.parse(fs.readFileSync(schedFile(id), 'utf-8'))
  } catch {
    raw = {}
  }
  return {
    backup: { ...DEFAULTS.backup, ...(raw.backup ?? {}) },
    restart: { ...DEFAULTS.restart, ...(raw.restart ?? {}) },
    logrotate: { ...DEFAULTS.logrotate, ...(raw.logrotate ?? {}) },
    watchdog: { ...DEFAULTS.watchdog, ...(raw.watchdog ?? {}) },
    lastBackupAt: raw.lastBackupAt,
    lastRestartAt: raw.lastRestartAt,
    lastRotateAt: raw.lastRotateAt
  }
}

/** 写配置：只接受白名单字段，数值夹到合理区间（前端传什么都不会把定时器调成 0 秒） */
export function writeSched(id: string, patch: Partial<ServerSched>): ServerSched {
  const cur = readSched(id)
  const next: ServerSched = {
    ...cur,
    backup: {
      enabled: patch.backup?.enabled ?? cur.backup.enabled,
      everyMinutes: clampInt(patch.backup?.everyMinutes ?? cur.backup.everyMinutes, 5, 1440, cur.backup.everyMinutes),
      keep: clampInt(patch.backup?.keep ?? cur.backup.keep, 1, 50, cur.backup.keep)
    },
    restart: {
      enabled: patch.restart?.enabled ?? cur.restart.enabled,
      everyMinutes: clampInt(patch.restart?.everyMinutes ?? cur.restart.everyMinutes, 30, 10080, cur.restart.everyMinutes)
    },
    logrotate: {
      enabled: patch.logrotate?.enabled ?? cur.logrotate.enabled,
      maxMb: clampInt(patch.logrotate?.maxMb ?? cur.logrotate.maxMb, 1, 500, cur.logrotate.maxMb),
      keep: clampInt(patch.logrotate?.keep ?? cur.logrotate.keep, 1, 20, cur.logrotate.keep)
    },
    watchdog: { enabled: patch.watchdog?.enabled ?? cur.watchdog.enabled },
    lastBackupAt: patch.lastBackupAt ?? cur.lastBackupAt,
    lastRestartAt: patch.lastRestartAt ?? cur.lastRestartAt,
    lastRotateAt: patch.lastRotateAt ?? cur.lastRotateAt
  }
  fs.mkdirSync(serverDir(id), { recursive: true })
  const tmp = `${schedFile(id)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  fs.renameSync(tmp, schedFile(id))
  return next
}

function stampOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 只留最近 keep 份备份。
 * backupHosted 生成的包名是 `<服务端名>-<本地时间字符串>.zip`（时间字符串里带 `-` 和 `_`），
 * 所以按 mtime 排序而不是按文件名——改名过的服务端也不会把顺序搞乱。
 */
export function pruneBackups(serverName: string, keep: number): string[] {
  const dir = path.join(store.dataDir, 'backups', 'servers')
  if (!fs.existsSync(dir)) return []
  const mine = fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.zip') && n.startsWith(`${serverName}-`))
    .map((n) => {
      const full = path.join(dir, n)
      return { full, at: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.at - a.at)
  const drop = mine.slice(Math.max(1, keep))
  for (const item of drop) {
    try {
      fs.unlinkSync(item.full)
    } catch {
      /* 删不掉就算了，下次再试 */
    }
  }
  return drop.map((d) => d.full)
}

/**
 * 日志轮转：把 logs/latest.log 改名成 logs/wfmc-<stamp>.log，只留 keep 份。
 * 服务端跑着的时候也能改名（Minecraft 会继续往原 inode 写），所以不用停服。
 */
export function rotateLogs(id: string, maxMb = 20, keep = 5): { rotated?: string; sizeMb: number } {
  const logsDir = path.join(serverDir(id), 'logs')
  const latest = path.join(logsDir, 'latest.log')
  if (!fs.existsSync(latest)) return { sizeMb: 0 }
  const sizeMb = Math.round((fs.statSync(latest).size / (1024 * 1024)) * 10) / 10
  if (sizeMb < maxMb) return { sizeMb }
  const target = path.join(logsDir, `wfmc-${stampOf(new Date())}.log`)
  try {
    fs.renameSync(latest, target)
  } catch {
    return { sizeMb }
  }
  const old = fs
    .readdirSync(logsDir)
    .filter((n) => n.startsWith('wfmc-') && n.endsWith('.log'))
    .map((n) => {
      const full = path.join(logsDir, n)
      return { full, at: fs.statSync(full).mtimeMs }
    })
    .sort((a, b) => b.at - a.at)
    .slice(Math.max(1, keep))
  for (const item of old) {
    try {
      fs.unlinkSync(item.full)
    } catch {
      /* 忽略 */
    }
  }
  return { rotated: target, sizeMb }
}

export interface SchedHooks {
  /** 某个服务端现在跑着吗 */
  isRunning: (id: string) => boolean
  /** 起来（等效于点「启动」，内部自己 await 到进程 spawn 完成） */
  start: (id: string) => Promise<void>
  /** 优雅停服（发 stop，不等退出） */
  stop: (id: string) => void
  /** 立即备份，返回 zip 路径 */
  backup: (id: string) => string
  /** 往控制台日志里补一行 `[WFMC] …`，前端能在日志面板看到 */
  log: (id: string, line: string) => void
  /** 当前所有服务端 id（定时器每轮扫一遍，不缓存列表） */
  listIds: () => string[]
  /** 取服务端名字（备份保留策略要按名字匹配文件名） */
  nameOf: (id: string) => string | undefined
}

let timer: NodeJS.Timeout | undefined
let hooksRef: SchedHooks | undefined

/** 看门狗状态：id → 连续重启次数 */
const restartAttempts = new Map<string, number>()
/** 退避阶梯（毫秒）：5s / 15s / 45s，用完就停手 */
export const WATCHDOG_DELAYS = [5000, 15000, 45000]

function runBackup(hooks: SchedHooks, id: string) {
  const sched = readSched(id)
  try {
    const zip = hooks.backup(id)
    hooks.log(id, `[WFMC] 计划备份完成：${path.basename(zip)}`)
    pruneBackups(hooks.nameOf(id) ?? '', sched.backup.keep)
    writeSched(id, { lastBackupAt: Date.now() })
  } catch (e) {
    hooks.log(id, `[WFMC] 计划备份失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

function runRestart(hooks: SchedHooks, id: string) {
  if (!hooks.isRunning(id)) {
    // 没在跑就只记一次时间，不强行拉起（会不会被看门狗拉起由看门狗决定）
    writeSched(id, { lastRestartAt: Date.now() })
    return
  }
  // 重启前先备份一次，出问题还能回滚
  const sched = readSched(id)
  if (sched.backup.enabled) runBackup(hooks, id)
  hooks.log(id, '[WFMC] 计划重启：正在停服（保存世界后自动拉起）')
  hooks.stop(id)
  const waitStart = (attempt: number) => {
    const t = setTimeout(() => {
      if (hooks.isRunning(id)) {
        if (attempt < 40) return waitStart(attempt + 1)
        hooks.log(id, '[WFMC] 计划重启超时：服务端一直没停下来，已取消本次重启')
        return
      }
      void hooks
        .start(id)
        .then(() => hooks.log(id, '[WFMC] 计划重启完成'))
        .catch((e) => hooks.log(id, `[WFMC] 计划重启失败：${e instanceof Error ? e.message : String(e)}`))
    }, attempt === 0 ? 1000 : 1500)
    t.unref?.()
  }
  waitStart(0)
  writeSched(id, { lastRestartAt: Date.now() })
}

/** 定时器的一轮：纯函数式地看每个服务端该不该干活，方便单测（tickOnce 直接调） */
export function tickOnce(hooks: SchedHooks, now = Date.now()): string[] {
  const did: string[] = []
  for (const id of hooks.listIds()) {
    let sched: ServerSched
    try {
      sched = readSched(id)
    } catch {
      continue
    }
    const name = hooks.nameOf(id) ?? id

    if (sched.backup.enabled && hookRunning(hooks, id)) {
      const due = !sched.lastBackupAt || now - sched.lastBackupAt >= sched.backup.everyMinutes * 60_000
      if (due) {
        runBackup(hooks, id)
        did.push(`${name}:backup`)
      }
    }

    if (sched.restart.enabled) {
      const due = !sched.lastRestartAt || now - sched.lastRestartAt >= sched.restart.everyMinutes * 60_000
      if (due && hookRunning(hooks, id)) {
        runRestart(hooks, id)
        did.push(`${name}:restart`)
      }
    }

    if (sched.logrotate.enabled) {
      const due = !sched.lastRotateAt || now - sched.lastRotateAt >= 10 * 60_000
      if (due) {
        const res = rotateLogs(id, sched.logrotate.maxMb, sched.logrotate.keep)
        writeSched(id, { lastRotateAt: now })
        if (res.rotated) {
          hooks.log(id, `[WFMC] 日志已轮转（超过 ${sched.logrotate.maxMb}MB）`)
          did.push(`${name}:logrotate`)
        }
      }
    }
  }
  return did
}

function hookRunning(hooks: SchedHooks, id: string): boolean {
  try {
    return hooks.isRunning(id)
  } catch {
    return false
  }
}

/** 应用启动时调一次（重复调无副作用） */
export function startScheduler(hooks: SchedHooks, intervalMs = 20_000) {
  hooksRef = hooks
  if (timer) return
  timer = setInterval(() => {
    if (!hooksRef) return
    try {
      tickOnce(hooksRef)
    } catch {
      /* 定时器里绝不能让异常冒出来，否则整个进程崩 */
    }
  }, intervalMs)
  timer.unref?.()
}

export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = undefined
  hooksRef = undefined
}

/**
 * 服务端退出回调里调这个：看门狗决定要不要按退避阶梯拉起来。
 * 返回下一次重启的延迟（毫秒），null 表示不重启。
 */
export function handleHostedExit(hooks: SchedHooks, id: string, code: number | null): number | null {
  const sched = readSched(id)
  if (!sched.watchdog.enabled) {
    restartAttempts.delete(id)
    return null
  }
  // code === 0 是我们自己让它停的（stop / 计划重启），不算崩溃
  if (code === 0) {
    restartAttempts.delete(id)
    return null
  }
  const attempt = restartAttempts.get(id) ?? 0
  if (attempt >= WATCHDOG_DELAYS.length) {
    hooks.log(id, `[WFMC] 看门狗：连续 ${attempt} 次异常退出，放弃自动重启（请查看日志排查）`)
    restartAttempts.delete(id)
    return null
  }
  const delay = WATCHDOG_DELAYS[attempt]
  restartAttempts.set(id, attempt + 1)
  hooks.log(
    id,
    `[WFMC] 看门狗：服务端异常退出（code=${code ?? 'null'}），${Math.round(delay / 1000)} 秒后第 ${attempt + 1} 次尝试拉起`
  )
  const t = setTimeout(() => {
    void hooks
      .start(id)
      .then(() => hooks.log(id, '[WFMC] 看门狗：已重新拉起'))
      .catch((e) => hooks.log(id, `[WFMC] 看门狗拉起失败：${e instanceof Error ? e.message : String(e)}`))
  }, delay)
  t.unref?.()
  return delay
}

/** 服务端正常跑够久了就把重启计数清零（启动 5 分钟后不再算「连续崩溃」） */
export function noteHealthy(id: string, uptimeMs: number) {
  if (uptimeMs > 5 * 60_000) restartAttempts.delete(id)
}
