import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Account, Instance, Settings } from '../shared/types'

const ENC_PREFIX = 'enc:'

/** 用系统凭据加密令牌（Windows DPAPI），落盘时不出现明文 */
function encryptToken(value?: string): string | undefined {
  if (!value) return value
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    /* 加密不可用时退回明文 */
  }
  return value
}

function decryptToken(value?: string): string | undefined {
  if (!value || !value.startsWith(ENC_PREFIX)) return value
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    return value
  }
}

const LEGACY_DIR_NAMES = ['zhudong-mc-launcher']

/** 启动器数据放在 Electron userData 下的 data/ 里，避免和 Chromium 的缓存文件混在一起 */
function defaultDataDir(): string {
  // 便携版（portable exe）优先把数据放在 exe 旁边，U 盘拷走即用
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) return path.join(portable, 'WFMC-Data')
  return path.join(app.getPath('userData'), 'data')
}

function defaultSettings(): Settings {
  return {
    dataDir: defaultDataDir(),
    theme: 'light',
    downloadSource: 'auto',
    downloadThreads: 48,
    downloadLimitKbps: 0,
    downloadDir: '',
    maxConcurrentDownloads: 8,
    maxMemory: 4096,
    minMemory: 1024,
    javaPath: '',
    extraJvmArgs: [],
    microsoftClientId: '',
    curseforgeApiKey: '',
    showLog: true,
    proxy: '',
    onboarded: false,
    updateUrl: 'steveliuyan/wfmc',
    closeToTray: true,
    autoCheckUpdate: true,
    favResources: [],
    activeAccountId: undefined
  }
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

/** 老版本（改名前）的数据目录迁移：搬到新目录，保留已装好的实例 */
function migrateLegacyDataDir() {
  // 便携版是自包含的，不把用户机器上的旧数据拖进来（那是几百 MB 的复制）
  if (process.env.PORTABLE_EXECUTABLE_DIR) return
  const target = defaultDataDir()
  if (fs.existsSync(path.join(target, 'instances'))) return
  for (const legacy of LEGACY_DIR_NAMES) {
    const old = path.join(app.getPath('appData'), legacy)
    if (!fs.existsSync(old)) continue
    try {
      fs.mkdirSync(target, { recursive: true })
      // 只搬我们需要的东西，别把旧 Chromium 缓存也拖过来
      for (const name of ['instances', 'java', 'exports', 'backups', 'servers.json', 'accounts.json']) {
        const from = path.join(old, name)
        if (!fs.existsSync(from)) continue
        fs.cpSync(from, path.join(target, name), { recursive: true, force: true })
      }
    } catch {
      /* 迁移失败就继续用默认目录 */
    }
    return
  }
}

class Store {
  private _settings: Settings = defaultSettings()
  private _accounts: Account[] = []

  /** 设置本身放在启动器根目录（换数据目录时不会丢），账号跟着数据目录走 */
  get settingsFile() {
    const portable = process.env.PORTABLE_EXECUTABLE_DIR
    const root = portable ? path.join(portable, 'WFMC-Data') : app.getPath('userData')
    return path.join(root, 'settings.json')
  }

  get accountsFile() {
    return path.join(this.dataDir, 'accounts.json')
  }

  load() {
    migrateLegacyDataDir()
    this._settings = readJson(this.settingsFile, defaultSettings())
    // 旧配置里的 dataDir 如果还是旧路径，自动纠到新默认目录（并写回，避免每次都纠）
    let corrected = false
    // 便携版：数据永远跟着 exe 走
    if (process.env.PORTABLE_EXECUTABLE_DIR && this._settings.dataDir !== defaultDataDir()) {
      this._settings.dataDir = defaultDataDir()
      corrected = true
    }
    if (!this._settings.dataDir || this._settings.dataDir.includes('zhudong-mc-launcher')) {
      this._settings.dataDir = defaultDataDir()
      corrected = true
    }
    // 首次运行也把默认值落盘，方便用户直接看/改文件
    writeJson(this.settingsFile, this._settings)
    const raw = readJson<{ accounts: Account[] }>(this.accountsFile, { accounts: [] })
    this._accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
      ...a,
      accessToken: decryptToken(a.accessToken) ?? '',
      refreshToken: decryptToken(a.refreshToken)
    }))
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.instancesDir, { recursive: true })
  }

  get settings(): Settings {
    return this._settings
  }

  setSettings(patch: Partial<Settings>): Settings {
    this._settings = { ...this._settings, ...patch }
    writeJson(this.settingsFile, this._settings)
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.instancesDir, { recursive: true })
    return this._settings
  }

  get accounts(): Account[] {
    return this._accounts
  }

  setAccounts(accounts: Account[]) {
    this._accounts = accounts
    // 落盘时加密令牌
    const onDisk = accounts.map((a) => ({
      ...a,
      accessToken: encryptToken(a.accessToken) ?? '',
      refreshToken: encryptToken(a.refreshToken)
    }))
    writeJson(this.accountsFile, { accounts: onDisk })
  }

  /** 当前选中的账号（多账号切换用） */
  get activeAccount(): Account | undefined {
    const id = this._settings.activeAccountId
    return this._accounts.find((a) => a.id === id) ?? this._accounts[0]
  }

  get dataDir() {
    return this._settings.dataDir || defaultDataDir()
  }

  get instancesDir() {
    return path.join(this.dataDir, 'instances')
  }

  get javaDir() {
    return path.join(this.dataDir, 'java')
  }

  get exportsDir() {
    return path.join(this.dataDir, 'exports')
  }

  get backupsDir() {
    return path.join(this.dataDir, 'backups')
  }

  instanceDir(id: string) {
    return path.join(this.instancesDir, id)
  }

  /** 每个实例独立的 .minecraft 目录 */
  instanceGameDir(id: string) {
    return path.join(this.instanceDir(id), 'minecraft')
  }

  instanceFile(id: string) {
    return path.join(this.instanceDir(id), 'instance.json')
  }

  listInstances(): Instance[] {
    const dir = this.instancesDir
    if (!fs.existsSync(dir)) return []
    const out: Instance[] = []
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name, 'instance.json')
      if (!fs.existsSync(file)) continue
      try {
        out.push(JSON.parse(fs.readFileSync(file, 'utf-8')))
      } catch {
        /* 跳过损坏实例 */
      }
    }
    // installed 按磁盘实际情况算，别信 instance.json 里的旧值（否则装好了还显示未安装）
    for (const it of out) {
      const vId = it.versionId || it.mcVersion
      const gameDir = this.instanceGameDir(it.id)
      const jar = path.join(gameDir, 'versions', vId, vId + '.jar')
      const json = path.join(gameDir, 'versions', vId, vId + '.json')
      it.installed = fs.existsSync(jar) && fs.existsSync(json)
    }
    return out.sort((a, b) => (b.lastPlayed ?? b.createdAt) - (a.lastPlayed ?? a.createdAt))
  }

  getInstance(id: string): Instance | undefined {
    return this.listInstances().find((i) => i.id === id)
  }

  saveInstance(instance: Instance) {
    writeJson(this.instanceFile(instance.id), instance)
  }
}

export const store = new Store()
