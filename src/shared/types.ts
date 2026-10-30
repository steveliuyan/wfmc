// 全局共享类型（主进程 + 渲染进程共用）
export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'
export type ThemeMode = 'light' | 'dark' | 'system'

export interface Settings {
  /** 数据根目录（实例、运行时、配置文件都在这） */
  dataDir: string
  /** 便携版专用：true = 直接用本机安装版的那份数据（%APPDATA%/WFMC/data），false = 用自己的 WFMC-Data */
  useSharedData?: boolean
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
  /** 点窗口 ✕ 时最小化到托盘（服务端还在跑时不退出） */
  closeToTray?: boolean
  /** 开机自动检查更新 */
  autoCheckUpdate?: boolean
  /** 收藏的模组 / 光影 / 资源包（手机上叫收藏夹，这里存最小信息免得每次重查） */
  favResources?: FavResource[]
  /** 把老的「自动测速」一次性迁到国内镜像，迁过就不再动 */
  mirrorMigrated?: boolean
  /** 首页下面几块卡片的排列顺序（自己拖着改的） */
  homeLayout?: string[]
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