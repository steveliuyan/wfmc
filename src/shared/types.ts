// 全局共享类型（主进程 + 渲染进程共用）
export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  /** 数据根目录（实例、运行时、配置文件都在这） */
  dataDir: string
  /** 便携版专用：true = 直接用本机安装版的那份数据（%APPDATA%/WFMC/data），false = 用自己的 WFMC-Data */
  useSharedData?: boolean
  /**
   * 用户自己挑过数据目录。
   * 便携版默认把数据放 exe 旁边的 WFMC-Data，启动时会强行纠回去；
   * 有这个标记，手动选过的目录就不会再被纠回默认（以前换完目录重启又变回去了）。
   */
  dataDirCustom?: boolean
  /** 界面主题 */
  theme: ThemeMode
  /** 下载源：official = 官方，mirror = 国内镜像(BMCLAPI) */
  downloadSource: 'official' | 'mirror' | 'auto'
  /** 下载并发连接数（默认 48，设置里可调） */
  downloadThreads: number
  /** 限速（KB/s），0 = 不限速 */
  downloadLimitKbps?: number
  /** 贴链接下载保存目录（空 = data/downloads） */
  downloadDir?: string
  /** 同时下载的文件数 */
  maxConcurrentDownloads: number
  /** 全局默认最大内存(MB) */
  maxMemory: number
  /** 全局默认最小内存(MB) */
  minMemory: number
  /** 全局默认 Java 路径（空 = 自动选择） */
  javaPath: string
  /** 额外 JVM 参数 */
  extraJvmArgs: string[]
  /** 微软登录用的 client id（设备码流） */
  microsoftClientId: string
  /** CurseForge API Key（在线搜索 CurseForge 需要） */
  curseforgeApiKey: string
  /** 关闭游戏时是否显示日志 */
  showLog: boolean
  /** 代理，例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080（空 = 直连） */
  proxy: string
  /** 是否走完首次引导 */
  onboarded: boolean
  /** 主窗口位置记忆 */
  windowState?: { x: number; y: number; width: number; height: number; maximized?: boolean }
  /** 当前使用的账号 id */
  activeAccountId?: string
  /** 自定义更新源（放 update.json 的地址，空 = 关闭自动更新检查） */
  updateUrl: string
  /** 上次检查更新的版本 */
  lastUpdateCheck?: number
  /** 界面语言 */
  language?: 'zh' | 'en'
  /** 主题自定义：主色 / 圆角 / 背景图 */
  themeCustom?: { accent?: string; radius?: number; wallpaper?: string }
  /** 上次用过的外置登录 API 地址（拖拽卡片 / 手动填都会记） */
  yggdrasilApi?: string
  /** 是否已确认免责声明 */
  disclaimerAccepted?: boolean
  /** 新手引导（高亮讲解）看完了没——看过的就不自动弹了，左侧「新手引导」还能再放一遍 */
  tourDone?: boolean
  /** 点窗口 ✕ 时最小化到托盘（服务端还在跑时不退出） */
  closeToTray?: boolean
  /** 开机自动检查更新 */
  autoCheckUpdate?: boolean
  /** 收藏的模组 / 光影 / 资源包（手机上叫收藏夹，这里存最小信息免得每次重查） */
  favResources?: FavResource[]
  /** 把老的「自动测速」一次性迁到国内镜像，迁过就不再动 */
  mirrorMigrated?: boolean
  /** 配置结构版本：由 config-migrate.ts 维护，启动时按版本号依次升级 */
  configVersion?: number
  /** 启动前自动备份存档（默认开）—— 存档回滚的后悔药全靠它 */
  autoBackupSaves?: boolean
  /**
   * 存档工坊（实验功能，默认关）。
   * 它是唯一会写用户 level.dat 的功能（写坏不可逆），所以灰度放：没开这一项时，
   * 「内容管理 → 存档工坊」页签不显示，主进程的 saves:snapshot-level / saves:patch-level 也直接拒绝。
   * 只读的存档列表 / 体检不受影响，一直可用。
   */
  saveWorkshop?: boolean
  /** 启动前跑一遍模组体检，有 error 级问题（重复 mod / 加载器不匹配 / 前置被禁用）就先拦一下（默认开） */
  launchCheckMods?: boolean
  /** 首页下面几块卡片的排列顺序（自己拖着改的） */
  homeLayout?: string[]
  /**
   * 云同步（自建服务端）。**默认关闭**，没配就完全不会发任何网络请求。
   * 客户端这一侧只是「按契约打 HTTP」，服务端契约见 docs/SERVER-API.md。
   */
  cloud?: CloudSettings
}

