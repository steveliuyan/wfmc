import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Version, launch, createMinecraftProcessWatcher, MinecraftFolder, LaunchPrecheck } from '@xmcl/core'
import type { ContentKind, Instance, LaunchStatePayload } from '../shared/types'
import { store } from './store'
import { ensureJava, requiredJavaMajor } from './java'
import { ensureGameLanguage } from './options'
import { ensureNatives } from './natives'
import { listContent } from './content'
import { ensureGamePath, resourcePathFor } from './paths'
import { ensureInjector } from './authlib'
import { diagnoseMods } from './moddoctor'

type LogFn = (instanceId: string, line: string) => void
type StateFn = (payload: LaunchStatePayload) => void

const LAUNCHER_NAME = 'WFMC'
const LAUNCHER_BRAND = 'WFMC · WanFan Minecraft Launcher'

interface Running {
  proc: ChildProcess
  startedAt: number
}

const running = new Map<string, Running>()

export function isRunning(instanceId: string) {
  return running.has(instanceId)
}

export function killGame(instanceId: string) {
  const entry = running.get(instanceId)
  if (!entry) return false
  try {
    entry.proc.kill()
  } catch {
    /* 进程可能已退出 */
  }
  running.delete(instanceId)
  return true
}

export interface LaunchRequest {
  instanceId: string
  accountId?: string
  /** 临时直连服务器（服务器列表一键进服用，不改实例配置） */
  serverOverride?: { ip: string; port?: number }
}

