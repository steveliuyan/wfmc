import type {
  RestoreBackupResult,
  SaveBackup,
  Account,
  ContentItem,
  ContentKind,
  CloudAnnouncement,
  CloudBackup,
  CloudHealth,
  CloudSettings,
  CloudStatus,
  CrashDiagnosis,
  CrashReport,
  Instance,
  InstallPlan,
  JavaInfo,
  LaunchStatePayload,
  LoaderOption,
  NotifyListResult,
  PlanInstallResult,
  ProgressPayload,
  RemoteVersion,
  ResourceHit,
  ResourceVersion,
  SavedServer,
  ServerStatus,
  Settings,
  StorageKind,
  ThemeMode,
  UnifiedLoginResult,
  WorldPackCheck,
  WorldPackResult,
  WorldRestoreResult,
  WfmcAccountStatus
} from '../shared/types'
import type { CleanResult, DiskUsage, SearchHit } from '../shared/types'
export type { SearchHit }

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

export interface ScannedPort {
  port: number
  motd?: string
  version?: string
  players?: { online: number; max: number }
  fromJava?: boolean
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
  /** 有可用增量补丁时带上，界面可以提示"这次只下 X MB" */
  delta?: { kind: 'portable' | 'asar'; size: number; url: string; from: string; to: string }
}

export interface UpdateResult {
  path: string
  via: 'delta' | 'full'
  deltaBytes?: number
  savedBytes?: number
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
  /** 房主开了「整包直传」（游戏文件 + 模组 + Java 运行时） */
  pack?: boolean
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

/** 房间码里附带的环境信息 */
export interface RoomEnv {
  mcVersion?: string
  loader?: string
  loaderVersion?: string
}

export interface TaskInfo {
  id: string
  kind: string
  title: string
  status: 'running' | 'paused' | 'done' | 'error' | 'canceled'
  phase?: string
  current?: number
  total?: number
  detail?: string
  error?: string
  createdAt: number
  finishedAt?: number
  /** 父任务 id：有值说明这是子任务（任务树） */
  parentId?: string
  /** 父任务用：子任务总数 / 已完成数 */
  childTotal?: number
  childDone?: number
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
  /** 「这是什么」：这条问题什么意思、会有什么症状、能不能不管 */
  explain?: string
  files?: string[]
  fixLoader?: 'fabric' | 'forge' | 'neoforge' | 'quilt'
  /** 缺的前置 modid，可直接一键装 */
  fixDep?: string
  depRange?: string
  /** 前置装了但被禁用：这几个 .disabled 文件可以直接启用 */
  enableFiles?: string[]
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
  /** 便携版/安装版的数据目录对照：便携版看不到实例时用它解释清楚 */
  dataSharedInfo: () =>
    call<{
      portable: boolean
      ownDir: string
      sharedDir: string
      usingShared: boolean
      currentDir: string
      ownInstances: number
      sharedInstances: number
      sharedBytes: number
    }>('data:shared-info'),
  useSharedData: (on: boolean) =>
    call<{ dir: string; instances: number; accounts: number }>('data:use-shared', on),
  setDataDir: (dir: string) =>
    call<{ dir: string; instances: number; accounts: number }>('data:set-dir', dir),
  /** 找回旧数据：机器上所有存过数据的目录（老名字 / 便携版 / 安装版） */
  dataDiscover: () =>
    call<{ dir: string; name: string; instances: number; accounts: number; score: number; active: boolean }[]>(
      'data:discover'
    ),
  dataAdopt: (dir: string) =>
    call<{ dir: string; instances: number; accounts: number }>('data:adopt', dir),
  /** 启动时自动接上了旧数据的话，这里返回一条说明（只返回一次） */
  adoptInfo: () =>
    call<{ from: string; to: string; accounts: number } | null>('data:adopt-info'),
  /** 一键清空记录（accounts = 账号列表，playtime = 各实例游玩时长） */
  clearData: (target: 'accounts' | 'playtime') =>
    call<{ target: string; cleared: number; detail: string }>('data:clear', target),
  /** 一键删除数据：整个数据目录清空（连账号一起，账号会留 .bak） */
  wipeData: () =>
    call<{ dir: string; removed: number; failed: number; accountBackup: boolean }>('data:wipe'),
  /** 换目录后把旧目录的数据复制到新目录（只复制不删旧目录，带进度） */
  migrateData: (fromDir: string) =>
    call<{ from: string; to: string; copied: number; skipped: number; bytes: number; accounts: number }>(
      'data:migrate',
      fromDir
    ),  /** 数据目录占多大（超时会有 partial） */
  /** Ctrl+K 全局搜索：实例 / 当前实例内容 / 收藏的服务器（本地索引，主进程读目录） */
  searchAll: (query: string, instanceId?: string) => call<SearchHit[]>('search:all', query, instanceId),
  dataUsage: () => call<DiskUsage>('data:usage'),
  cleanUsage: (key: 'downloads' | 'cache' | 'logs') => call<CleanResult>('data:clean-usage', key),
  dataSize: () =>
    call<{ dir: string; bytes: number; files: number; partial: boolean }>('data:size'),
  /** 数据目录体检：是否落在安装目录里（更新会清空安装目录 → 要红字提示） */
  dataHealth: () =>
    call<{ dir: string; installDir: string; insideInstall: boolean }>('data:health'),

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
  enableContent: (instanceId: string, kind: ContentKind, names: string[]) =>
    call<ContentItem[]>('content:enable', instanceId, kind, names),
  deleteContent: (instanceId: string, target: string) => call<void>('content:delete', instanceId, target),
  importContent: (instanceId: string, kind: ContentKind) =>
    call<ContentItem[] | undefined>('content:import', instanceId, kind),
  openContentDir: (instanceId: string, kind: ContentKind) => call<void>('content:open', instanceId, kind),
  backupSaves: (instanceId: string) => call<string | undefined>('saves:backup', instanceId),
  saveBackups: (instanceId: string) => call<SaveBackup[]>('saves:backups', instanceId),
  restoreSaveBackup: (instanceId: string, file: string) =>
    call<RestoreBackupResult>('saves:restore-backup', instanceId, file),
  /** 手动把当前 mods 整目录打个快照 */
  backupMods: (instanceId: string) => call<string | undefined>('mods:backup', instanceId),
  modsBackups: (instanceId: string) =>
    call<{ file: string; name: string; bytes: number; time: number; count: number; partial: boolean }[]>(
      'mods:backups',
      instanceId
    ),
  restoreModsBackup: (instanceId: string, file: string) =>
    call<{ restored: number; removed: number; safetyBackup?: string }>('mods:restore-backup', instanceId, file),
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