/**
 * 配置备份存到哪里：
 * - wfmc   旧的 WFMC 云同步后端（已废弃，只为读老配置保留，实际按 local 处理）
 * - webdav 任意标准 WebDAV（坚果云 / Nextcloud / 群晖…），账号密码用户自己填
 * - local  本地文件夹（可以选同步盘目录）
 */
export type StorageKind = 'wfmc' | 'webdav' | 'local'

/** WebDAV 后端的连接参数（密码不在这里：加密存在 cloud-auth.json，渲染层拿不到） */
export interface WebdavSettings {
  url?: string
  username?: string
  /** 远端目录，默认 /wfmc */
  dir?: string
}

/** 云同步设置（不含令牌：令牌单独加密存在 cloud-auth.json，渲染层永远拿不到） */
export interface CloudSettings {
  /** 总开关 */
  enabled: boolean
  /** 备份存到哪个后端（不填 = local；'wfmc' 已废弃，会被当成 local） */
  storage?: StorageKind
  /** WebDAV 后端的连接参数 */
  webdav?: WebdavSettings
  /** 本地文件夹后端用的目录 */
  localDir?: string
  /** @deprecated 服务器地址由客户端固定，不再允许用户填；旧配置里的值会被清掉 */
  baseUrl?: string
  /** @deprecated 已经不需要「设备名」这个概念，旧配置里的值会被清掉 */
  deviceName?: string
  /** 启动后自动上传配置备份 */
  autoBackup: boolean
  /** 自动备份间隔（小时） */
  intervalH: number
  /** @deprecated 保留份数由服务端统一定（自动 3 / 手动 5），客户端只读 */
  keep?: number
  /** 是否拉公告 */
  announcements: boolean
  /** 上次备份成功时间 */
  lastBackupAt?: number
  /** 上次失败原因（成功就清空） */
  lastError?: string
  /** 上次测通的时间 */
  lastOkAt?: number
  /** 服务端告诉我们的设备名 / 配额说明，仅供展示 */
  serverNote?: string
}

/** 公告条目（服务端 GET /api/v1/announcements 的一项） */
export interface CloudAnnouncement {
  id: string
  level: 'info' | 'warn' | 'critical'
  title: string
  body?: string
  url?: string
  pinned?: boolean
  publishedAt?: number
  expiresAt?: number
  minVersion?: string
  maxVersion?: string | null
}

/** 云端一条备份（GET /api/v1/backups 的一项） */
export interface CloudBackup {
  id: string
  kind: 'config' | 'instance'
  size: number
  sha256?: string
  createdAt: number
  instanceName?: string
  appVersion?: string
  note?: string
}

/** GET /api/v1/health 的返回 */
export interface CloudHealth {
  ok: boolean
  name?: string
  version?: string
  time?: number
  /** 服务端要求的客户端最低版本（可选） */
  minClientVersion?: string
  /** 服务端给的提示（展示在设置页） */
  note?: string
}

/** 云同步的整体状态（渲染层用） */
export interface CloudStatus {
  configured: boolean
  hasToken: boolean
  /** @deprecated 不再有设备概念 */
  deviceId?: string
  /** @deprecated 不再有设备名 */
  deviceName?: string
  online?: boolean
  error?: string
  /** @deprecated 服务器地址不在界面上显示 */
  baseUrl?: string
  /** @deprecated 服务器地址不在界面上显示 */
  isDefaultServer?: boolean
  /** 服务端自我介绍（GET /health 的 name/version/note） */
  server?: { name?: string; version?: string; note?: string }
  /** 当前用的备份后端（不填按 local 处理） */
  storage?: StorageKind
  /** 当前后端的一句话说明（设置页显示用） */
  storageLabel?: string
  /** 当前后端实际用到的地址 / 目录 */
  storageTarget?: string
  /** WebDAV 是否已经存了密码 */
  webdavHasPass?: boolean
  webdavUsable?: boolean
  localUsable?: boolean
  /** 统一账号（云端）登录情况 */
  account?: { loggedIn: boolean; email?: string; displayName?: string; userId?: string }
  /** 服务端定的保留份数（只读展示） */
  limits?: { autoKeep: number; manualKeep: number }
  /** 本地保留份数（客户端固定值，跟服务端无关） */
  localKeep?: number
  /** 本地已有的备份 */
  localBackups?: CloudBackup[]
  backups: CloudBackup[]
}

