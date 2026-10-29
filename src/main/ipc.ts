import { BrowserWindow, app, clipboard, dialog, ipcMain, net, shell } from 'electron'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ContentKind, Instance, ProgressPayload, Settings } from '../shared/types'
import { store } from './store'
import { MultiDownloader, registerDownloader, unregisterDownloader, pauseDownload, resumeDownload, cancelDownload, downloaderState } from './fastdl'
import { friendlyJavaError, scanJava, installJavaRuntime, requiredJavaMajor } from './java'
import {
  addLoaderToInstance,
  installInstanceGame,
  listLoaderVersions,
  listLocalVersions,
  listRemoteVersions,
  repairInstance
} from './minecraft'
import { createInstance, deleteInstance, deleteVersion, duplicateInstance, instanceDetail, updateInstance } from './instances'
import { isRunning, killGame, launchInstance, listInstanceContent } from './launch'
import { accountHealth, addOfflineAccount, completeMicrosoftLogin, refreshAccount, refreshExpiringAccounts, removeAccount, startMicrosoftLogin } from './accounts'
import { installResource, listResourceVersions, planInstall, searchResources, type ResourceType } from './modrinth'
import { installCurseforgeZip, installMrpackFile, installMrpackFromUrl } from './modpack'
import {
  backupSaves,
  contentDir,
  deleteContent,
  exportInstance,
  importContent,
  importInstanceZip,
  listContent,
  listCrashReports,
  readCrashReport,
  toggleContent
} from './content'
import { exportDiagnostics, moveResourcePack, readResourcePackOrder, toggleResourcePack } from './content'
import {
  deleteDatapack,
  importDatapack,
  listDatapacks,
  listWorlds,
  toggleDatapack
} from './content'
import { checkPackUpdate } from './modpack'
import { addServer, listServers, queryServer, removeServer, updateServer } from './servers'
import { analyzeLatest } from './crash'
import { applyProxy } from './proxy'
import { listZipEntries } from './zip'
import {
  acceptEula,
  addAccessEntry,
  backupHosted,
  createHostedServer,
  deleteHosted,
  getHosted,
  hostedLogsOf,
  hostedServerDir,
  hostedStats,
  killHosted,
  countServerMods,
  createHostedFromInstance,
  importServerMods,
  parseProperties,
  patchServerProperties,
  hostedUptime,
  isHostedRunning,
  listHostedServers,
  listLoaderServerVersions,
  listPaperVersions,
  readAccessList,
  readServerProperties,
  removeAccessEntry,
  sendHostedCommand,
  startHosted,
  stopHosted,
  writeServerProperties
} from './serverhost'
import { applyModUpdate, checkModUpdates } from './modupdates'
import { ensureInjector, loginThirdParty, refreshThirdParty, listProfiles, selectProfile, lookupSkin, uploadSkin, uploadCape, clearTexture, parseInjectorCard } from './authlib'
import { decodeRoomCode, encodeRoomCode } from './rooms'
import { applyPerfPreset, deleteScreenshot, listScreenshots, PERF_PRESETS, screenshotsDir } from './shots'
import { cancelTask, clearFinishedTasks, listTasks, runTask, setTaskEmitter } from './tasks'
import { applyUpdate, checkReleases, checkUpdate, pickAsset } from './updater'
import { diagnoseMods } from './moddoctor'
import { cleanTempFiles, speedTest } from './speedtest'
import { importTracks, listTracks, musicDir, removeTrack } from './music'
import { installCurseforgeMod, searchCurseforge, testCurseforgeKey } from './curseforge'
import { buildManifest, compareEnvironment, discoverManifest, syncEnvironment } from './serversync'
import { startManifestServer } from './serversync'
import { logError, readErrors } from './errlog'
import { exportInstanceAsMrpack, inspectMrpack } from './modpackexport'
import {
  firstLanIp,
  lanList,
  lanStart,
  lanStop,
  publicEndpoint,
  tunnelStart,
  tunnelState,
  tunnelStop,
  upnpMap,
  upnpUnmap
} from './netshare'

let win: BrowserWindow | undefined

export function setMainWindow(w: BrowserWindow) {
  win = w
}

function emit(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const progress = (payload: ProgressPayload) => emit('event:progress', payload)
const log = (instanceId: string, line: string) => emit('event:launch-log', { instanceId, line })
const state = (payload: unknown) => emit('event:launch-state', payload)

/** 把 fetch 的失败原因说清楚（cause 里才有 ECONNRESET/ENOTFOUND 这些） */
function describeNetError(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } }
  const code = err?.cause?.code ? ' ' + err.cause.code : ''
  return (err?.message ?? String(e)) + code
}