  encodeRoom: (host: string, port: number, env?: RoomEnv) => call<string>('room:encode', host, port, env),
  decodeRoom: (code: string) => call<{ host: string; port: number; env?: RoomEnv }>('room:decode', code),

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
  serverSyncProbe: (host: string, gamePort: number) =>
    call<{ found: boolean; base?: string; manifest?: ServerManifest }>('serversync:probe', host, gamePort),
  publishInstanceManifest: (instanceId: string, basePort?: number) =>
    call<{ ok: boolean; port?: number; mods?: number; lanIp?: string }>('serversync:publish-instance', instanceId, basePort),
  unpublishInstanceManifest: (instanceId: string) =>
    call<boolean>('serversync:unpublish-instance', instanceId),
  /** 这个实例现在共享在哪个端口（0 = 没共享） */
  instanceManifestPort: (instanceId: string) => call<number>('serversync:instance-port', instanceId),
  serverSyncCheck: (instanceId: string, host: string, gamePort: number) =>
    call<EnvDiff>('serversync:check', instanceId, host, gamePort),
  serverSyncApply: (instanceId: string, diff: EnvDiff) =>
    call<{ added: number; failed: string[]; stillMissing?: string[] }>('serversync:apply', instanceId, diff),
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
  /** 本机游戏「对局域网开放」实际用的端口（游戏里自己填的那个，可能不是 25565） */
  myLanPort: () => call<{ instanceId?: string; port?: number; at?: number }>('lan:my-port'),
  /** 扫本机正在开着的游戏端口（游戏里「对局域网开放」填的那个，不一定 25565） */
  scanLanPorts: () => call<ScannedPort[]>('lan:scan-ports'),
  /** 从房主机器整包拷游戏文件 / 模组 / Java 运行时（同一个路由器下最稳） */
  pullPackFromHost: (instanceId: string, host: string, gamePort: number) =>
    call<{ ok: boolean; message: string; downloaded: number; skipped: number; failed: string[] }>(
      'lan:pull-pack',
      instanceId,
      host,
      gamePort
    ),
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
  /** 就地升级整合包（保留你改过的配置） */
  upgradePack: (instanceId: string) =>
    call<{
      hasUpdate: boolean
      added: number
      updated: number
      removed: number
      keptModified: string[]
      backedUp: number
      note: string
    }>('modpack:upgrade', instanceId),

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
  pauseTask: (id: string) => call<boolean>('tasks:pause', id),
  resumeTask: (id: string) => call<boolean>('tasks:resume', id),
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
  applyRelease: (release: ReleaseInfo) => call<UpdateResult>('update:apply-release', release),
  applyUpdate: (url: string) => call<string>('update:apply', url),