/** 收藏的一个资源项目 */
export interface FavResource {
  projectId: string
  kind: string
  title: string
  iconUrl?: string
  pageUrl?: string
  author?: string
  downloads?: number
  description?: string
}

/** 收藏的服务器 */
export interface SavedServer {
  id: string
  name: string
  address: string
  port?: number
  note?: string
  createdAt: number
  /** 上次查询到的状态（缓存，进页面先显示这个） */
  lastStatus?: ServerStatus
  lastChecked?: number
  /** 服务器图标（data:image/png;base64,...） */
  icon?: string
}

/** 服务器状态查询结果 */
export interface ServerStatus {
  online: boolean
  latency?: number
  version?: string
  protocol?: number
  players?: { online: number; max: number; sample?: string[] }
  motd?: string
  favicon?: string
  /** SRV 解析结果（有 SRV 记录时） */
  srv?: { host: string; port: number }
  error?: string
}

/** 崩溃诊断结果 */
export interface CrashDiagnosis {
  file: string
  generatedAt: number
  lines: number
  /** 命中的问题（按严重度排序） */
  issues: { title: string; advice: string; evidence: string }[]
  /** 报告开头几行摘要 */
  summary: string
}

export interface Account {
  id: string
  type: 'offline' | 'microsoft' | 'yggdrasil'
  name: string
  uuid: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  /** 外置登录（authlib-injector）的 API 根地址，例如 https://littleskin.cn/api/yggdrasil */
  server?: string
}

export interface GameResolution {
  width: number
  height: number
  fullscreen?: boolean
}

export interface Instance {
  id: string
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  /** 实际可启动的版本目录名 */
  versionId?: string
  javaPath?: string
  maxMemory?: number
  minMemory?: number
  extraJvmArgs?: string[]
  /** 游戏窗口大小 */
  resolution?: GameResolution
  /** 版本数据隔离：每个版本独立的存档 / mods / 配置 */
  isolate?: boolean
  /** 最后一次套用的性能预设 */
  perfPreset?: 'low' | 'balanced' | 'high' | 'shader'
  /** 这个实例是从哪个整合包装出来的（用于更新检测） */
  packSource?: {
    kind: 'modrinth' | 'curseforge' | 'local'
    projectId?: string
    versionId?: string
    versionNumber?: string
    packName?: string
    url?: string
  }
  /** 启动后直连的服务器 */
  server?: { ip: string; port?: number }
  /** 累计游玩时长（毫秒） */
  playTimeMs?: number
  createdAt: number
  lastPlayed?: number
  /** 是否已完整安装 */
  installed?: boolean
}

export interface JavaInfo {
  path: string
  version: string
  majorVersion: number
}

export interface RemoteVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha' | string
  releaseTime: string
  url: string
  /** 愚人节版本（官方清单里算 snapshot，只能靠 id 认出来） */
  aprilFools?: boolean
}

export interface LoaderOption {
  value: string
  label: string
  stable?: boolean
}

/** Modrinth 搜索命中 */
export interface ResourceHit {
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  follows: number
  iconUrl: string
  categories: string[]
  versions: string[]
  projectType: string
  pageUrl: string
}

export interface ResourceFile {
  url: string
  filename: string
  primary: boolean
  size: number
}

export interface ResourceVersion {
  id: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  versionType: string
  downloads: number
  datePublished: string
  files: ResourceFile[]
  dependencies: { project_id?: string; version_id?: string; dependency_type: string }[]
}

/** 依赖清单里的一项（装模组前先给用户看清楚要装什么） */
export interface DepItem {
  projectId: string
  versionId?: string
  title: string
  slug?: string
  iconUrl?: string
  /** required = 必需前置；optional = 可选；incompatible = 冲突；embedded = 已内置 */
  dependencyType: 'required' | 'optional' | 'incompatible' | 'embedded'
  filename?: string
  size?: number
  versionName?: string
  /** 磁盘上已经有同名文件 */
  alreadyInstalled: boolean
  /** 该依赖解析失败的原因 */
  error?: string
}

export interface InstallPlan {
  root: {
    projectId: string
    versionId: string
    title: string
    iconUrl?: string
    versionName: string
    filename?: string
    size?: number
    gameVersions: string[]
    loaders: string[]
    /** 该版本不支持当前实例的 MC 版本 / 加载器 */
    mismatch?: string
  }
  required: DepItem[]
  optional: DepItem[]
  incompatible: DepItem[]
}