export function registerIpc() {
  // ---------- 基础 ----------
  ipcMain.handle('app:info', () => ({
    version: '1.0.0',
    dataDir: store.dataDir,
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform
  }))

  ipcMain.handle('settings:get', () => store.settings)
  ipcMain.handle('settings:set', async (_e, patch: Partial<Settings>) => {
    const next = store.setSettings(patch)
    if ('proxy' in patch) await applyProxy(next.proxy)
    return next
  })

  ipcMain.handle('dialog:pick-file', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: filters ?? [{ name: '整合包', extensions: ['mrpack', 'zip'] }]
    })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle('dialog:pick-files', async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: filters ?? [{ name: '所有文件', extensions: ['*'] }]
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('dialog:pick-folder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? undefined : res.filePaths[0]
  })
  ipcMain.handle('dialog:save-text', async (_e, defaultName: string, content: string) => {
    const res = await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: '日志', extensions: ['log', 'txt'] }] })
    if (res.canceled || !res.filePath) return undefined
    fs.writeFileSync(res.filePath, content, 'utf-8')
    return res.filePath
  })
  ipcMain.handle('shell:open-path', async (_e, p: string) => {
    await shell.openPath(p)
  })
  ipcMain.handle('shell:open-external', async (_e, url: string) => {
    await shell.openExternal(url)
  })

  // ---------- Java ----------
  ipcMain.handle('java:scan', async () => await scanJava())
  ipcMain.handle('java:required-major', (_e, mcVersion: string) => requiredJavaMajor(mcVersion))
  ipcMain.handle('java:install', async (_e, component: string) => {
    // 日志里带「x / y MB」的行顺手解析成进度条的值，设置页就能看到真实进度条
    const say = (line: string) => {
      const clean = line.replace(/^\[WFMC\]\s*/, '')
      const m = /([\d.]+)\s*\/\s*([\d.]+)\s*MB/.exec(clean)
      progress({
        key: 'java-install',
        phase: clean,
        current: m ? Math.round(Number(m[1]) * 1048576) : 0,
        total: m ? Math.round(Number(m[2]) * 1048576) : 0
      })
    }
    try {
      const exe = await installJavaRuntime(component, say)
      progress({ key: 'java-install', phase: 'Java 运行时装好了', current: 0, total: 0, done: true })
      return exe
    } catch (e) {
      progress({ key: 'java-install', phase: 'Java 运行时下载失败', current: 0, total: 0, done: true })
      throw new Error(friendlyJavaError(e))
    }
  })

  // ---------- 版本 ----------
  ipcMain.handle('version:remote', async () => await listRemoteVersions())
  ipcMain.handle('version:local', (_e, instanceId: string) => listLocalVersions(store.instanceGameDir(instanceId)))
  ipcMain.handle('version:loaders', async (_e, loader: string, mcVersion: string) =>
    await listLoaderVersions(loader as never, mcVersion)
  )
  ipcMain.handle('version:delete', (_e, instanceId: string, versionId: string) => deleteVersion(instanceId, versionId))

  // ---------- 实例 ----------
  ipcMain.handle('instance:list', () => store.listInstances())
  ipcMain.handle('instance:detail', (_e, id: string) => instanceDetail(id))
  ipcMain.handle('instance:create', (_e, input: Parameters<typeof createInstance>[0]) => createInstance(input))
  ipcMain.handle('instance:update', (_e, id: string, patch: Partial<Instance>) => updateInstance(id, patch))
  ipcMain.handle('instance:delete', (_e, id: string, removeFiles: boolean) => {
    killGame(id)
    deleteInstance(id, removeFiles)
  })
  ipcMain.handle('instance:duplicate', (_e, id: string, name?: string) => duplicateInstance(id, name))
  ipcMain.handle('instance:export', (_e, id: string) => exportInstance(id))
  ipcMain.handle('instance:content', (_e, id: string) => listInstanceContent(id))
  // 给已有实例补装加载器（内容管理提示「先去实例装 Fabric / Forge」点了就能直达这里）
  ipcMain.handle('instance:install-loader', async (_e, id: string, loader: string, loaderVersion: string) => {
    const instance = store.getInstance(id)
    if (!instance) throw new Error('实例不存在')
    const label = loader === 'neoforge' ? 'NeoForge' : loader === 'fabric' ? 'Fabric' : loader === 'quilt' ? 'Quilt' : 'Forge'
    return await runTask('install', `给 ${instance.name} 装 ${label} ${loaderVersion}`, async (ctx) =>
      addLoaderToInstance(id, loader as never, loaderVersion, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  })
  ipcMain.handle('instance:open-folder', async (_e, id: string) => {
    await shell.openPath(store.instanceGameDir(id))
  })

  // ---------- 内容管理（模组/资源包/光影/存档） ----------
  ipcMain.handle('content:list', (_e, instanceId: string, kind: ContentKind) => listContent(instanceId, kind))
  ipcMain.handle('content:toggle', (_e, instanceId: string, target: string) => toggleContent(instanceId, target))
  ipcMain.handle('content:delete', (_e, instanceId: string, target: string) => deleteContent(instanceId, target))
  ipcMain.handle('content:import', async (_e, instanceId: string, kind: ContentKind) => {
    const res = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    if (res.canceled || res.filePaths.length === 0) return undefined
    return importContent(instanceId, kind, res.filePaths)
  })
  ipcMain.handle('content:open', async (_e, instanceId: string, kind: ContentKind) => {
    await shell.openPath(contentDir(instanceId, kind))
  })
  ipcMain.handle('saves:backup', (_e, instanceId: string) => backupSaves(instanceId))
  ipcMain.handle('crash:list', (_e, instanceId: string) => listCrashReports(instanceId))
  ipcMain.handle('crash:read', (_e, instanceId: string, target: string) => readCrashReport(instanceId, target))
  ipcMain.handle('crash:diagnose', (_e, instanceId: string) => analyzeLatest(instanceId))

  // ---------- 服务器列表 / 联机 ----------
  ipcMain.handle('server:list', () => listServers())
  ipcMain.handle('server:add', (_e, input: { name?: string; address: string; port?: number; note?: string }) =>
    addServer(input)
  )
  ipcMain.handle('server:update', (_e, id: string, patch: Record<string, unknown>) => updateServer(id, patch as never))
  ipcMain.handle('server:remove', (_e, id: string) => removeServer(id))
  ipcMain.handle('server:ping', async (_e, address: string, port?: number) => await queryServer(address, port))
  ipcMain.handle('server:join', async (_e, instanceId: string, address: string, port?: number) => {
    const account = store.accounts[0]
    if (!account) throw new Error('还没有账号，请先在设置里添加')
    if (account.type === 'microsoft') await refreshAccount(account.id)
    const [host, inlinePort] = address.split(':')
    await launchInstance(
      {
        instanceId,
        accountId: account.id,
        serverOverride: { ip: host, port: port ?? (inlinePort ? Number(inlinePort) : undefined) }
      },
      log,
      state
    )
    return true
  })

  // ---------- 安装 / 启动 ----------
  ipcMain.handle('game:install', async (_e, instanceId: string) => {
    const instance = store.getInstance(instanceId)
    if (!instance) throw new Error('实例不存在')
    return await runTask('install', `安装 ${instance.name}（${instance.mcVersion}）`, async (ctx) =>
      installInstanceGame(
        instance,
        (p) => {
          progress({ ...p, taskId: ctx.id })
          ctx.report({ phase: p.phase, current: p.current, total: p.total })
        },
        { signal: ctx.signal }
      )
    )
  })
  ipcMain.handle('game:repair', async (_e, instanceId: string) => {
    const instance = store.getInstance(instanceId)
    return await runTask('install', `校验文件 ${instance?.name ?? instanceId}`, async (ctx) =>
      repairInstance(instanceId, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  })
  ipcMain.handle('game:launch', async (_e, instanceId: string) => {
    const account = store.activeAccount
    if (account?.type === 'microsoft') await refreshAccount(account.id)
    if (account?.type === 'yggdrasil') await refreshThirdParty(account)
    await launchInstance({ instanceId, accountId: account?.id }, log, state)
    return true
  })
  ipcMain.handle('game:kill', (_e, instanceId: string) => killGame(instanceId))
  ipcMain.handle('game:running', (_e, instanceId: string) => isRunning(instanceId))

  // ---------- 账号 ----------
  ipcMain.handle('account:list', () => store.accounts)
  ipcMain.handle('account:health', () => accountHealth())
  ipcMain.handle('account:refresh-expiring', async () => await refreshExpiringAccounts())
  ipcMain.handle('account:add-offline', (_e, name: string) => addOfflineAccount(name))
  ipcMain.handle('account:remove', (_e, id: string) => removeAccount(id))
  ipcMain.handle('account:set-active', (_e, id: string) => store.setSettings({ activeAccountId: id }))
  ipcMain.handle('account:login-yggdrasil', async (_e, input: { apiRoot: string; username: string; password: string }) =>
    await loginThirdParty(input)
  )
  ipcMain.handle('account:profiles', async (_e, accountId: string) => await listProfiles(accountId))
  ipcMain.handle('account:select-profile', async (_e, accountId: string, profile: { id: string; name: string }) =>
    await selectProfile(accountId, profile)
  )
  ipcMain.handle('injector:ensure', async () => await ensureInjector())
  ipcMain.handle('injector:parse-card', (_e, text: string) => parseInjectorCard(text))
  // 拖拽失败时的兜底：从剪贴板读卡片链接
  ipcMain.handle('injector:from-clipboard', () => {
    const text = clipboard.readText()
    const parsed = parseInjectorCard(text)
    if (parsed) return parsed
    const url = /https?:\/\/[^\s"']+/i.exec(text)?.[0]
    return url
  })
  ipcMain.handle('skin:fetch-texture', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('地址不对：' + url)
    let buf: Buffer | undefined
    const errors: string[] = []

    // 先走 Electron 的网络栈（跟浏览器一致，系统代理/证书都吃得到）
    try {
      const res = await net.fetch(url, { signal: AbortSignal.timeout(12000) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      buf = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      errors.push('chromium: ' + describeNetError(e))
    }

    // 不行再用 Node fetch 试一次
    if (!buf) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(12000) })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        buf = Buffer.from(await res.arrayBuffer())
      } catch (e) {
        errors.push('node: ' + describeNetError(e))
      }
    }

    if (!buf) throw new Error(errors.join(' / '))
    if (buf.length > 2 * 1024 * 1024) throw new Error('贴图太大（' + buf.length + ' 字节）')
    const type = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png' : 'image/jpeg'
    return 'data:' + type + ';base64,' + buf.toString('base64')
  })
  ipcMain.handle('skin:lookup', async (_e, accountId: string, uuid?: string) => await lookupSkin(accountId, uuid))
  ipcMain.handle('skin:upload', async (_e, accountId: string, filePath: string, model: 'slim' | 'steve') =>
    await uploadSkin(accountId, filePath, model)
  )
  ipcMain.handle('skin:upload-cape', async (_e, accountId: string, filePath: string) =>
    await uploadCape(accountId, filePath)
  )
  ipcMain.handle('skin:clear', async (_e, accountId: string, type: 'skin' | 'cape') =>
    await clearTexture(accountId, type)
  )
  ipcMain.handle('account:ms-start', async () => await startMicrosoftLogin())
  ipcMain.handle('account:ms-complete', async (_e, deviceCode: string, interval: number, expiresIn: number) =>
    await completeMicrosoftLogin(deviceCode, interval, expiresIn)
  )

  // ---------- 资源中心 ----------
  ipcMain.handle('resource:search', async (_e, params: Parameters<typeof searchResources>[0]) =>
    await searchResources(params)
  )
  ipcMain.handle('resource:versions', async (_e, projectId: string, opts) => await listResourceVersions(projectId, opts))
  // 装之前算清单：主文件 + 必需前置 + 可选 + 冲突
  ipcMain.handle(
    'resource:plan',
    async (_e, instanceId: string, type: ResourceType, projectId: string, versionId?: string) =>
      await planInstall(instanceId, type, projectId, versionId)
  )
  ipcMain.handle(
    'resource:install',
    async (
      _e,
      instanceId: string,
      type: ResourceType,
      projectId: string,
      versionId?: string,
      includeOptional: string[] = []
    ) => {
      const instance = store.getInstance(instanceId)
      return await runTask('resource', `安装资源到 ${instance?.name ?? instanceId}`, async (ctx) =>
        installResource(
          instanceId,
          type,
          projectId,
          versionId,
          (p) => {
            progress({ ...p, taskId: ctx.id })
            ctx.report({ phase: p.phase, current: p.current, total: p.total })
          },
          {
            includeOptional,
            onItem: (title, state, detail) => {
              const tag =
                state === 'start' ? '正在装' : state === 'done' ? '已装' : state === 'skip' ? '已有' : '失败'
              ctx.report({ phase: `${tag} ${title}${detail ? ' · ' + detail : ''}` })
            }
          }
        )
      )
    }
  )

  // ---------- 整合包 ----------
  ipcMain.handle('modpack:install-file', async (_e, filePath: string, name?: string) => {
    const ext = path.extname(filePath).toLowerCase()
    return await runTask('modpack', `安装整合包 ${name ?? path.basename(filePath)}`, async (ctx) => {
      const onProgress = (p: Parameters<typeof progress>[0]) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      }
      if (ext === '.mrpack') return await installMrpackFile(filePath, name, onProgress)
      if (ext === '.zip') return await installCurseforgeZip(filePath, name, onProgress)
      throw new Error('只支持 .mrpack 或 .zip 整合包')
    })
  })
  ipcMain.handle('modpack:install-url', async (_e, url: string, name: string) =>
    await runTask('modpack', `安装整合包 ${name}`, async (ctx) =>
      installMrpackFromUrl(url, name, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  )

  // ---------- 后台任务队列 ----------
  setTaskEmitter((task) => emit('event:task', task))
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:cancel', (_e, id: string) => cancelTask(id))
  ipcMain.handle('tasks:clear', () => clearFinishedTasks())

  // ---------- 错误日志 ----------
  ipcMain.handle('app:report-error', (_e, scope: string, message: string, detail?: string) => {
    logError(`renderer:${scope}`, message, detail)
    return true
  })
  ipcMain.handle('app:read-errors', () => readErrors())

  // ---------- CurseForge ----------
  ipcMain.handle('cf:test-key', async (_e, key: string) => await testCurseforgeKey(key))
  ipcMain.handle('cf:search', async (_e, input: { query: string; mcVersion?: string; loader?: string }) =>
    await searchCurseforge(input)
  )
  ipcMain.handle('cf:install', async (_e, instanceId: string, modId: number) =>
    await runTask('resource', `安装 CF 模组 #${modId}`, async (ctx) =>
      installCurseforgeMod(instanceId, modId, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  )

  // ---------- 音乐播放器 ----------
  ipcMain.handle('music:list', () => listTracks())
  ipcMain.handle('music:import', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频', extensions: ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'aac'] }]
    })
    if (res.canceled) return listTracks()
    return importTracks(res.filePaths)
  })
  ipcMain.handle('music:remove', (_e, name: string) => removeTrack(name))
  ipcMain.handle('music:open-dir', async () => {
    await shell.openPath(musicDir())
  })

  // ---------- 数据包 ----------
  ipcMain.handle('content:worlds', (_e, instanceId: string) => listWorlds(instanceId))
  ipcMain.handle('content:datapacks', (_e, instanceId: string, world: string) => listDatapacks(instanceId, world))
  ipcMain.handle('content:datapack-import', async (_e, instanceId: string, world: string) => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '数据包', extensions: ['zip', 'jar'] }]
    })
    if (res.canceled) return listDatapacks(instanceId, world)
    return importDatapack(instanceId, world, res.filePaths)
  })
  ipcMain.handle('content:datapack-toggle', (_e, instanceId: string, world: string, name: string) =>
    toggleDatapack(instanceId, world, name)
  )
  ipcMain.handle('content:datapack-delete', (_e, instanceId: string, world: string, name: string) =>
    deleteDatapack(instanceId, world, name)
  )

  // ---------- 资源包排序 / 诊断包 / 测速 ----------
  ipcMain.handle('content:pack-order', (_e, instanceId: string) => readResourcePackOrder(instanceId))
  ipcMain.handle('content:pack-move', (_e, instanceId: string, name: string, dir: -1 | 1) =>
    moveResourcePack(instanceId, name, dir)
  )
  ipcMain.handle('content:pack-toggle', (_e, instanceId: string, name: string, enabled: boolean) =>
    toggleResourcePack(instanceId, name, enabled)
  )
  ipcMain.handle('content:export-diagnostics', (_e, instanceId: string) => exportDiagnostics(instanceId))
  ipcMain.handle('net:speedtest', async () => await speedTest())
  /** 安装版才有卸载器：exe 同目录的 "Uninstall *.exe" */
  /** 贴链接直接下载（多线程 + 可暂停），存到 <dataDir>/downloads */
  ipcMain.handle('dl:start-url', async (_e, url: string) => {
    const raw = String(url || '').trim()
    if (!/^https?:\/\//i.test(raw)) throw new Error('请粘贴 http/https 开头的下载链接')
    let name = 'download.bin'
    try {
      const u = new URL(raw)
      name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'download.bin')
      if (!/\.[a-z0-9]{2,6}$/i.test(name)) name += '.bin'
    } catch {
      throw new Error('链接格式不对')
    }
    const dir = store.settings.downloadDir?.trim() || path.join(store.settings.dataDir, 'downloads')
    await fs.promises.mkdir(dir, { recursive: true })
    const dest = path.join(dir, name)
    const key = 'url:' + name
    // 先 HEAD 拿大小，进度条才有比例
    let fileSize = 0
    try {
      const head = await fetch(raw, { method: 'HEAD' })
      fileSize = Number(head.headers.get('content-length') ?? 0) || 0
    } catch {
      fileSize = 0
    }
    const meter = { bytes: 0, last: Date.now(), at: 0, speed: 0 }
    const fmtSpeed = () => (meter.speed / 1024 / 1024).toFixed(2) + ' MB/s'
    const dl = new MultiDownloader({
      threads: store.settings.downloadThreads ?? 48,
      chunks: 8,
      onBytes: (d: number) => {
        meter.bytes += d
        const now = Date.now()
        if (now - meter.last >= 700) {
          meter.speed = ((meter.bytes - meter.at) * 1000) / (now - meter.last)
          meter.at = meter.bytes
          meter.last = now
        }
      }
    })
    registerDownloader(key, dl)
    void (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        progress({ key, phase: '下载 ' + name, current: 0, total: fileSize || 1 })
        timer = setInterval(() => {
          // 取消后定时器不能再发进度，否则刚删掉的卡片又被加回来（闪一下又出现）
          if (dl.isCanceled) return
          if (dl.isPaused) {
            progress({
              key,
              phase: '已暂停 ' + name + '（' + (dl.downloaded / 1024 / 1024).toFixed(1) + ' MB）',
              current: dl.downloaded,
              total: fileSize || dl.downloaded || 1
            })
            return
          }
          progress({
            key,
            phase:
              '下载 ' +
              name +
              '（' +
              (dl.downloaded / 1024 / 1024).toFixed(1) +
              (fileSize ? ' / ' + (fileSize / 1024 / 1024).toFixed(1) : '') +
              ' MB · ' +
              fmtSpeed() +
              '）',
            current: dl.downloaded,
            total: fileSize || dl.downloaded || 1
          })
        }, 500)
        const errs = await dl.downloadAll(
          [{ urls: [raw], dest, size: fileSize || undefined }],
          () =>
            progress({
              key,
              phase:
                '下载 ' +
                name +
                '（' +
                (dl.downloaded / 1024 / 1024).toFixed(1) +
                (fileSize ? ' / ' + (fileSize / 1024 / 1024).toFixed(1) : '') +
                ' MB · ' +
                fmtSpeed() +
                '）',
              current: dl.downloaded,
              total: fileSize || 0
            })
        )
        // 取消的情况 dl:cancel 已经报过 done，这里别再改文案
        if (dl.isCanceled) return
        progress({
          key,
          phase: errs.length ? '下载失败：' + (errs[0].split('\u0000')[1] ?? '未知错误') : '下载完成 ' + name,
          current: 1,
          total: 1,
          done: true
        })
      } catch (e) {
        if (dl.isCanceled) return
        progress({ key, phase: '下载失败：' + (e as Error).message, current: 1, total: 1, done: true })
      } finally {
        clearInterval(timer)
        unregisterDownloader(key)
      }
    })()
    return { key, dest, name }
  })
  ipcMain.handle('dl:pause', (_e, key: string) => pauseDownload(key))
  ipcMain.handle('dl:resume', (_e, key: string) => resumeDownload(key))
  ipcMain.handle('dl:cancel', (_e, key: string) => {
    const ok = cancelDownload(key)
    // 补一条完成的进度（done），界面才会真的把这张卡片收掉
    if (ok) progress({ key, phase: '已取消', current: 1, total: 1, done: true })
    return ok
  })
  ipcMain.handle('dl:state', (_e, key: string) => downloaderState(key))
  ipcMain.handle('app:uninstaller', () => {
    const dir = path.dirname(process.execPath)
    try {
      const name = fs.readdirSync(dir).find((n) => /^Uninstall .*\.exe$/i.test(n))
      return name ? path.join(dir, name) : undefined
    } catch {
      return undefined
    }
  })
  ipcMain.handle('app:run-uninstaller', async () => {
    const dir = path.dirname(process.execPath)
    const name = fs.readdirSync(dir).find((n) => /^Uninstall .*\.exe$/i.test(n))
    if (!name) throw new Error('当前是便携版，没有卸载器；直接删掉 exe 和旁边的 WFMC-Data 即可')
    spawn(path.join(dir, name), [], { detached: true, stdio: 'ignore' }).unref()
    setTimeout(() => app.quit(), 800)
    return true
  })
  ipcMain.handle('app:clean-temp', () => cleanTempFiles(store.dataDir))

  // ---------- 自动更新 ----------
  ipcMain.handle('update:check', async () => await checkUpdate())
  ipcMain.handle('update:releases', async () => await checkReleases())
  ipcMain.handle('update:apply-asset', async (_e, url: string) => await applyUpdate(url, progress))
  ipcMain.handle('update:apply-release', async (_e, release: Parameters<typeof pickAsset>[0]) => {
    const asset = pickAsset(release)
    if (!asset) throw new Error('这个版本没有可下载的安装包')
    return await applyUpdate(asset.url, progress)
  })
  ipcMain.handle('update:apply', async (_e, url: string) => await applyUpdate(url, progress))
  ipcMain.handle('app:version', () => app.getVersion())

  // ---------- Mod 体检 / 整合包导出 ----------
  ipcMain.handle('mods:diagnose', (_e, instanceId: string) => diagnoseMods(instanceId))
  ipcMain.handle('modpack:export-mrpack', async (_e, instanceId: string) =>
    await runTask('modpack', '导出整合包 (.mrpack)', async (ctx) =>
      exportInstanceAsMrpack(instanceId, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  )
  ipcMain.handle('modpack:inspect', (_e, file: string) => inspectMrpack(file))
  ipcMain.handle('modpack:check-update', async (_e, instanceId: string) => await checkPackUpdate(instanceId))

  // ---------- 拖拽安装 ----------
  ipcMain.handle('drop:handle', async (_e, instanceId: string | undefined, paths: string[]) => {
    const done: string[] = []
    const failed: string[] = []
    for (const file of paths) {
      const ext = path.extname(file).toLowerCase()
      try {
        if (ext === '.mrpack') {
          const id = await installMrpackFile(file, undefined, progress)
          done.push(`整合包已安装 → ${id}`)
        } else if (ext === '.zip') {
          const buf = fs.readFileSync(file)
          const names = listZipEntries(buf).map((en) => en.name)
          const isInstance = names.some((n) => n === 'instance.json' || n.endsWith('/instance.json'))
          const isCf = names.includes('manifest.json')
          if (isInstance) {
            const inst = importInstanceZip(file)
            done.push(`实例已导入 → ${inst.name}`)
          } else if (isCf) {
            const id = await installCurseforgeZip(file, undefined, progress)
            done.push(`CF 整合包已安装 → ${id}`)
          } else {
            failed.push(`${path.basename(file)}：这个 zip 既不是实例包也不是整合包`)
          }
        } else if (ext === '.jar') {
          if (!instanceId) {
            failed.push(`${path.basename(file)}：先选一个实例再拖 mod`)
            continue
          }
          importContent(instanceId, 'mods', [file])
          done.push(`模组已放入 mods：${path.basename(file)}`)
        } else {
          failed.push(`${path.basename(file)}：只认 .mrpack / .zip / .jar`)
        }
      } catch (err) {
        failed.push(`${path.basename(file)}：${(err as Error).message}`)
      }
    }
    return { done, failed }
  })

  // ---------- 杂项 ----------
  ipcMain.handle('fs:list-dir', (_e, p: string) => {
    try {
      return fs.readdirSync(p).map((n) => ({ name: n, isDir: fs.statSync(path.join(p, n)).isDirectory() }))
    } catch {
      return []
    }
  })

  // ---------- 一键开服 ----------
  ipcMain.handle('hosted:list', () => listHostedServers())
  ipcMain.handle('hosted:paper-versions', async () => await listPaperVersions())
  ipcMain.handle('hosted:create', async (_e, input: Parameters<typeof createHostedServer>[0]) =>
    await runTask('server', `创建服务端 ${input.name || input.kind + ' ' + input.mcVersion}`, async (ctx) =>
      createHostedServer(input, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  )
  ipcMain.handle('hosted:start', async (_e, id: string) => {
    await startHosted(
      id,
      (sid, line) => emit('event:host-log', { id: sid, line }),
      (sid, code) => emit('event:host-exit', { id: sid, code })
    )
    return true
  })
  ipcMain.handle('hosted:stop', (_e, id: string) => stopHosted(id))
  ipcMain.handle('hosted:kill', (_e, id: string) => killHosted(id))
  ipcMain.handle('hosted:command', (_e, id: string, command: string) => sendHostedCommand(id, command))
  ipcMain.handle('hosted:logs', (_e, id: string) => hostedLogsOf(id))
  ipcMain.handle('hosted:status', (_e, id: string) => ({
    running: isHostedRunning(id),
    uptime: hostedUptime(id),
    server: getHosted(id)
  }))
  ipcMain.handle('hosted:props', (_e, id: string) => readServerProperties(id))
  ipcMain.handle('hosted:props-json', (_e, id: string) => parseProperties(readServerProperties(id)))
  ipcMain.handle('hosted:patch-props', (_e, id: string, patch: Record<string, string>) =>
    patchServerProperties(id, patch)
  )
  ipcMain.handle('hosted:set-props', (_e, id: string, content: string) => writeServerProperties(id, content))
  ipcMain.handle('hosted:eula', (_e, id: string) => acceptEula(id))
  ipcMain.handle('hosted:delete', (_e, id: string) => deleteHosted(id))
  ipcMain.handle('hosted:open-dir', async (_e, id: string) => {
    await shell.openPath(hostedServerDir(id))
  })
  ipcMain.handle('hosted:loader-versions', async (_e, kind: 'fabric' | 'forge' | 'neoforge', mc: string) =>
    await listLoaderServerVersions(kind, mc)
  )
  ipcMain.handle('hosted:access-list', (_e, id: string, type: 'whitelist' | 'ops') => readAccessList(id, type))
  ipcMain.handle('hosted:access-add', (_e, id: string, type: 'whitelist' | 'ops', name: string) =>
    addAccessEntry(id, type, name)
  )
  ipcMain.handle('hosted:access-remove', (_e, id: string, type: 'whitelist' | 'ops', name: string) =>
    removeAccessEntry(id, type, name)
  )
  ipcMain.handle('hosted:backup', (_e, id: string) => backupHosted(id))
  ipcMain.handle('hosted:stats', (_e, id: string) => hostedStats(id))
  ipcMain.handle('hosted:mods-count', (_e, id: string) => countServerMods(id))
  ipcMain.handle('hosted:manifest', async (_e, id: string) => {
    const info = await startManifestServer(id)
    return { ...info, manifest: buildManifest(id) }
  })

  // ---------- 进服前环境检查 / 自动补齐 ----------
  ipcMain.handle('serversync:check', async (_e, instanceId: string, host: string, gamePort: number) => {
    const found = await discoverManifest(host, gamePort)
    if (!found) return { reachable: false, missing: [], extra: [] }
    return compareEnvironment(instanceId, found.manifest, found.base)
  })
  ipcMain.handle('serversync:apply', async (_e, instanceId: string, diff: Parameters<typeof syncEnvironment>[1]) =>
    await runTask('mods', '补齐服务器模组', async (ctx) =>
      syncEnvironment(instanceId, diff, (p) => {
        progress({ ...p, taskId: ctx.id })
        ctx.report({ phase: p.phase, current: p.current, total: p.total })
      })
    )
  )
  ipcMain.handle(
    'hosted:create-from-instance',
    async (_e, instanceId: string, opts: { name?: string; memoryMb?: number; port?: number }) =>
      await runTask('server', '照实例开服（含 mod）', async (ctx) =>
        createHostedFromInstance(instanceId, opts, (p) => {
          progress({ ...p, taskId: ctx.id })
          ctx.report({ phase: p.phase, current: p.current, total: p.total })
        })
      )
  )
  ipcMain.handle(
    'hosted:import-mods',
    async (_e, id: string, source: { instanceId?: string; packFile?: string }) =>
      await runTask('server', '导入服务端模组', async (ctx) =>
        importServerMods(id, source, (p) => {
          progress({ ...p, taskId: ctx.id })
          ctx.report({ phase: p.phase, current: p.current, total: p.total })
        })
      )
  )

  // ---------- Mod 更新检查 ----------
  ipcMain.handle('mods:updates', async (_e, instanceId: string) => await checkModUpdates(instanceId, progress))
  ipcMain.handle(
    'mods:apply',
    async (_e, instanceId: string, input: { path: string; url: string; filename: string }) =>
      await applyModUpdate(instanceId, input, progress)
  )

  // ---------- 局域网 / P2P / 内网穿透 ----------
  ipcMain.handle('lan:start', () => lanStart())
  ipcMain.handle('lan:list', () => lanList())
  ipcMain.handle('lan:stop', () => {
    lanStop()
    return true
  })
  ipcMain.handle('net:lan-ip', () => firstLanIp())
  ipcMain.handle('net:public', async () => (await publicEndpoint()) ?? null)
  ipcMain.handle('net:upnp', async (_e, port: number) => await upnpMap(port))
  ipcMain.handle('net:unupnp', async (_e, port: number) => {
    await upnpUnmap(port)
    return true
  })
  ipcMain.handle('tunnel:start', async (_e, port: number) => await tunnelStart(port))
  ipcMain.handle('tunnel:state', () => tunnelState())
  ipcMain.handle('tunnel:stop', () => {
    tunnelStop()
    return true
  })

  // ---------- 联机房间码 ----------
  ipcMain.handle('room:encode', (_e, host: string, port: number) => encodeRoomCode(host, port))
  ipcMain.handle('room:decode', (_e, code: string) => decodeRoomCode(code))

  // ---------- 截图 ----------
  ipcMain.handle('shots:list', (_e, instanceId: string) => listScreenshots(instanceId))
  ipcMain.handle('shots:delete', (_e, instanceId: string, target: string) => deleteScreenshot(instanceId, target))
  ipcMain.handle('shots:open-dir', async (_e, instanceId: string) => {
    await shell.openPath(screenshotsDir(instanceId))
  })

  // ---------- 性能预设 ----------
  ipcMain.handle('preset:list', () => PERF_PRESETS)
  ipcMain.handle('preset:apply', (_e, instanceId: string, presetId: string) =>
    applyPerfPreset(instanceId, presetId as never)
  )

  // ---------- 实例导入 ----------
  ipcMain.handle('instance:import-zip', async (_e, zipPath: string) => importInstanceZip(zipPath))
  ipcMain.handle('instance:pick-import', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '实例包', extensions: ['zip'] }] })
    if (res.canceled || !res.filePaths[0]) return undefined
    return importInstanceZip(res.filePaths[0])
  })
}