  // ---- Mod 体检 / 整合包导出 ----
  diagnoseMods: (instanceId: string) =>
    call<{ mods: { file: string; id?: string; name?: string; version?: string; loader?: string }[]; issues: ModIssue[] }>(
      'mods:diagnose',
      instanceId
    ),
  /** 一键补前置：给一串 modid，自动去 Modrinth 找对应项目并装（连带它自己的前置） */  fixModDeps: (instanceId: string, modids: string[]) =>
    call<{
      items: { modid: string; projectId?: string; title?: string; status: 'installed' | 'skipped' | 'failed'; detail?: string }[]
      installed: string[]
      failed: number
    }>('mods:fix-deps', instanceId, modids),
  /** 体检常驻：开始盯这个实例的 mods 目录（结果通过 onModsDiagnosis 推过来） */
  startModWatch: (instanceId: string) => call<boolean>('mods:watch-start', instanceId),
  stopModWatch: () => call<boolean>('mods:watch-stop'),
  onModsDiagnosis: (cb: (p: { instanceId: string; issues: ModIssue[]; activeCount: number; at: number }) => void) =>
    bridge.on('event:mods-diagnosis', cb),
  exportMrpack: (instanceId: string) => call<string>('modpack:export-mrpack', instanceId),  inspectMrpack: (file: string) =>
    call<{ name?: string; versionId?: string; files: number; deps?: Record<string, string> }>('modpack:inspect', file),

  // ---------------- 云同步（自建服务端，契约见 docs/SERVER-API.md） ----------------
  cloudSettings: () => call<CloudSettings | null>('cloud:settings'),
  saveCloudSettings: (patch: Partial<CloudSettings>) => call<CloudSettings>('cloud:save-settings', patch),
  testCloud: () =>
    call<{ health?: CloudHealth; authorized: boolean; message: string }>('cloud:test'),
  ensureCloud: (force?: boolean) => call<{ ok: boolean; message: string }>('cloud:ensure', !!force),
  unpairCloud: () => call<boolean>('cloud:unpair'),
  cloudStatus: () => call<CloudStatus>('cloud:status'),
  cloudBackups: () => call<CloudBackup[]>('cloud:backups'),
  cloudLocalBackups: () => call<CloudBackup[]>('cloud:local-backups'),
  cloudUpload: () => call<{ ok: boolean; message: string; pruned?: number }>('cloud:upload'),
  cloudRestore: (id: string) =>
    call<{
      ok: boolean
      message: string
      result?: {
        settingsApplied: boolean
        accountsRestored: number
        instancesAdded: number
        instancesSkipped: number
        serversRestored: number
        needRestart: boolean
        safetyDir: string
      }
    }>('cloud:restore', id),
  cloudDelete: (id: string) => call<void>('cloud:delete', id),
  cloudRestoreLocal: (id: string) =>
    call<{
      ok: boolean
      message: string
      result?: {
        settingsApplied: boolean
        accountsRestored: number
        instancesAdded: number
        instancesSkipped: number
        serversRestored: number
        needRestart: boolean
        safetyDir: string
      }
    }>('cloud:restore-local', id),
  cloudDeleteLocal: (id: string) => call<void>('cloud:delete-local', id),
  cloudAnnouncements: (force?: boolean) => call<CloudAnnouncement[]>('cloud:announcements', !!force),
  /** 应用内通知：未登录也能拉（公开公告），登录后带服务端已读标记 */
  notifications: () => call<NotifyListResult>('notify:list'),
  /** 标记已读；未登录时主进程直接返回（本地已读由界面自己记） */
  notificationRead: (ids: number[]) =>
    call<{ ok: boolean; message: string; loggedIn: boolean }>('notify:read', ids),
  /** 弹系统通知（Windows 右下角）：只给服务端 mode='popup' 的新通知用 */
  notificationPop: (p: { title?: string; body?: string }) =>
    call<{ ok: boolean; message: string }>('notify:pop', p),