export interface PlanInstallResult {
  installed: string[]
  skipped: string[]
  failed: { title: string; error: string }[]
}

export type ContentKind = 'mods' | 'resourcepacks' | 'shaderpacks' | 'saves'

export interface ContentItem {
  name: string
  size: number
  mtime: number
  path: string
  isDir: boolean
  disabled: boolean
  /** 从 jar / zip 里读出来的显示名（fabric.mod.json 的 name、mods.toml 的 displayName） */
  title?: string
  /** 简介（模组描述 / 资源包的 description） */
  description?: string
  /** 模组自己的版本号 */
  version?: string
  /** fabric / forge / neoforge */
  loader?: string
  /** 已提取到本地缓存的图标文件路径（渲染层用 file:// 显示） */
  iconPath?: string
}

export interface ModMeta {
  title?: string
  description?: string
  version?: string
  loader?: string
  iconPath?: string
}

export interface CrashReport {
  name: string
  path: string
  time: number
  size: number
}

export interface ProgressPayload {
  key: string
  phase: string

  /** 已完成的字节数（带上它，界面就按字节算百分比，比文件个数平滑得多） */
  bytes?: number
  /** 这次一共要下多少字节（0 表示不知道） */
  totalBytes?: number
  current?: number
  total?: number
  detail?: string
  /** 这条进度已经结束（完成/失败），界面可以自动收起 */
  done?: boolean
  /** 属于哪个后台任务，任务结束时按它清掉残留进度条 */
  taskId?: string
}

export type ProgressFn = (payload: ProgressPayload) => void

export interface LaunchStatePayload {
  instanceId: string
  state: 'preparing' | 'running' | 'exited' | 'error'
  message?: string
  code?: number
}

/** 存档包里的单个文件指纹 */
export interface PackEntry {
  /** 相对存档目录的路径，统一用 / */
  path: string
  size: number
  sha1: string
}

/** 存档包清单（打包时写进 zip 根的 wfmc-worldpack.json） */
export interface WorldPackInfo {
  format: number
  app: string
  name: string
  mcVersion: string
  createdAt: number
  fileCount: number
  bytes: number
  /** 对全部条目排序后再算的 sha1，用来一眼判断包有没有被动过 */
  digest: string
}

/** 校验时发现的问题 */
export interface PackProblem {
  path: string
  kind: 'missing' | 'size' | 'sha1' | 'unsafe' | 'extra'
  detail?: string
}

/** 存档包校验结果 */
export interface WorldPackCheck {
  ok: boolean
  /** 包里有没有 WFMC 的校验清单；老 zip 没有就只能按普通压缩包解 */
  signed: boolean
  info?: WorldPackInfo
  /** 实际校验过的文件数 */
  checked: number
  problems: PackProblem[]
}

/** 打包结果 */
export interface WorldPackResult {
  path: string
  info: WorldPackInfo
  /** 生成的 zip 大小 */
  zipBytes: number
}

/** 恢复结果 */
export interface WorldRestoreResult {
  dir: string
  name: string
  fileCount: number
  bytes: number
  /** 目标目录已存在同名存档时自动改名了 */
  renamed: boolean
  check: WorldPackCheck
}

/** 打包存档的结果：不只给路径，还要告诉界面「这份里装了哪几个存档」 */
export interface SavesBackupResult {
  /** zip 的绝对路径 */
  file: string
  /** 打进去的存档目录名（saves 下一级目录） */
  worlds: string[]
  /** 打包的文件数 */
  files: number
  /** zip 体积（字节） */
  bytes: number
  instanceId: string
  instanceName?: string
  mcVersion?: string
}

/** 一份存档快照（备份目录里的 zip） */
export interface SaveBackup {
  /** 绝对路径 */
  file: string
  /** 文件名（带时间戳） */
  name: string
  bytes: number
  time: number
  /** 这份快照里装了几个存档（世界目录名）；老快照没有这项 */
  worlds?: string[]
  /** 打包的文件数 */
  files?: number
  /** 属于哪个实例 */
  instanceName?: string
  mcVersion?: string
}

/** 回滚结果 */
export interface RestoreBackupResult {
  /** 写回的文件数 */
  restored: number
  /** 回滚前自动留的那份「后悔药」，没有当前存档时为 undefined */
  safetyBackup?: string
  /** 这次回滚涉及的存档目录名 */
  worlds: string[]
}