/** 启动游戏 */
export async function launchInstance(
  req: LaunchRequest,
  onLog: LogFn,
  onState: StateFn
): Promise<void> {
  const instance = store.getInstance(req.instanceId)
  if (!instance) throw new Error('实例不存在')
  const account =
    store.accounts.find((a) => a.id === (req.accountId ?? store.settings.activeAccountId)) ?? store.accounts[0]
  if (!account) throw new Error('还没有账号，请在设置里添加一个离线账号')

  // 版本隔离：游戏数据目录（存档 / mods / 配置）可以按版本分开
  const gameDir = ensureGamePath(instance)
  const resourceDir = resourcePathFor(instance)
  const versionId = instance.versionId || instance.mcVersion
  const settings = store.settings

  onState({ instanceId: instance.id, state: 'preparing', message: '解析版本信息…' })

  const resolved = await Version.parse(resourceDir, versionId)
  const needMajor = resolved.javaVersion?.majorVersion ?? requiredJavaMajor(instance.mcVersion)
  // 实例里存的 javaPath 也要过一遍版本校验：老实例存了 Java 17，跑 1.21 会 UnsupportedClassVersionError
  const javaPath = await ensureJava(
    instance.mcVersion,
    instance.javaPath || settings.javaPath,
    (l) => onLog(instance.id, l),
    needMajor
  )
  onLog(instance.id, `[WFMC] 使用 Java: ${javaPath}（这个版本要 Java ${needMajor}）`)
  onLog(instance.id, `[WFMC] 游戏目录: ${gameDir}`)

  // 新实例第一次启动默认是英文界面，这里先把 lang 写成中文（已经有的不动）
  const langState = ensureGameLanguage(gameDir)
  if (langState !== 'kept') onLog(instance.id, '[WFMC] 已把游戏语言设为简体中文（options.txt）')
  onLog(
    instance.id,
    `[WFMC] 版本: ${versionId}${instance.loader !== 'vanilla' ? ` (${instance.loader} ${instance.loaderVersion ?? ''})` : ''}`
  )

  // 自己解压 natives：内置的 LaunchPrecheck.checkNatives 在当前锁定的 unzip 版本下会死锁
  const folder = new MinecraftFolder(resourceDir)
  onLog(instance.id, '[WFMC] 解压 native 库…')
  await ensureNatives(folder, resolved)

  // 原版实例里放模组是没用的：原版客户端不加载 mods 目录，得先装加载器
  if (instance.loader === 'vanilla') {
    let modCount = 0
    try {
      modCount = fs
        .readdirSync(path.join(gameDir, 'mods'))
        .filter((n) => n.endsWith('.jar') || n.endsWith('.jar.disabled')).length
    } catch {
      /* 没有 mods 目录就是 0 */
    }
    if (modCount > 0) {
      onLog(
        instance.id,
        `[WFMC] 注意：这是原版（vanilla）实例，mods 里的 ${modCount} 个模组不会被加载；要玩模组得先给这个实例装 Fabric / Forge / NeoForge 加载器。`
      )
    }
  }

  // 加载器不对的模组不会被加载，启动时说一句，别让用户对着空 mods 猜
  if (instance.loader !== 'vanilla') {
    try {
      const modsDir = path.join(gameDir, 'mods')
      const jars = fs.existsSync(modsDir)
        ? fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar'))
        : []
      if (jars.length > 0 && jars.length <= 60) {
        const { issues } = diagnoseMods(instance.id)
        const bad = issues.find((i) => i.title.startsWith('加载器不匹配'))
        if (bad) {
          onLog(instance.id, `[WFMC] 注意：${bad.detail}`)
        }
      }
    } catch {
      /* 体检失败就算了，别影响启动 */
    }
  }

  instance.lastPlayed = Date.now()
  store.saveInstance(instance)

  const proc = await launch({
    gamePath: gameDir,
    resourcePath: resourceDir,
    gameProfile: { name: account.name, id: account.uuid },
    accessToken: account.accessToken,
    userType: 'mojang',
    launcherName: LAUNCHER_NAME,
    launcherBrand: LAUNCHER_BRAND,
    javaPath,
    version: resolved,
    minMemory: instance.minMemory ?? settings.minMemory,
    maxMemory: instance.maxMemory ?? settings.maxMemory,
    extraJVMArgs: [...(settings.extraJvmArgs ?? []), ...(instance.extraJvmArgs ?? [])],
    resolution: instance.resolution
      ? {
          width: instance.resolution.width,
          height: instance.resolution.height,
          fullscreen: instance.resolution.fullscreen ? true : undefined
        }
      : undefined,
    server: req.serverOverride ?? (instance.server?.ip ? instance.server : undefined),
    // 外置登录：把 authlib-injector 当 javaagent 注进去
    yggdrasilAgent: await (async () => {
      if (account.type !== 'yggdrasil' || !account.server) return undefined
      const injector = await ensureInjector((p) => onLog(instance.id, `[WFMC] ${p.phase}`))
      onLog(instance.id, `[WFMC] 外置登录：${account.server}`)
      return { jar: injector.path, server: account.server }
    })(),
    extraExecOption: { cwd: gameDir },
    prechecks: [LaunchPrecheck.checkVersion, LaunchPrecheck.checkLibraries, LaunchPrecheck.linkAssets]
  })

  const entry: Running = { proc, startedAt: Date.now() }
  running.set(instance.id, entry)
  onState({ instanceId: instance.id, state: 'preparing', message: '游戏进程已启动，等待窗口出现…' })

  // 兜底：有些整合包/老版本不打日志，25 秒没崩就认为已运行
  const fallback = setTimeout(() => {
    if (running.get(instance.id) === entry) {
      onState({ instanceId: instance.id, state: 'running', message: '运行中' })
    }
  }, 25_000)

  const pipe = (stream: NodeJS.ReadableStream | null | undefined, prefix = '') => {
    if (!stream) return
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) onLog(instance.id, prefix + line)
    })
  }
  pipe(proc.stdout)
  pipe(proc.stderr, '[stderr] ')

  // 累计游玩时长
  const commitPlayTime = () => {
    const current = store.getInstance(instance.id)
    if (!current) return
    const delta = Date.now() - entry.startedAt
    if (delta < 1000) return
    store.saveInstance({ ...current, playTimeMs: (current.playTimeMs ?? 0) + delta })
  }

  const watcher = createMinecraftProcessWatcher(proc)
  watcher.on('minecraft-window-ready', () => {
    onLog(instance.id, '[WFMC] 游戏窗口已出现')
    onState({ instanceId: instance.id, state: 'running', message: '运行中' })
  })
  watcher.on('error', (err: Error) => {
    clearTimeout(fallback)
    running.delete(instance.id)
    onLog(instance.id, `[WFMC] 启动失败: ${err?.message ?? err}`)
    onState({ instanceId: instance.id, state: 'error', message: String(err?.message ?? err) })
  })
  watcher.on('minecraft-exit', (e: { code: number; signal: string; crashReport: string; crashReportLocation: string }) => {
    clearTimeout(fallback)
    running.delete(instance.id)
    commitPlayTime()
    if (e.crashReport) {
      onLog(instance.id, '[WFMC] 检测到崩溃报告，内容片段：')
      onLog(instance.id, e.crashReport.split('\n').slice(0, 40).join('\n'))
      if (e.crashReportLocation) onLog(instance.id, `[WFMC] 崩溃报告位置: ${e.crashReportLocation}`)
    }
    onLog(instance.id, `[WFMC] 游戏退出，代码 ${e.code}`)
    onState({ instanceId: instance.id, state: 'exited', code: e.code })
  })
}

/** 读取实例的模组 / 资源包 / 光影 / 存档 */
export function listInstanceContent(instanceId: string) {
  return {
    mods: listContent(instanceId, 'mods'),
    resourcepacks: listContent(instanceId, 'resourcepacks'),
    shaderpacks: listContent(instanceId, 'shaderpacks'),
    saves: listContent(instanceId, 'saves')
  }
}

/** 供设置页展示：实例目录大小 */
export function instanceDiskUsage(instanceId: string): number {
  const dir = store.instanceDir(instanceId)
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

export type { ContentKind }
