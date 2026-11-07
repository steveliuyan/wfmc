import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { Version, launch, createMinecraftProcessWatcher, MinecraftFolder, LaunchPrecheck } from '@xmcl/core'
import type { ContentKind, Instance, LaunchStatePayload } from '../shared/types'
import { store } from './store'
import { ensureJava, requiredJavaMajor } from './java'
import { ensureGameLanguage } from './options'
import { ensureNatives } from './natives'
import { loaderTargetVersionId } from './minecraft'
import { backupSaves, listContent, pruneSaveBackups } from './content'
import { ensureGamePath, resourcePathFor } from './paths'
import { ensureInjector } from './authlib'
import { diagnoseMods } from './moddoctor'
import { startInstanceManifest, stopInstanceManifest } from './serversync'
import { clearMyLanPort, firstLanIp, noteMyLanPort } from './netshare'

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

/**
 * 启动用哪个版本 id。
 *
 * instance.versionId 正常应该已经指向带加载器的那份（fabric-loader-0.18.2-1.20.1）。
 * 但早期版本导入整合包时会把 versionId 写回原版，于是「模组装了满屏，进去只有原版物品」。
 * 这里不信任存的值，按磁盘实际存在的版本重新认一遍：
 *   1. 存的版本 json 在、而且不是原版名 → 就用它（用户手动切过加载器/版本也照办）
 *   2. 加载器版本按 loader + loaderVersion 算得出来、且装好了 → 用它
 *   3. 退回原版
 */
export function resolveLaunchVersionId(instance: Instance, resourceDir: string): string {
  const installed = (id?: string) =>
    !!id && fs.existsSync(path.join(resourceDir, 'versions', id, `${id}.json`))
  const saved = instance.versionId || instance.mcVersion
  const want =
    instance.loader !== 'vanilla' && instance.loaderVersion
      ? loaderTargetVersionId(instance.loader, instance.mcVersion, instance.loaderVersion)
      : ''

  if (saved !== instance.mcVersion && installed(saved)) return saved
  if (want && installed(want)) return want
  if (installed(instance.mcVersion)) return instance.mcVersion
  return saved
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
  const wanted = instance.versionId || instance.mcVersion
  const versionId = resolveLaunchVersionId(instance, resourceDir)
  if (versionId !== wanted) {
    // 顺手把实例里存错的版本改回来，免得「内容管理」里显示的版本和实际启动的对不上
    try {
      store.saveInstance({ ...instance, versionId })
    } catch {
      /* 写不进去也照样启动 */
    }
    onLog(
      instance.id,
      `[WFMC] 实例里存的版本是 ${wanted}，但${instance.loader !== 'vanilla' ? ` ${instance.loader} ${instance.loaderVersion ?? ''}` : ''} 装的是 ${versionId}，已按后者启动（模组才会加载）`
    )
  }
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
  // 启动前自动打一份存档快照：游戏崩了/世界废了还能回滚（设置里可关）
  if (settings.autoBackupSaves !== false) {
    try {
      const savesDir = path.join(gameDir, 'saves')
      const hasSaves = fs.existsSync(savesDir) && fs.readdirSync(savesDir).length > 0
      if (hasSaves) {
        const bk = backupSaves(instance.id)
        if (bk) {
          pruneSaveBackups(instance.id)
          onLog(
            instance.id,
            `[WFMC] 启动前已备份存档：${path.basename(bk.file)}（${bk.worlds.length} 个世界 / ${bk.files} 个文件）`
          )
        }
      }
    } catch (e) {
      onLog(instance.id, `[WFMC] 存档备份失败（不影响启动）：${e instanceof Error ? e.message : String(e)}`)
    }
  }
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
        // 缺前置 / 前置被禁用：游戏里只会弹一句「模组不兼容」，这里提前说清楚
        const dep = issues.find((i) => (i.enableFiles && i.enableFiles.length > 0) || i.fixDep)
        if (dep) {
          onLog(instance.id, `[WFMC] 注意：${dep.title}（到「内容管理 → 体检模组」可以一键处理）`)
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

  // 游戏里点了「对局域网开放」→ 顺手把本实例的模组清单也发出去，
  // 好友在联机页就能看到版本/加载器，点「进入」还能自动补齐 mod。
  let publishedLanPort = 0
  const maybePublishLanManifest = (line: string) => {
    const m = /Local game hosted on port (\d{1,5})/i.exec(line)
    if (!m) return
    const lanPort = Number(m[1])
    if (!lanPort || lanPort === publishedLanPort) return
    publishedLanPort = lanPort
    // 记下来：联机页据此把「要共享的端口」自动填成玩家自己设的那个（不一定是 25565）
    noteMyLanPort(instance.id, lanPort)
    stopInstanceManifest(instance.id)
    void startInstanceManifest(instance.id, lanPort + 1).then((info) => {
      if (!info) {
        onLog(instance.id, '[WFMC] 端口全被占用，没能共享模组清单（好友需要自己对齐 mod）')
        return
      }
      const ip = firstLanIp()
      onLog(
        instance.id,
        `[WFMC] 已共享模组清单：${ip || '<你的内网IP>'}:${info.port}（${info.mods} 个 mod）—— 好友用 WFMC 进服会自动补齐 mod`
      )
    })
  }

  const pipe = (stream: NodeJS.ReadableStream | null | undefined, prefix = '') => {
    if (!stream) return
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        onLog(instance.id, prefix + line)
        maybePublishLanManifest(line)
      }
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
    stopInstanceManifest(instance.id)
    clearMyLanPort(instance.id)
    onLog(instance.id, `[WFMC] 启动失败: ${err?.message ?? err}`)
    onState({ instanceId: instance.id, state: 'error', message: String(err?.message ?? err) })
  })
  watcher.on('minecraft-exit', (e: { code: number; signal: string; crashReport: string; crashReportLocation: string }) => {
    clearTimeout(fallback)
    running.delete(instance.id)
    stopInstanceManifest(instance.id)
    clearMyLanPort(instance.id)
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