/** 数据目录里一块的占用（存储管理用） */
export interface UsageItem {
  key: string
  label: string
  path: string
  bytes: number
  files: number
  /** 能不能一键清掉（只有下载 / 缓存 / 日志可以） */
  cleanable: boolean
  hint?: string
  /** 是否已经算进总计（日志算在实例里，不重复加） */
  inTotal: boolean
}

export interface DiskUsage {
  dir: string
  total: { bytes: number; files: number }
  items: UsageItem[]
  partial: boolean
}

export interface CleanResult {
  files: number
  bytes: number
}

/** Ctrl+K 全局搜索的一条结果（本地索引，见 main/search.ts） */
export type SearchGroup = '实例' | '模组' | '资源包' | '光影' | '存档' | '服务器'

export interface SearchHit {
  group: SearchGroup
  /** 显示标题：模组用文件名去掉 .jar */
  title: string
  /** 右侧小字：实例 · 大小、版本 · 加载器、地址… */
  subtitle?: string
  /** 点开去哪个页面 */
  page: 'home' | 'manage' | 'servers' | 'download' | 'settings' | 'hosting' | 'online' | 'skin' | 'instances' | 'resources'
  /** 内容类命中：属于哪个实例 */
  instanceId?: string
  /** 内容类命中：内容管理里哪个 tab */
  tab?: 'mods' | 'resourcepacks' | 'shaderpacks' | 'saves'
}

// ---------------- WFMC 账号（云同步账号，跟微软 / MC 正版账号完全无关） ----------------
// 只用于云备份归属、多设备管理和后台统计；密码只存我们自己的服务器。

export interface WfmcAccount {
  id: string
  username: string
  email?: string
  createdAt: number
  lastLoginAt?: number
  totpEnabled: boolean
  recoveryLeft?: number
  status?: string
  accountKind?: string
}

export interface WfmcDevice {
  deviceId: string
  name?: string
  platform?: string
  accountId?: string
  createdAt?: number
  lastSeenAt?: number
  boundAt?: number
  backups?: number
  bytes?: number
}

export interface WfmcAccountStatus {
  loggedIn: boolean
  username?: string
  /** 统一账号的邮箱 */
  email?: string
  /** 统一账号的显示名 */
  displayName?: string
  accountId?: string
  /** @deprecated 服务器地址不在界面上显示 */
  baseUrl?: string
  deviceBound?: boolean
  accountKind: 'wfmc' | 'unified'
}

export interface WfmcLoginOutcome {
  need2fa: boolean
  challengeToken?: string
  expiresIn?: number
  status?: WfmcAccountStatus
}

/** 浏览器登录统一账号的结果 */
export interface UnifiedLoginResult {
  ok: boolean
  message: string
  status?: WfmcAccountStatus
}

export interface WfmcAccountMe {
  account: WfmcAccount
  devices: WfmcDevice[]
  totalBackups?: number
  totalBytes?: number
  quotaBytes?: number
  maxBackups?: number
  accountKind?: string
}

/** 一条服务端通知（服务端表 app_notification） */
export interface NotifyItem {
  id: number
  title: string
  body: string
  url: string
  /** info | warn | important（服务端叫 important，界面上显示「重要」） */
  level: string
  /** silent | popup */
  mode: string
  createdAt: string
  /** 服务端记录的已读；未登录时永远是 false，已读状态在渲染层本地存 */
  read: boolean
}

export interface NotifyListResult {
  items: NotifyItem[]
  /** 登录了 = 服务端能记住谁读过；未登录 = 只能记在这台电脑上 */
  loggedIn: boolean
}

// ============ 模组依赖图（D：内容管理 → 依赖） ============

export interface ModGraphNode {
  /** 唯一键：真实模组用文件名，缺失前置用 `missing:<modId>` */
  key: string
  id?: string
  name: string
  version?: string
  file?: string
  loader?: string
  /** 文件大小（字节）；缺失前置节点为 0 */
  bytes: number
  disabled?: boolean
  /** true = 没装，是「缺前置」占位点 */
  missing?: boolean
  /** 缺失前置要求的版本范围（展示用） */
  range?: string
  /** 它依赖了几个 */
  out: number
  /** 几个模组依赖它 */
  in: number
}

