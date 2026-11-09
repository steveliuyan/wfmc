import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Account, Instance, Settings } from '../shared/types'
import { migrateSettings } from './config-migrate'

const ENC_PREFIX = 'enc:'

/** 用系统凭据加密令牌（Windows DPAPI），落盘时不出现明文 */
export function encryptToken(value?: string): string | undefined {
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

export function decryptToken(value?: string): string | undefined {
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
    downloadSource: 'mirror',
    downloadThreads: 32,
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

/**
 * 这台机器上可能存过启动器数据的地方。
 *
 * 「更新一版数据就没了」几乎从来不是文件真被删 —— 是**指向变了**：
 * 软件改过名（zhudong-mc-launcher → 诛冬启动器 → WFMC），
 * 而且便携版的数据在 exe 旁边、安装版的数据在 %APPDATA%\\WFMC\\data，两套目录互不相干。
 * 所以每次启动都把这些地方扫一遍，谁有内容就用谁。
 */
function dataCandidates(): string[] {
  const appData = app.getPath('appData')
  const list: string[] = []
  const push = (p?: string) => {
    if (!p) return
    const abs = path.resolve(p)
    if (!list.includes(abs)) list.push(abs)
  }
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) {
    push(path.join(portable, 'WFMC-Data'))
  } else {
    push(path.join(app.getPath('userData'), 'data'))
    // 安装版也可能先跑过便携版：exe 旁边有 WFMC-Data / data 都算候选
    const exeDir = path.dirname(process.execPath)
    push(path.join(exeDir, 'WFMC-Data'))
    push(path.join(exeDir, 'data'))
  }
  push(path.join(appData, 'WFMC', 'data'))
  for (const legacy of LEGACY_DIR_NAMES) {
    push(path.join(appData, legacy)) // 老版本数据直接放根目录
    push(path.join(appData, legacy, 'data'))
  }
  push(path.join(appData, '诛冬启动器', 'data'))
  push(path.join(appData, '诛冬启动器'))
  return list
}

/** 这个目录下有几个实例（认 instances/<id>/instance.json） */
function countInstances(dir: string): number {
  try {
    const inst = path.join(dir, 'instances')
    if (!fs.existsSync(inst)) return 0
    return fs.readdirSync(inst).filter((n) => fs.existsSync(path.join(inst, n, 'instance.json'))).length
  } catch {
    return 0
  }
}

function readAccountList(dir: string): Account[] {
  const raw = readJson<{ accounts: Account[] }>(path.join(dir, 'accounts.json'), { accounts: [] })
  return Array.isArray(raw.accounts) ? raw.accounts : []
}

/** 一份数据「有多像真的」：实例算大头，账号其次 */
function dataScore(dir: string): number {
  if (!dir || !fs.existsSync(dir)) return 0
  let score = countInstances(dir) * 10 + readAccountList(dir).length * 3
  for (const name of ['java', 'backups', 'exports', 'servers', 'downloads']) {
    if (fs.existsSync(path.join(dir, name))) score += 1
  }
  return score
}

/**
 * 找账号时的目录清单：比 dataCandidates() 更宽。
 * 便携版为了「自己一个文件夹里装得下」，dataDir 只在 exe 旁边找；
 * 但账号不一样 —— 从安装版换到便携版（或者反过来）时，账号一定要捞回来，
 * 所以这里把 %APPDATA% 下所有叫过这个名字的目录也算进来。
 */
function accountSources(): string[] {
  const list = [...dataCandidates()]
  const push = (p?: string) => {
    if (!p) return
    const abs = path.resolve(p)
    if (!list.includes(abs)) list.push(abs)
  }
  const appData = app.getPath('appData')
  push(app.getPath('userData'))
  push(path.join(app.getPath('userData'), 'data'))
  push(path.join(appData, 'WFMC'))
  push(path.join(appData, 'WFMC', 'data'))
  for (const legacy of LEGACY_DIR_NAMES) {
    push(path.join(appData, legacy))
    push(path.join(appData, legacy, 'data'))
  }
  push(path.join(appData, '诛冬启动器'))
  push(path.join(appData, '诛冬启动器', 'data'))
  return list
}

/** 安装版 exe 所在目录（便携版在临时目录里跑，不返回） */
function installDirOf(): string | undefined {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return undefined
  return path.resolve(path.dirname(process.execPath))
}

/** 这个目录是不是在安装目录里 —— 更新安装包会把整个安装目录清掉 */
function insideInstallDir(dir: string): boolean {
  const root = installDirOf()
  if (!root) return false
  const abs = path.resolve(dir)
  return abs === root || abs.startsWith(root + path.sep)
}

/** load() 里「自动接上了旧数据」这件事，留给界面说一句话（只报一次） */
let lastAdopt: { from: string; to: string; accounts: number } | null = null
/** dataSize() 的缓存：目录 → 时间和结果（同一目录 5 分钟内不重复走盘） */
const sizeCache = new Map<string, { at: number; value: { bytes: number; files: number; partial: boolean } }>()

/**
 * 数据继承（两件事）：
 * 1) 当前目录没东西（或者比别处少）→ 只改「指向」，指到机器上最有内容的那份
 *    （不复制几百 MB 的游戏文件）
 * 2) 账号永远是并集 → 各处的 accounts.json 都并进来（按 id/uuid 去重），账号最不容易丢
 * 返回是否改动了设置。
 */
function adoptExistingData(settings: Settings): boolean {
  const candidates = dataCandidates()
  const cur = settings.dataDir || defaultDataDir()
  let changed = false
  // dataDirCustom = 用户自己挑过目录，别再替他做主
  if (!settings.dataDirCustom) {
    const curScore = dataScore(cur)
    let best = ''
    let bestScore = curScore
    for (const dir of candidates) {
      if (path.resolve(dir) === path.resolve(cur)) continue
      // 安装目录里的那份别接：更新安装包时整个安装目录会被清掉（见 setDataDir 的注释）
      if (insideInstallDir(dir)) continue
      const s = dataScore(dir)
      if (s > bestScore) {
        bestScore = s
        best = dir
      }
    }
    if (best) {
      settings.dataDir = best
      // 打上「自己挑过」的标记：便携版别再把它纠回 exe 旁边，否则刚找回来的数据下次又没了
      settings.dataDirCustom = true
      settings.useSharedData = false
      changed = true
      lastAdopt = { from: cur, to: best, accounts: 0 }
    }
  }
  try {
    const keep = readAccountList(settings.dataDir)
    const seen = new Set(keep.map((a) => a.id || a.uuid))
    let added = 0
    for (const dir of accountSources()) {
      if (path.resolve(dir) === path.resolve(settings.dataDir)) continue
      for (const a of readAccountList(dir)) {
        const key = a.id || a.uuid
        if (!key || seen.has(key)) continue
        seen.add(key)
        keep.push(a)
        added++
      }
    }
    if (added > 0) {
      writeJson(path.join(settings.dataDir, 'accounts.json'), { accounts: keep })
      changed = true
      if (!lastAdopt) lastAdopt = { from: '', to: settings.dataDir, accounts: 0 }
      lastAdopt.accounts += added
    }
  } catch {
    /* 合并账号失败不影响启动 */
  }
  return changed
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
    this._settings = readJson(this.settingsFile, defaultSettings())
    // 旧配置里的 dataDir 如果还是旧路径，自动纠到新默认目录（并写回，避免每次都纠）
    let corrected = false
    // 便携版：数据默认跟着 exe 走；用户可以显式选择「用本机已有的那份数据」（useSharedData），
    // 也可以自己挑一个目录（dataDirCustom）—— 自己挑过就不要再纠回去，
    // 否则「设置里改完数据目录，重启又变回 WFMC-Data」（用户报过）。
    if (process.env.PORTABLE_EXECUTABLE_DIR && !this._settings.dataDirCustom) {
      const want = this._settings.useSharedData ? this.sharedDataDir() : defaultDataDir()
      if (this._settings.dataDir !== want) {
        this._settings.dataDir = want
        corrected = true
      }
    }
    if (!this._settings.dataDir) {
      this._settings.dataDir = defaultDataDir()
      corrected = true
    }
    // 数据继承：装了新版本 / 便携版跟安装版换来换去之后，别让玩家看到「数据全没了」
    if (adoptExistingData(this._settings)) corrected = true
    // 老配置里的各种兼容补丁：统一走 config-migrate 的有序迁移（见 src/main/config-migrate.ts）
    const mig = migrateSettings(this._settings)
    if (mig.applied.length > 0) {
      console.log(`[settings] 配置迁移 v${mig.from} → v${mig.to}：${mig.applied.join('；')}`)
    }
    if (mig.changed) corrected = true
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
    this.backup(this.settingsFile)
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
    // 当前选中的账号被删/被覆盖掉时别留一个悬空 id，否则界面上「当前账号」是空的
    const active = this._settings.activeAccountId
    if (active && !accounts.some((a) => a.id === active)) {
      this._settings.activeAccountId =
        accounts.find((a) => a.type === 'microsoft')?.id ?? accounts[0]?.id ?? ''
      writeJson(this.settingsFile, this._settings)
    }
    // 落盘时加密令牌
    const onDisk = accounts.map((a) => ({
      ...a,
      accessToken: encryptToken(a.accessToken) ?? '',
      refreshToken: encryptToken(a.refreshToken)
    }))
    this.backup(this.accountsFile)
    writeJson(this.accountsFile, { accounts: onDisk })
  }

  /** 写之前留一份上一版：手滑删号 / 写坏文件还能从 .bak 捞回来 */
  private backup(file: string) {
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak')
    } catch {
      /* 备份失败不影响正常写入 */
    }
  }

  /** 界面取一次「刚自动接上了旧数据」的说明，取完就清掉（只提示一次） */
  adoptInfo() {
    const info = lastAdopt
    lastAdopt = null
    return info
  }

  /** 设置页「找回旧数据」：列出机器上各份数据，各自有实例几个、账号几个 */
  discoverData() {
    const active = path.resolve(this.dataDir)
    return accountSources()
      .map((dir) => ({
        dir,
        name: path.basename(dir) || dir,
        instances: countInstances(dir),
        accounts: readAccountList(dir).length,
        score: dataScore(dir),
        active: path.resolve(dir) === active
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
  }

  /** 看某个目录像不像一份启动器数据（用户手动挑目录时用） */
  inspectDataDir(dir: string) {
    const abs = path.resolve(dir)
    return {
      dir: abs,
      name: path.basename(abs) || abs,
      instances: countInstances(abs),
      accounts: readAccountList(abs).length,
      score: dataScore(abs),
      active: abs === path.resolve(this.dataDir)
    }
  }

  /**
   * 全盘扫一遍「别的盘里还有没有数据」。
   * discoverData() 只认固定位置（%APPDATA%、exe 旁边、老名字）；
   * 用户把数据放过别的盘（比如 F:\data），就只能靠扫。
   * 只往下两层（盘符根的子目录 → 再一层），命中 instances/ 或 accounts.json 才算数；
   * 系统目录 / 依赖目录直接跳过，免得扫 Windows 扫到天荒地老。
   */
  async scanDrivesForData(): Promise<
    { dir: string; name: string; instances: number; accounts: number; score: number; active: boolean }[]
  > {
    const skip = new Set([
      'windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin',
      'system volume information', 'recovery', 'perflogs', 'msocache', 'config.msi',
      '$windows.~bt', '$windows.~ws', 'node_modules', '.git', 'appdata', 'onedrivetemp'
    ])
    const found: string[] = []
    const seen = new Set<string>()
    const hit = (dir: string) => {
      const abs = path.resolve(dir)
      if (seen.has(abs)) return
      seen.add(abs)
      // 只认「像启动器数据」的目录：有 instances 或者有 accounts.json
      if (!fs.existsSync(path.join(abs, 'instances')) && !fs.existsSync(path.join(abs, 'accounts.json'))) return
      if (dataScore(abs) <= 0) return
      found.push(abs)
    }
    const subdirs = (dir: string): string[] => {
      try {
        return fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name.toLowerCase()))
          .map((e) => path.join(dir, e.name))
      } catch {
        return []
      }
    }
    const drives = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
      .split('')
      .map((d) => `${d}:\\`)
      .filter((r) => {
        try {
          return fs.existsSync(r)
        } catch {
          return false
        }
      })
    for (const root of drives) {
      hit(root)
      for (const d1 of subdirs(root)) {
        hit(d1)
        for (const d2 of subdirs(d1)) hit(d2)
      }
      // 一个盘扫完让出一次事件循环：界面不卡，任务列表也还能刷
      await new Promise<void>((r) => setImmediate(r))
    }
    const active = path.resolve(this.dataDir)
    return found
      .map((dir) => ({
        dir,
        name: path.basename(dir) || dir,
        instances: countInstances(dir),
        accounts: readAccountList(dir).length,
        score: dataScore(dir),
        active: path.resolve(dir) === active
      }))
      .sort((a, b) => b.score - a.score)
  }

  /** 指到某一份旧数据上，并把别处的账号一起并过来 */
  adoptDir(dir: string) {
    const abs = path.resolve(dir)
    if (!fs.existsSync(abs)) throw new Error(`目录不存在：${abs}`)
    this.setSettings({ dataDir: abs, dataDirCustom: true, useSharedData: false })
    adoptExistingData(this._settings)
    writeJson(this.settingsFile, this._settings)
    this.reloadAccounts()
    lastAdopt = null // 是用户自己点的，设置页会 toast，别再重复提示
    return { dir: abs, instances: countInstances(abs), accounts: this._accounts.length }
  }

  /**
   * 一键清空：只清「记录」，不动游戏文件（versions/mods/saves 一个字节都不碰）。
   * - accounts：清空账号列表（accounts.json 留 .bak，后悔还能从 .bak 捞）
   * - playtime：把所有实例的累计游玩时长 / 最近启动时间归零
   */
  clearData(target: 'accounts' | 'playtime') {
    if (target === 'accounts') {
      const n = this._accounts.length
      this.backup(this.accountsFile)
      writeJson(this.accountsFile, { accounts: [] })
      this._accounts = []
      this.setSettings({ activeAccountId: undefined })
      return { target, cleared: n, detail: this.dataDir }
    }
    let n = 0
    for (const it of this.listInstances()) {
      if (!it.playTimeMs && !it.lastPlayed) continue
      this.saveInstance({ ...it, playTimeMs: 0, lastPlayed: undefined })
      n++
    }
    return { target, cleared: n, detail: this.dataDir }
  }

  /**
   * 一键删除数据：把当前数据目录里的东西整个清掉（实例、版本、mods、存档、账号、日志），
   * 目录本身留着，启动器还能接着用。删之前先把 accounts.json 备份成 .bak，万一后悔还能捞。
   */
  async wipeData(): Promise<{ dir: string; removed: number; failed: number; accountBackup: boolean }> {
    const dir = path.resolve(this.dataDir)
    if (!fs.existsSync(dir)) throw new Error(`数据目录不存在：${dir}`)
    const install = this.installDir()
    if (install && dir === path.resolve(install)) throw new Error('数据目录就是安装目录，这里不敢整个删掉')
    if (path.parse(dir).root === dir) throw new Error('数据目录是盘符根目录，这里不敢整个删掉')

    let accountBackup = false
    try {
      if (fs.existsSync(this.accountsFile)) {
        this.backup(this.accountsFile)
        accountBackup = true
      }
    } catch {
      /* 备份失败也继续删，用户已经确认过了 */
    }

    let removed = 0
    let failed = 0
    for (const name of await fs.promises.readdir(dir)) {
      try {
        await fs.promises.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 2 })
        removed++
      } catch {
        failed++
      }
    }

    this._accounts = []
    this.setSettings({ activeAccountId: undefined })
    this.reloadAccounts()
    return { dir, removed, failed, accountBackup }
  }

  /**
   * 换目录时把旧目录的数据复制到新目录（只复制，不删旧的 —— 用户确认过了再自己清理）。
   * 目标里已经存在的同名文件跳过，不覆盖。
   */
  async migrateData(
    fromDir: string,
    onProgress?: (p: { phase: string; current: number; total: number }) => void
  ): Promise<{ from: string; to: string; copied: number; skipped: number; bytes: number; accounts: number }> {
    const from = path.resolve(fromDir)
    const to = path.resolve(this.dataDir)
    if (from === to) throw new Error('新旧目录是同一个，不用迁移')
    if (!fs.existsSync(from)) throw new Error(`旧目录不存在：${from}`)
    if (to.startsWith(from + path.sep)) throw new Error('新目录在旧目录里面，这样会自己复制自己')
    if (from.startsWith(to + path.sep)) throw new Error('旧目录在新目录里面，这样会自己复制自己')

    const files: string[] = []
    const walk = async (d: string) => {
      let ents: fs.Dirent[]
      try {
        ents = await fs.promises.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) files.push(p)
      }
    }
    onProgress?.({ phase: '统计待迁移文件', current: 0, total: 0 })
    await walk(from)

    const total = files.length
    let copied = 0
    let skipped = 0
    let bytes = 0
    for (let i = 0; i < files.length; i++) {
      const src = files[i]
      const dest = path.join(to, path.relative(from, src))
      try {
        if (fs.existsSync(dest)) {
          skipped++
        } else {
          await fs.promises.mkdir(path.dirname(dest), { recursive: true })
          await fs.promises.copyFile(src, dest)
          const st = await fs.promises.stat(dest)
          bytes += st.size
          copied++
        }
      } catch {
        skipped++
      }
      if (i % 20 === 0 || i === files.length - 1) {
        onProgress?.({ phase: '复制数据', current: i + 1, total })
      }
    }

    // 账号按 id 并进去（目标里已有的不动），别整份覆盖
    this.reloadAccounts()
    const oldAccounts = readAccountList(from)
    let added = 0
    if (oldAccounts.length) {
      const cur = this._accounts.slice()
      const seen = new Set(cur.map((a) => a.id || a.uuid))
      for (const a of oldAccounts) {
        const key = a.id || a.uuid
        if (!key || seen.has(key)) continue
        seen.add(key)
        cur.push(a)
        added++
      }
      if (added) {
        this.backup(this.accountsFile)
        writeJson(this.accountsFile, { accounts: cur })
        this._accounts = cur
      }
    }

    return { from, to, copied, skipped, bytes, accounts: added }
  }
  /**
   * 数据目录占多大。设置页/数据面板要显示，但 data 里可能有几十 GB，
   * 所以：异步走、最多 2.5 秒（超时就标记 partial）、结果缓存 5 分钟。
   */
  async dataSize(): Promise<{ dir: string; bytes: number; files: number; partial: boolean }> {
    const dir = this.dataDir
    const hit = sizeCache.get(dir)
    if (hit && Date.now() - hit.at < 5 * 60_000) return { ...hit.value, dir }
    const deadline = Date.now() + 2500
    let bytes = 0
    let files = 0
    let partial = false
    const walk = async (d: string) => {
      if (Date.now() > deadline) {
        partial = true
        return
      }
      let ents: fs.Dirent[]
      try {
        ents = await fs.promises.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) await walk(p)
        else if (e.isFile()) {
          try {
            bytes += (await fs.promises.stat(p)).size
            files++
          } catch {
            /* 被占用/没权限就跳过 */
          }
        }
      }
    }
    await walk(dir)
    const value = { bytes, files, partial, at: Date.now() }
    sizeCache.set(dir, { at: value.at, value: { bytes, files, partial } })
    return { dir, bytes, files, partial }
  }

  /** 当前选中的账号（多账号切换用） */
  get activeAccount(): Account | undefined {
    const id = this._settings.activeAccountId
    return this._accounts.find((a) => a.id === id) ?? this._accounts[0]
  }

  get dataDir() {
    return this._settings.dataDir || defaultDataDir()
  }

  /** 本机「安装版」的数据目录——便携版想借用已有数据时指向这里 */
  sharedDataDir() {
    return path.join(app.getPath('appData'), 'WFMC', 'data')
  }

  /** 便携版切换数据来源：true = 用本机已安装的那份，false = 用自己的 WFMC-Data */
  setSharedData(on: boolean) {
    const dir = on ? this.sharedDataDir() : defaultDataDir()
    this.setSettings({ useSharedData: on, dataDir: dir, dataDirCustom: false })
    this.reloadAccounts()
    return dir
  }

  /** 用户手动指定数据目录（之后便携版也不会再把它纠回默认） */
  setDataDir(dir: string) {
    const abs = path.resolve(dir)
    if (this.isInsideInstallDir(abs)) {
      throw new Error(
        `不能把数据目录放在安装目录里（${this.installDir()}）——更新或卸载安装包时会把整个安装目录清掉，` +
          `游戏版本和存档会一起没。请换一个安装目录外面的文件夹，比如 D:\\WFMC-Data。`
      )
    }
    fs.mkdirSync(abs, { recursive: true })
    this.setSettings({ dataDir: abs, dataDirCustom: true, useSharedData: false })
    this.reloadAccounts()
    return abs
  }

  /**
   * 安装版 exe 所在的目录（便携版不返回 —— 它本来就在临时目录里跑）。
   *
   * 为什么要盯着这个：NSIS 安装包在「更新」时会把整个安装目录挪走再删掉，
   * 用户如果顺手把数据目录设在安装目录里（装到 D:\WFMC、数据选 D:\WFMC\data），
   * 每更新一次 data 就整个没了。安装包那边已经改成只删程序文件（build\installer.nsh
   * 的 customRemoveFiles），这里再从应用侧拦一道：不允许新选这种目录，已经选了的要提示。
   */
  installDir(): string | undefined {
    return installDirOf()
  }

  isInsideInstallDir(dir: string): boolean {
    return insideInstallDir(dir)
  }

  /** 数据目录「体检」：界面拿它显示风险提示 */
  dataHealth() {
    return {
      dir: this.dataDir,
      installDir: this.installDir() ?? '',
      insideInstall: this.isInsideInstallDir(this.dataDir)
    }
  }

  /** 换数据目录之后账号也要重读（实例列表是按需读盘的，不用管） */
  reloadAccounts() {
    const raw = readJson<{ accounts: Account[] }>(this.accountsFile, { accounts: [] })
    this._accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
      ...a,
      accessToken: decryptToken(a.accessToken) ?? '',
      refreshToken: decryptToken(a.refreshToken)
    }))
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
      const verDir = path.join(gameDir, 'versions', vId)
      const jar = path.join(verDir, vId + '.jar')
      const jsonPath = path.join(verDir, vId + '.json')
      let ok = fs.existsSync(jsonPath)
      if (ok && !fs.existsSync(jar)) {
        // 带加载器的版本没有自己的 jar，靠 inheritsFrom 指向原版；原版 jar 也在才算装好
        try {
          const vj = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as { inheritsFrom?: string }
          const base = vj.inheritsFrom
          ok = !!base && fs.existsSync(path.join(gameDir, 'versions', base, base + '.jar'))
        } catch {
          ok = false
        }
      }
      it.installed = ok
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
