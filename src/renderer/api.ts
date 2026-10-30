import type {
  Account,
  ContentItem,
  ContentKind,
  CrashDiagnosis,
  CrashReport,
  Instance,
  InstallPlan,
  JavaInfo,
  LaunchStatePayload,
  LoaderOption,
  PlanInstallResult,
  ProgressPayload,
  RemoteVersion,
  ResourceHit,
  ResourceVersion,
  SavedServer,
  ServerStatus,
  Settings,
  ThemeMode,
  WorldPackCheck,
  WorldPackResult,
  WorldRestoreResult
} from '../shared/types'

const bridge = (
  window as unknown as {
    launcher: {
      invoke: <T>(c: string, ...a: unknown[]) => Promise<T>
      on: (c: string, cb: (p: any) => void) => () => void
      pathOfFile: (f: File) => string
    }
  }
).launcher

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return bridge.invoke<T>(channel, ...args)
}

export interface InstanceDetail extends Instance {
  gameDir: string
  versions: string[]
  diskUsage: number
  counts: { mods: number; resourcepacks: number; shaderpacks: number; saves: number }
}

export interface HostedServer {
  id: string
  name: string
  kind: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge'
  mcVersion: string
  build?: number
  memoryMb: number
  port: number
  eulaAccepted: boolean
  createdAt: number
  jarFile: string
  loaderVersion?: string
}

export interface AccessEntry {
  uuid: string
  name: string
  level?: number
}

export interface LanWorld {
  motd: string
  port: number
  address: string
  lastSeen: number
}

export interface TunnelState {
  running: boolean
  localPort?: number
  publicAddress?: string
  logs: string[]
  error?: string
}

export interface UpnpResult {
  ok: boolean
  externalIp?: string
  externalPort?: number
  message: string
}

export interface ReleaseAsset {
  name: string
  size: number
  url: string
}

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  notes: string
  publishedAt: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

export interface ReleaseCheck {
  current: string
  hasUpdate: boolean
  latest?: ReleaseInfo
  history: ReleaseInfo[]
  source: 'github' | 'json' | 'none'
  error?: string
}

export interface AccountHealth {
  id: string
  name: string
  type: 'offline' | 'microsoft' | 'yggdrasil'
  remainingMs?: number
  needsRefresh: boolean
  expired: boolean
}

export interface ModRef {
  file: string
  sha1: string
  size: number
}

export interface ServerManifest {
  name: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  gamePort: number
  mods: ModRef[]
  at: number
  base?: string
}

export interface EnvDiff {
  reachable: boolean
  manifest?: ServerManifest
  base?: string
  missing: ModRef[]
  extra: string[]
  versionMismatch?: { server: string; client: string }
  loaderMismatch?: { server: string; client: string }
}

export interface TaskInfo {
  id: string
  kind: string
  title: string
  status: 'running' | 'done' | 'error' | 'canceled'
  phase?: string
  current?: number
  total?: number
  error?: string
  createdAt: number
  finishedAt?: number
}

export interface UpdateInfo {
  current: string
  latest?: string
  url?: string
  notes?: string
  hasUpdate: boolean
  error?: string
}

export interface ModIssue {
  level: 'error' | 'warn' | 'info'
  title: string
  detail: string
  files?: string[]
  fixLoader?: 'fabric' | 'forge' | 'neoforge' | 'quilt'
  /** 缺的前置 modid，可直接一键装 */
  fixDep?: string
  depRange?: string
}

export interface ModUpdateItem {  file: string
  path: string
  hash: string
  latestVersionNumber?: string
  latestFileName?: string
  downloadUrl?: string
  gameVersions?: string[]
  loaders?: string[]
  updateAvailable: boolean
  note?: string
}