export interface ModGraphEdge {
  from: string
  to: string
  /** depends = 正常依赖；missing = 指向缺失占位点；breaks = 明确声明不兼容 */
  kind: 'depends' | 'missing' | 'breaks'
}

export interface ModGraph {
  nodes: ModGraphNode[]
  edges: ModGraphEdge[]
  cycles: { keys: string[]; label: string }[]
  missing: { id: string; label: string; range?: string; wantedBy: string[] }[]
  stats: { mods: number; edges: number; missingCount: number; cycleCount: number }
}

/* ---------------- 服主面板 2.0：看板 / 计划任务 / 插件市场 ---------------- */

/** 一屏看完的运行时指标（都从日志和进程状态里扣出来的，没有额外后台服务） */
export interface HostedMetrics {
  running: boolean
  /** 已运行毫秒 */
  uptime: number
  players: string[]
  tps?: number
  /** 世界是否已经加载完（日志里出现 Done） */
  ready: boolean
  /** 日志里读到的已用/上限内存（MB），解析不到就是 undefined */
  usedMb?: number
  maxMb?: number
  /** 配置里给的内存上限 */
  memoryMb?: number
  port?: number
  mcVersion?: string
  mods: number
}

export interface SchedBackup {
  enabled: boolean
  everyMinutes: number
  keep: number
}

export interface SchedRestart {
  enabled: boolean
  everyMinutes: number
}

export interface SchedLog {
  enabled: boolean
  maxMb: number
  keep: number
}

export interface SchedWatchdog {
  enabled: boolean
}

export interface ServerSched {
  backup: SchedBackup
  restart: SchedRestart
  logrotate: SchedLog
  watchdog: SchedWatchdog
  lastBackupAt?: number
  lastRestartAt?: number
  lastRotateAt?: number
}

/** 插件/模组市场的一条搜索结果 */
export interface AddonHit {
  source: 'modrinth' | 'hangar'
  id: string
  title: string
  author?: string
  description: string
  downloads?: number
  iconUrl?: string
  pageUrl?: string
}

export interface AddonVersion {
  version: string
  fileUrl: string
  fileName: string
  sizeBytes?: number
  sha256?: string
  sha512?: string
  gameVersions: string[]
  loaders: string[]
  downloadCount?: number
  channel?: string
}

export interface InstalledAddon {
  fileName: string
  bytes: number
}

/* ---------------- 联机 2.0：房间环境清单 ---------------- */

export interface RoomModRef {
  file: string
  sha1: string
  size: number
}

export interface RoomManifestPayload {
  v: 1
  name: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  gamePort: number
  at: number
  mods: RoomModRef[]
}

export interface RoomManifestDiff {
  /** 有值就是直接拒绝，不要尝试补齐 */
  refuse?: string
  missing: RoomModRef[]
  mismatch: { want: RoomModRef; have: RoomModRef }[]
  /** 多出来的（只提示，不动它 —— 只增不删） */
  extra: RoomModRef[]
  manual: { title: string; reason: string }[]
  downloadBytes: number
  needsConfirm: boolean
  env: { mcVersion: string; loader: string; loaderVersion?: string }
}

export interface RoomFixResult {
  downloaded: number
  bytes: number
  skipped: number
  errors: { file: string; message: string }[]
}

/* ---------------- 存档工坊（E 方向） ---------------- */

export interface SaveWorld {
  folder: string
  /** level.dat 里的世界名（读不到就退回文件夹名） */
  name: string
  bytes: number
  files: number
  mtime: number
  hasLevel: boolean
}

export interface SaveLevelInfo {
  levelName?: string
  gameType?: number
  difficulty?: number
  hardcore?: boolean
  allowCommands?: boolean
  dayTime?: string
  time?: string
  versionName?: string
  dataVersion?: number
  spawn?: { x: number; y: number; z: number }
  lastPlayed?: string
}

export interface SaveRegion {
  name: string
  bytes: number
  mtime: number
  chunks: number
}

export interface SaveInspect {
  world: SaveWorld
  level?: SaveLevelInfo
  regions: SaveRegion[]
  raw?: { bytes: number; compression: string; sha1: string }
  /** 白名单字段里实际存在哪些（不存在的不给改） */
  editable: string[]
}

export interface LevelPatch {
  levelName?: string
  gameType?: number
  difficulty?: number
  hardcore?: boolean
  allowCommands?: boolean
  dayTime?: number
  time?: number
}

export interface PatchResult {
  changed: string[]
  skipped: { field: string; reason: string }[]
  backup: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