  // ---------------- 备份位置（本地文件夹 / 自己的 WebDAV） ----------------
  saveWebdav: (patch: { url?: string; username?: string; dir?: string; password?: string }) =>
    call<CloudSettings>('cloud:webdav-save', patch),
  saveLocalDir: (dir: string) => call<CloudSettings>('cloud:local-dir', dir),
  pickLocalDir: () => call<string>('cloud:local-pick'),
  storageTest: () => call<{ ok: boolean; message: string }>('cloud:storage-test'),
  cloudMigrate: (from?: StorageKind) =>
    call<{ ok: boolean; copied: number; skipped: number; failed: string[]; message: string }>('cloud:migrate', from),

  // ---------------- 统一账号（浏览器登录，跟微软/MC 正版账号无关） ----------------
  accountStatus: () => call<WfmcAccountStatus>('account:status'),
  accountLogin: () => call<UnifiedLoginResult>('account:login'),
  accountLogout: () => call<UnifiedLoginResult>('account:logout'),
  accountRefresh: () => call<UnifiedLoginResult>('account:refresh'),
  accountInfo: () => call<{ loggedIn: boolean; email?: string; displayName?: string; userId?: string }>('account:info'),
  onProgress: (cb: (p: ProgressPayload) => void) => bridge.on('event:progress', cb),
  onLog: (cb: (p: { instanceId: string; line: string }) => void) => bridge.on('event:launch-log', cb),
  onLaunchState: (cb: (p: LaunchStatePayload) => void) => bridge.on('event:launch-state', cb)
}

/** 版本清单里的 type 翻成人话（愚人节版本在清单里也算 snapshot，只能靠 id 认） */
export function versionTypeLabel(v: { type: string; aprilFools?: boolean }): string {
  if (v.aprilFools) return '愚人节'
  switch (v.type) {
    case 'release':
      return '正式版'
    case 'snapshot':
      return '快照'
    case 'old_beta':
      return '远古 Beta'
    case 'old_alpha':
      return '远古 Alpha'
    default:
      return v.type
  }
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

/** 进度百分比：带字节数就按字节算（大文件下载不会 0% 卡到 100%），否则按文件个数 */
export function progressPercent(p: {
  current?: number
  total?: number
  bytes?: number
  totalBytes?: number
}): number {
  if (p.totalBytes && p.totalBytes > 0 && typeof p.bytes === 'number') {
    return Math.max(0, Math.min(100, Math.round((p.bytes / p.totalBytes) * 100)))
  }
  if (!p.total) return 0
  return Math.max(0, Math.min(100, Math.round(((p.current ?? 0) / p.total) * 100)))
}

/** 进度条右边的数字：字节 / 字节 或 个数 / 个数 */
export function progressText(p: {
  current?: number
  total?: number
  bytes?: number
  totalBytes?: number
}): string {
  if (p.totalBytes && p.totalBytes > 0) return `${formatSize(p.bytes ?? 0)} / ${formatSize(p.totalBytes)}`
  return `${p.current ?? 0}/${p.total ?? 0}`
}


export function formatDuration(ms?: number) {
  if (!ms || ms < 1000) return '还没玩过'
  const totalMinutes = Math.floor(ms / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes} 分钟`
  return `${hours} 小时 ${minutes} 分`
}

/**
 * 「最近启动」用的紧凑写法。
 * toLocaleString() 输出「2026/11/1 18:22:11」十好几个字符，在首页右栏里会折行；
 * 今年内省掉年份，完整时间放在 title 里悬停看。
 */
export function formatLastPlayed(when: string | number) {
  const d = new Date(when)
  if (Number.isNaN(d.getTime())) return '还没玩过'
  const pad = (n: number) => String(n).padStart(2, '0')
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}-${md}`
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