export const api = {
  info: () => call<{ version: string; dataDir: string; electron: string; node: string; platform: string }>('app:info'),

  getSettings: () => call<Settings>('settings:get'),
  setSettings: (patch: Partial<Settings>) => call<Settings>('settings:set', patch),
  setTheme: (theme: ThemeMode) => call<Settings>('settings:set', { theme }),

  pickFile: () => call<string | undefined>('dialog:pick-file'),
  pickFiles: () => call<string[]>('dialog:pick-files'),
  pickFolder: () => call<string | undefined>('dialog:pick-folder'),
  saveText: (name: string, content: string) => call<string | undefined>('dialog:save-text', name, content),
  openPath: (p: string) => call<void>('shell:open-path', p),
  openExternal: (url: string) => call<void>('shell:open-external', url),

  scanJava: () => call<JavaInfo[]>('java:scan'),
  requiredJavaMajor: (v: string) => call<number>('java:required-major', v),
  installJava: (component: string) => call<string>('java:install', component),

  remoteVersions: () => call<RemoteVersion[]>('version:remote'),
  localVersions: (instanceId: string) => call<string[]>('version:local', instanceId),
  loaderVersions: (loader: string, mcVersion: string) => call<LoaderOption[]>('version:loaders', loader, mcVersion),
  deleteVersion: (instanceId: string, versionId: string) => call<string[]>('version:delete', instanceId, versionId),

  listInstances: () => call<Instance[]>('instance:list'),
  instanceDetail: (id: string) => call<InstanceDetail>('instance:detail', id),
  createInstance: (input: { name: string; mcVersion: string; loader?: string; loaderVersion?: string }) =>
    call<Instance>('instance:create', input),
  updateInstance: (id: string, patch: Partial<Instance>) => call<Instance>('instance:update', id, patch),
  installLoader: (id: string, loader: string, loaderVersion: string) =>
    call<Instance>('instance:install-loader', id, loader, loaderVersion),
  installLangPack: (id: string) =>
    call<{
      packs: { name: string; source: 'vm' | 'cfpa'; size: number; version: string; exact: boolean }[]
      skipped: { source: string; reason: string }[]
    }>('langpack:install', id),
  inspectLangPack: (id: string) =>
    call<{
      packs: { name: string; count: number }[]
      coveredCount: number
      mods: { id: string; name: string; covered: boolean; selfChinese: boolean }[]
    }>('langpack:inspect', id),
  /** 一个资源包里到底翻了哪些模组 */
  packContents: (id: string, zipName: string) =>
    call<{
      name: string
      size: number
      isLangPack: boolean
      title?: string
      description?: string
      files: { id: string; keys: number; entry: string }[]
      others: string[]
      totalEntries: number
    }>('langpack:contents', id, zipName),
  /** 删一个资源包（顺手清 options.txt）；不传名字就卸载全部汉化包 */
  removePack: (id: string, zipName?: string) =>
    call<{ removed: string | string[]; lines: boolean }>('langpack:remove', id, zipName),
  deleteInstance: (id: string, removeFiles: boolean) => call<void>('instance:delete', id, removeFiles),
  duplicateInstance: (id: string, name?: string) => call<Instance>('instance:duplicate', id, name),
  exportInstance: (id: string) => call<string>('instance:export', id),
  instanceContent: (id: string) =>
    call<{
      mods: ContentItem[]
      resourcepacks: ContentItem[]
      shaderpacks: ContentItem[]
      saves: ContentItem[]
    }>('instance:content', id),
  openInstanceFolder: (id: string) => call<void>('instance:open-folder', id),

  listContent: (instanceId: string, kind: ContentKind) => call<ContentItem[]>('content:list', instanceId, kind),
  toggleContent: (instanceId: string, target: string) => call<ContentItem[]>('content:toggle', instanceId, target),
  deleteContent: (instanceId: string, target: string) => call<void>('content:delete', instanceId, target),
  importContent: (instanceId: string, kind: ContentKind) =>
    call<ContentItem[] | undefined>('content:import', instanceId, kind),
  openContentDir: (instanceId: string, kind: ContentKind) => call<void>('content:open', instanceId, kind),
  backupSaves: (instanceId: string) => call<string | undefined>('saves:backup', instanceId),
  crashReports: (instanceId: string) => call<CrashReport[]>('crash:list', instanceId),
  readCrashReport: (instanceId: string, target: string) => call<string>('crash:read', instanceId, target),
  diagnose: (instanceId: string) => call<CrashDiagnosis | undefined>('crash:diagnose', instanceId),

  listServers: () => call<SavedServer[]>('server:list'),
  addServer: (input: { name?: string; address: string; port?: number; note?: string }) =>
    call<SavedServer>('server:add', input),
  removeServer: (id: string) => call<SavedServer[]>('server:remove', id),
  pingServer: (address: string, port?: number) => call<ServerStatus>('server:ping', address, port),
  joinServer: (instanceId: string, address: string, port?: number) =>
    call<boolean>('server:join', instanceId, address, port),

  installGame: (instanceId: string) => call<Instance>('game:install', instanceId),
  repairGame: (instanceId: string) => call<string[]>('game:repair', instanceId),
  launchGame: (instanceId: string) => call<boolean>('game:launch', instanceId),
  killGame: (instanceId: string) => call<boolean>('game:kill', instanceId),
  isRunning: (instanceId: string) => call<boolean>('game:running', instanceId),

  accounts: () => call<Account[]>('account:list'),
  addOffline: (name: string) => call<Account>('account:add-offline', name),
  removeAccount: (id: string) => call<void>('account:remove', id),
  setActiveAccount: (id: string) => call<Settings>('account:set-active', id),
  accountHealth: () => call<AccountHealth[]>('account:health'),
  refreshExpiringAccounts: () => call<{ refreshed: string[]; failed: string[] }>('account:refresh-expiring'),
  loginYggdrasil: (input: { apiRoot: string; username: string; password: string }) =>
    call<{ account: Account; profiles: { id: string; name: string }[] }>('account:login-yggdrasil', input),
  listProfiles: (accountId: string) => call<{ id: string; name: string }[]>('account:profiles', accountId),
  selectProfile: (accountId: string, profile: { id: string; name: string }) =>
    call<Account>('account:select-profile', accountId, profile),
  ensureInjector: () => call<{ path: string; version?: string }>('injector:ensure'),
  parseInjectorCard: (text: string) => call<string | undefined>('injector:parse-card', text),
  injectorFromClipboard: () => call<string | undefined>('injector:from-clipboard'),

  fetchTexture: (url: string) => call<string>('skin:fetch-texture', url),
  lookupSkin: (accountId: string, uuid?: string) =>
    call<{ uuid: string; name: string; skinUrl?: string; capeUrl?: string; model?: 'slim' | 'steve' } | undefined>(
      'skin:lookup',
      accountId,
      uuid
    ),
  uploadSkin: (accountId: string, filePath: string, model: 'slim' | 'steve') =>
    call<void>('skin:upload', accountId, filePath, model),
  uploadCape: (accountId: string, filePath: string) => call<void>('skin:upload-cape', accountId, filePath),
  clearTexture: (accountId: string, type: 'skin' | 'cape') => call<void>('skin:clear', accountId, type),
  pathOfFile: (file: File) => bridge.pathOfFile(file),

  encodeRoom: (host: string, port: number) => call<string>('room:encode', host, port),
  decodeRoom: (code: string) => call<{ host: string; port: number }>('room:decode', code),

  screenshots: (instanceId: string) =>
    call<{ name: string; path: string; size: number; time: number }[]>('shots:list', instanceId),
  deleteScreenshot: (instanceId: string, target: string) => call<void>('shots:delete', instanceId, target),
  openScreenshotsDir: (instanceId: string) => call<void>('shots:open-dir', instanceId),

  perfPresets: () =>
    call<{ id: string; name: string; desc: string; memoryMb: number; jvmArgs: string[] }[]>('preset:list'),
  applyPerfPreset: (instanceId: string, presetId: string) => call<Instance>('preset:apply', instanceId, presetId),
  msStart: () =>
    call<{ deviceCode: string; userCode: string; verificationUri: string; message: string; expiresIn: number }>(
      'account:ms-start'
    ),
  msComplete: (deviceCode: string, interval: number, expiresIn: number) =>
    call<Account>('account:ms-complete', deviceCode, interval, expiresIn),

  searchResources: (params: {
    type: string
    query?: string
    mcVersion?: string
    loader?: string
    index?: string
    offset?: number
    limit?: number
  }) => call<{ hits: ResourceHit[]; total: number; cn?: { matched: boolean; used: string[] } }>('resource:search', params),
  resourceVersions: (projectId: string, opts: { mcVersion?: string; loader?: string }) =>
    call<ResourceVersion[]>('resource:versions', projectId, opts),
  planResource: (instanceId: string, type: string, projectId: string, versionId?: string) =>
    call<InstallPlan>('resource:plan', instanceId, type, projectId, versionId),
  installResource: (instanceId: string, type: string, projectId: string, versionId?: string, includeOptional: string[] = []) =>
    call<PlanInstallResult>('resource:install', instanceId, type, projectId, versionId, includeOptional),

  installModpackFile: (filePath: string, name?: string) => call<string>('modpack:install-file', filePath, name),
  installModpackUrl: (url: string, name: string) => call<string>('modpack:install-url', url, name),

  // ---- 一键开服 ----
  listHosted: () => call<HostedServer[]>('hosted:list'),
  paperVersions: () => call<string[]>('hosted:paper-versions'),
  createHosted: (input: {
    name: string
    kind: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge'
    mcVersion: string
    memoryMb?: number
    port?: number
    loaderVersion?: string
  }) => call<HostedServer>('hosted:create', input),
  startHosted: (id: string) => call<boolean>('hosted:start', id),
  stopHosted: (id: string) => call<{ stopping: boolean; message: string }>('hosted:stop', id),
  killHosted: (id: string) => call<boolean>('hosted:kill', id),
  hostedPropsJson: (id: string) => call<Record<string, string>>('hosted:props-json', id),
  patchHostedProps: (id: string, patch: Record<string, string>) =>
    call<Record<string, string>>('hosted:patch-props', id, patch),
  hostedCommand: (id: string, command: string) => call<boolean>('hosted:command', id, command),
  hostedLogs: (id: string) => call<string[]>('hosted:logs', id),
  hostedStatus: (id: string) => call<{ running: boolean; uptime: number; server?: HostedServer }>('hosted:status', id),
  hostedProps: (id: string) => call<string>('hosted:props', id),
  setHostedProps: (id: string, content: string) => call<void>('hosted:set-props', id, content),
  acceptEula: (id: string) => call<HostedServer>('hosted:eula', id),
  deleteHosted: (id: string) => call<void>('hosted:delete', id),
  openHostedDir: (id: string) => call<void>('hosted:open-dir', id),
  loaderServerVersions: (kind: 'fabric' | 'forge' | 'neoforge', mc: string) =>
    call<string[]>('hosted:loader-versions', kind, mc),
  accessList: (id: string, type: 'whitelist' | 'ops') => call<AccessEntry[]>('hosted:access-list', id, type),
  addAccess: (id: string, type: 'whitelist' | 'ops', name: string) =>
    call<AccessEntry[]>('hosted:access-add', id, type, name),
  removeAccess: (id: string, type: 'whitelist' | 'ops', name: string) =>
    call<AccessEntry[]>('hosted:access-remove', id, type, name),
  backupHosted: (id: string) => call<string>('hosted:backup', id),
  hostedStats: (id: string) => call<{ players: string[]; tps?: number; done: boolean }>('hosted:stats', id),
  hostedModsCount: (id: string) => call<number>('hosted:mods-count', id),
  hostedManifest: (id: string) =>
    call<{ port?: number; mods?: number; manifest?: ServerManifest }>('hosted:manifest', id),
  serverSyncCheck: (instanceId: string, host: string, gamePort: number) =>
    call<EnvDiff>('serversync:check', instanceId, host, gamePort),
  serverSyncApply: (instanceId: string, diff: EnvDiff) =>
    call<{ added: number; failed: string[] }>('serversync:apply', instanceId, diff),
  createHostedFromInstance: (instanceId: string, opts: { name?: string; memoryMb?: number; port?: number }) =>
    call<HostedServer>('hosted:create-from-instance', instanceId, opts),
  importServerMods: (id: string, source: { instanceId?: string; packFile?: string }) =>
    call<{ mods: number; configs: number; total: number }>('hosted:import-mods', id, source),

  // ---- Mod 更新 ----
  checkModUpdates: (instanceId: string) => call<ModUpdateItem[]>('mods:updates', instanceId),  applyModUpdate: (instanceId: string, input: { path: string; url: string; filename: string }) =>
    call<string>('mods:apply', instanceId, input),

  // ---- 局域网 / P2P / 内网穿透 ----
  lanStart: () => call<{ running: boolean; worlds: LanWorld[] }>('lan:start'),
  lanList: () => call<LanWorld[]>('lan:list'),
  lanStop: () => call<boolean>('lan:stop'),
  lanIp: () => call<string>('net:lan-ip'),
  publicEndpoint: () => call<{ ip: string; port: number } | null>('net:public'),
  upnpMap: (port: number) => call<UpnpResult>('net:upnp', port),
  upnpUnmap: (port: number) => call<boolean>('net:unupnp', port),
  tunnelStart: (port: number) => call<TunnelState>('tunnel:start', port),
  tunnelState: () => call<TunnelState>('tunnel:state'),
  tunnelStop: () => call<boolean>('tunnel:stop'),

  // ---- 实例包 ----
  pickImportInstance: () => call<Instance | undefined>('instance:pick-import'),
  handleDrop: (instanceId: string | undefined, paths: string[]) =>
    call<{ done: string[]; failed: string[] }>('drop:handle', instanceId, paths),

  onHostLog: (cb: (p: { id: string; line: string }) => void) => bridge.on('event:host-log', cb),
  onHostExit: (cb: (p: { id: string; code: number | null }) => void) => bridge.on('event:host-exit', cb),

  // ---- 错误日志 ----
  reportError: (scope: string, message: string, detail?: string) =>
    call<boolean>('app:report-error', scope, message, detail),
  readErrors: () => call<string[]>('app:read-errors'),

  // ---- CurseForge（要 API Key）----
  cfSearch: (input: { query: string; mcVersion?: string; loader?: string }) =>
    call<{
      hits: { id: number; name: string; summary: string; downloadCount: number; logoUrl?: string; url?: string }[]
      cn?: { matched: boolean; used: string[] }
    }>('cf:search', input),
  cfInstall: (instanceId: string, modId: number) => call<string>('cf:install', instanceId, modId),
  cfTestKey: (key: string) => call<string>('cf:test-key', key),

  // ---- 音乐播放器 ----
  musicList: () => call<{ name: string; path: string; size: number }[]>('music:list'),
  musicImport: () => call<{ name: string; path: string; size: number }[]>('music:import'),
  musicRemove: (name: string) => call<{ name: string; path: string; size: number }[]>('music:remove', name),
  musicOpenDir: () => call<void>('music:open-dir'),

  // ---- 存档打包 / 恢复 ----
  packWorld: (instanceId: string, world: string) =>
    call<WorldPackResult | undefined>('world:pack', instanceId, world),
  inspectWorldPack: (zipPath?: string) => call<WorldPackCheck | undefined>('world:inspect', zipPath),
  restoreWorld: (instanceId: string) =>
    call<WorldRestoreResult | undefined>('world:restore', instanceId),

  // ---- 数据包 ----
  worlds: (instanceId: string) => call<string[]>('content:worlds', instanceId),
  datapacks: (instanceId: string, world: string) => call<ContentItem[]>('content:datapacks', instanceId, world),
  importDatapack: (instanceId: string, world: string) =>
    call<ContentItem[]>('content:datapack-import', instanceId, world),
  toggleDatapack: (instanceId: string, world: string, name: string) =>
    call<ContentItem[]>('content:datapack-toggle', instanceId, world, name),
  deleteDatapack: (instanceId: string, world: string, name: string) =>
    call<ContentItem[]>('content:datapack-delete', instanceId, world, name),
  checkPackUpdate: (instanceId: string) =>
    call<{
      hasUpdate: boolean
      currentVersion?: string
      latestVersion?: string
      latestVersionId?: string
      downloadUrl?: string
      note: string
    }>('modpack:check-update', instanceId),

  // ---- 资源包排序 / 诊断包 / 测速 ----
  packOrder: (instanceId: string) => call<string[]>('content:pack-order', instanceId),
  movePack: (instanceId: string, name: string, dir: -1 | 1) =>
    call<string[]>('content:pack-move', instanceId, name, dir),
  togglePack: (instanceId: string, name: string, enabled: boolean) =>
    call<string[]>('content:pack-toggle', instanceId, name, enabled),
  exportDiagnostics: (instanceId: string) => call<string>('content:export-diagnostics', instanceId),
  speedTest: () =>
    call<{ results: { name: string; url: string; ms: number; ok: boolean; error?: string }[]; recommend: 'mirror' | 'official' }>(
      'net:speedtest'
    ),
  uninstallerPath: () => call<string | undefined>('app:uninstaller'),
  runUninstaller: () => call<boolean>('app:run-uninstaller'),
  cleanTemp: () => call<{ removed: number; freed: number }>('app:clean-temp'),

  // ---- 任务队列 ----
  listTasks: () => call<TaskInfo[]>('tasks:list'),
  cancelTask: (id: string) => call<boolean>('tasks:cancel', id),
  clearTasks: () => call<TaskInfo[]>('tasks:clear'),
  onTask: (cb: (t: TaskInfo) => void) => bridge.on('event:task', cb),

  // ---- 自动更新 ----
  startUrlDownload: (url: string) => call<{ key: string; dest: string; name: string }>('dl:start-url', url),
  pauseDownload: (key: string) => call<boolean>('dl:pause', key),
  resumeDownload: (key: string) => call<boolean>('dl:resume', key),
  cancelDownload: (key: string) => call<boolean>('dl:cancel', key),
  downloaderState: (key: string) => call<{ exists: boolean; paused: boolean; bytes: number }>('dl:state', key),
  appVersion: () => call<string>('app:version'),
  checkUpdate: () => call<UpdateInfo>('update:check'),
  checkReleases: () => call<ReleaseCheck>('update:releases'),
  applyReleaseAsset: (url: string) => call<string>('update:apply-asset', url),
  applyRelease: (release: ReleaseInfo) => call<string>('update:apply-release', release),
  applyUpdate: (url: string) => call<string>('update:apply', url),

  // ---- Mod 体检 / 整合包导出 ----
  diagnoseMods: (instanceId: string) =>
    call<{ mods: { file: string; id?: string; name?: string; version?: string; loader?: string }[]; issues: ModIssue[] }>(
      'mods:diagnose',
      instanceId
    ),
  /** 一键补前置：给一串 modid，自动去 Modrinth 找对应项目并装（连带它自己的前置） */
  fixModDeps: (instanceId: string, modids: string[]) =>
    call<{
      items: { modid: string; projectId?: string; title?: string; status: 'installed' | 'skipped' | 'failed'; detail?: string }[]
      installed: string[]
      failed: number
    }>('mods:fix-deps', instanceId, modids),
  exportMrpack: (instanceId: string) => call<string>('modpack:export-mrpack', instanceId),  inspectMrpack: (file: string) =>
    call<{ name?: string; versionId?: string; files: number; deps?: Record<string, string> }>('modpack:inspect', file),

  onProgress: (cb: (p: ProgressPayload) => void) => bridge.on('event:progress', cb),
  onLog: (cb: (p: { instanceId: string; line: string }) => void) => bridge.on('event:launch-log', cb),
  onLaunchState: (cb: (p: LaunchStatePayload) => void) => bridge.on('event:launch-state', cb)
}

export function formatSize(bytes: number) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatDuration(ms?: number) {
  if (!ms || ms < 1000) return '还没玩过'
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  return `${hours} 小时 ${minutes} 分`
}

/** 把底层网络错误翻成人话，toast 里别甩 fetch failed 这种 */
export function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e)
  if (/fetch failed|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket hang up|network/i.test(msg)) {
    return '网络连不上（可能被墙或超时），换个下载源或稍后重试'
  }
  if (/HTTP 404|HTTP 410/i.test(msg)) {
    return '这个文件在服务器上取不到（镜像上没有就会退回官方重试）。点重试，或到设置里换个下载源'
  }
  if (/HTTP 5\d\d/i.test(msg)) return '对方服务器出错了，等会儿再试'
  if (/abort/i.test(msg)) return '操作已取消'
  return msg
}

