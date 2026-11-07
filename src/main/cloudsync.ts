/**
 * 备份编排（本地优先，云端可选）。
 *
 * 三层：
 *   1. unifiedapi.ts / cloudsnap.ts —— 纯网络层，不 import electron
 *   2. 这个文件     —— 打配置包、本地落盘、云端同步、调度、写 settings
 *   3. ipc.ts       —— 薄壳，一个通道一个函数
 *
 * 设计原则：
 *   - **先本地，再云端**：每次备份都先在本地留一份 zip，云端只是「顺便」多一份，
 *     没登录 / 没网 / 服务器挂了都不影响本机有备份。
 *   - 云端只认统一账号（api.20050905.xyz），地址不出现在界面上，也不允许改。
 *   - 保留份数由服务端定（自动 3 / 手动 5，管理后台可改），客户端只读展示。
 */
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { store, decryptToken, encryptToken } from './store'
import { listNotifications } from './notify'
import { buildConfigBundle, applyConfigBundle, type ConfigBundleInfo } from './configpack'
import { LocalProvider, WebdavProvider, normalizeStorageKind } from './storage'
import * as unified from './cloudlogin'
import * as snap from './cloudsnap'
import type { StorageProvider } from './storage'
import type { CloudAnnouncement, CloudBackup, CloudHealth, CloudSettings, CloudStatus, StorageKind } from '../shared/types'

/** 本地只留最近几份（云端那套保留份数是服务端管的，本地自己管自己） */
const LOCAL_KEEP = 5

/** WebDAV 密码和账号令牌一样，只进加密文件，绝不进 settings / 配置包 */
function secretFile(): string {
  return path.join(store.dataDir, 'cloud-auth.json')
}

interface Secrets {
  webdavPass?: string
  savedAt?: number
}

function readSecrets(): Secrets {
  try {
    return JSON.parse(fs.readFileSync(secretFile(), 'utf-8')) as Secrets
  } catch {
    return {}
  }
}

function writeSecrets(patch: Secrets): Secrets {
  const next: Secrets = { ...readSecrets(), ...patch, savedAt: Date.now() }
  fs.mkdirSync(path.dirname(secretFile()), { recursive: true })
  fs.writeFileSync(secretFile(), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

function getSettings(): CloudSettings {
  return (
    store.settings.cloud ?? {
      // 出厂默认：本地备份 + 定时；云端要用户自己登录账号后才会有
      enabled: true,
      storage: 'local',
      autoBackup: true,
      intervalH: 6,
      announcements: true
    }
  )
}

export function saveCloudSettings(patch: Partial<CloudSettings>): CloudSettings {
  const cur = getSettings()
  const next: CloudSettings = { ...cur, ...patch }
  // 地址、设备名、保留份数这类字段已经废弃：界面不再提供，旧 settings 里残留的直接丢掉
  delete next.baseUrl
  delete next.deviceName
  delete next.keep
  if (typeof next.intervalH !== 'number' || next.intervalH < 1) next.intervalH = 6
  next.storage = normalizeStorageKind(next.storage)
  store.setSettings({ cloud: next })
  if (
    patch.enabled !== undefined ||
    patch.autoBackup !== undefined ||
    patch.intervalH !== undefined ||
    patch.storage !== undefined
  ) {
    restartCloudScheduler()
  }
  return next
}

// ------------------------------------------------------------ 登录状态

/** 有没有登录统一账号（原来叫「有没有设备令牌」） */
export function hasCloudToken(): boolean {
  return unified.isLoggedIn()
}

export function isCloudConfigured(): boolean {
  return unified.isLoggedIn()
}

export function cloudAccount(): { loggedIn: boolean; email?: string; displayName?: string; userId?: string } {
  return unified.accountInfo()
}

/** 浏览器登录统一账号 */
export async function loginCloud(): Promise<{ ok: boolean; message: string }> {
  const r = await unified.login()
  if (r.ok) {
    saveCloudSettings({ lastError: undefined, lastOkAt: Date.now() })
    restartCloudScheduler()
  } else if (r.message) {
    saveCloudSettings({ lastError: r.message })
  }
  return { ok: r.ok, message: r.message }
}

export function logoutCloud(): { loggedIn: boolean } {
  unified.logout()
  return { loggedIn: false }
}

/** 服务端当前生效的保留份数（只读；改要去管理后台） */
export async function cloudLimits(): Promise<{ autoKeep: number; manualKeep: number }> {
  if (!unified.isLoggedIn()) return { autoKeep: 3, manualKeep: 5 }
  try {
    const r = await snap.snapshots()
    return r.limits
  } catch {
    return { autoKeep: 3, manualKeep: 5 }
  }
}

// ------------------------------------------------------------ 备份位置

export function storageKind(): StorageKind {
  return normalizeStorageKind(getSettings().storage)
}

export function defaultLocalDir(): string {
  return path.join(store.dataDir, 'backups')
}

export function webdavSettings(): { url: string; username: string; dir: string; hasPass: boolean } {
  const w = getSettings().webdav ?? {}
  return {
    url: (w.url ?? '').trim(),
    username: (w.username ?? '').trim(),
    dir: (w.dir ?? '').trim(),
    hasPass: !!decryptToken(readSecrets().webdavPass)
  }
}

export function saveWebdavSettings(patch: {
  url?: string
  username?: string
  dir?: string
  password?: string
}): CloudSettings {
  const cur = getSettings()
  const webdav = { ...(cur.webdav ?? {}) }
  if (patch.url !== undefined) webdav.url = patch.url.trim()
  if (patch.username !== undefined) webdav.username = patch.username.trim()
  if (patch.dir !== undefined) webdav.dir = patch.dir.trim()
  const next: CloudSettings = { ...cur, webdav }
  store.setSettings({ cloud: next })
  if (patch.password !== undefined) {
    writeSecrets({ webdavPass: patch.password ? encryptToken(patch.password) : undefined })
  }
  return next
}

export function saveLocalDir(dir: string): CloudSettings {
  const cur = getSettings()
  const next: CloudSettings = { ...cur, localDir: String(dir ?? '').trim() }
  store.setSettings({ cloud: next })
  return next
}

/** 本地备份目录（用户没选就用数据目录下的 backups） */
export function localDir(): string {
  return (getSettings().localDir ?? '').trim() || defaultLocalDir()
}

function localProvider(): LocalProvider {
  return new LocalProvider(localDir())
}

export function providerFor(kind: StorageKind): StorageProvider {
  if (kind === 'webdav') {
    const w = webdavSettings()
    if (!w.url) throw new Error('还没填 WebDAV 地址')
    const pass = decryptToken(readSecrets().webdavPass)
    if (!w.username || !pass) throw new Error('还没填 WebDAV 账号 / 应用密码')
    return new WebdavProvider({ url: w.url, username: w.username, password: pass, dir: w.dir || '/wfmc' })
  }
  return localProvider()
}

export function currentProvider(): StorageProvider {
  return providerFor(storageKind() === 'webdav' ? 'webdav' : 'local')
}

export function storageTarget(kind: StorageKind = storageKind()): string {
  if (kind === 'webdav') {
    const w = webdavSettings()
    return `${w.url}${w.dir || '/wfmc'}`
  }
  return localDir()
}

export async function testStorage(): Promise<{ ok: boolean; message: string }> {
  try {
    // 本地目录永远要能用；云端单独测（没登录就明说没登录）
    const r = await localProvider().test()
    if (!r.ok) {
      saveCloudSettings({ lastError: r.message })
      return { ok: false, message: r.message }
    }
    if (!unified.isLoggedIn()) {
      return { ok: true, message: `本地备份目录可用：${localDir()}（云端还没登录，暂时只备份到本地）` }
    }
    const t = await snap.snapshots()
    saveCloudSettings({ lastOkAt: Date.now(), lastError: undefined })
    return {
      ok: true,
      message: `本地目录可用，云端也通（现有 ${t.items.length} 份备份，自动保留 ${t.limits.autoKeep} 份 / 手动 ${t.limits.manualKeep} 份）`
    }
  } catch (e) {
    const msg = (e as Error).message
    saveCloudSettings({ lastError: msg })
    return { ok: false, message: msg }
  }
}

/** 兼容旧调用：搬迁已经没意义（云端 = 本地 + 统一账号），保留成空实现 */
export async function migrateBackups(_from?: StorageKind): Promise<{
  ok: boolean
  copied: number
  skipped: number
  failed: string[]
  message: string
}> {
  return { ok: true, copied: 0, skipped: 0, failed: [], message: '现在备份总是先落本地，不需要搬迁' }
}

// ------------------------------------------------------------ 连接测试

export async function testCloudConnection(): Promise<{ health?: CloudHealth; authorized: boolean; message: string }> {
  if (!unified.isLoggedIn()) {
    return { authorized: false, message: '还没登录统一账号，点「用浏览器登录」' }
  }
  try {
    const r = await unified.refresh()
    if (!r.ok) {
      saveCloudSettings({ lastError: r.message })
      return { authorized: false, message: r.message }
    }
    const h = await (await import('./unifiedapi')).health()
    saveCloudSettings({ lastOkAt: Date.now(), lastError: undefined })
    return {
      authorized: true,
      health: { ok: true, version: h?.version, note: h?.note },
      message: `已连上账号服务${h?.version ? '（v' + h.version + '）' : ''}：${r.account.email ?? ''}`
    }
  } catch (e) {
    const msg = (e as Error).message
    saveCloudSettings({ lastError: msg })
    return { authorized: false, message: msg }
  }
}

// ------------------------------------------------------------ 备份 / 还原

/**
 * 备份一次：**先本地落一份 zip，再（如果登录了）同步到云端并打一个手动快照。**
 * 云端失败不影响本地成功，返回信息里会写清楚各自结果。
 */
export async function uploadConfigBackup(
  onProgress?: (p: { phase: string; loaded: number; total: number }) => void
): Promise<{
  ok: boolean
  bundle?: ConfigBundleInfo
  remote?: CloudBackup
  pruned?: number
  message: string
}> {
  if (!getSettings().enabled) return { ok: false, message: '备份已关闭（设置 → 云备份里可以打开）' }
  let bundle: ConfigBundleInfo
  try {
    onProgress?.({ phase: '打包配置', loaded: 0, total: 1 })
    bundle = buildConfigBundle()
  } catch (e) {
    const msg = `打包失败：${(e as Error).message}`
    saveCloudSettings({ lastError: msg })
    return { ok: false, message: msg }
  }

  const parts: string[] = []
  let localOk = false
  let remote: CloudBackup | undefined

  try {
    // ---- 1) 本地（永远做，这一步成功才算备份成功）
    onProgress?.({ phase: '存到本地', loaded: 0, total: bundle.bytes })
    const lp = localProvider()
    const localItem = await lp.put(bundle.path, {
      kind: 'config',
      sha256: bundle.sha256,
      createdAt: Date.now(),
      appVersion: app.getVersion()
    })
    await lp.prune?.(LOCAL_KEEP).catch(() => 0)
    localOk = true
    parts.push(`本地 ${(bundle.bytes / 1024 / 1024).toFixed(1)} MB（${localItem.id}）`)

    // ---- 2) 云端（登录了才做；失败只记错，不当整体失败）
    if (unified.isLoggedIn()) {
      onProgress?.({ phase: '同步到云端', loaded: 0, total: bundle.bytes })
      await snap.pushBundle(bundle.path, { sha256: bundle.sha256, appVersion: app.getVersion() })
      const label = `手动备份 ${new Date().toLocaleString('zh-CN')}`
      const s = await snap.createSnapshot(label)
      remote = {
        id: String(s.id),
        kind: 'config',
        size: s.bytes,
        createdAt: s.createdAt,
        note: label
      }
      parts.push(`云端快照 #${s.id}`)
      onProgress?.({ phase: '完成', loaded: bundle.bytes, total: bundle.bytes })
    } else {
      parts.push('云端未登录，只存了本地')
    }
    saveCloudSettings({ lastBackupAt: Date.now(), lastError: undefined })
    return {
      ok: true,
      bundle,
      remote,
      pruned: 0,
      message: `已备份：${parts.join('，')}（含账号 ${bundle.includes.accounts} 个、实例 ${bundle.includes.instances} 个）`
    }
  } catch (e) {
    const msg = (e as Error).message
    if (localOk) {
      // 本地已经存好了：云端失败只是一条提示
      saveCloudSettings({ lastBackupAt: Date.now(), lastError: msg })
      return { ok: true, bundle, remote, message: `已备份到本地；云端失败：${msg}` }
    }
    saveCloudSettings({ lastError: msg })
    return { ok: false, message: msg }
  } finally {
    try {
      fs.rmSync(bundle.path, { force: true })
    } catch {
      /* 配置包是临时的，删不掉也无所谓 */
    }
  }
}

/** 服务端自己管保留份数，这里只为了兼容旧调用 */
export async function pruneRemote(_keep?: number): Promise<number> {
  return 0
}

/** 云端快照列表（没登录就空） */
export async function listCloudBackups(): Promise<CloudBackup[]> {
  if (!unified.isLoggedIn()) return []
  const r = await snap.snapshots()
  return r.items.map((it) => ({
    id: String(it.id),
    kind: 'config',
    size: it.bytes,
    createdAt: it.createdAt,
    note: `${it.label}${it.kind === 'auto' ? '（自动）' : '（手动）'}`
  }))
}

/** 本地备份列表（界面上「本地已有 N 份」用） */
export async function listLocalBackups(): Promise<CloudBackup[]> {
  try {
    return await localProvider().list({ kind: 'config', limit: 20 })
  } catch {
    return []
  }
}

export async function deleteCloudBackup(id: string): Promise<void> {
  await snap.deleteSnapshot(id)
}

/** 从本地备份还原（最常用的一条路：不依赖网络，也不需要登录） */
export async function restoreLocalBackup(id: string): Promise<{
  ok: boolean
  result?: ReturnType<typeof applyConfigBundle>
  message: string
}> {
  const dest = path.join(store.dataDir, 'temp', `local-restore-${Date.now()}.zip`)
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    await localProvider().get(id, dest)
    const result = applyConfigBundle(dest)
    return {
      ok: true,
      result,
      message:
        `还原完成：账号 ${result.accountsRestored} 个（需要重新登录）、` +
        `新增实例 ${result.instancesAdded} 个、服务器 ${result.serversRestored} 条。` +
        `老配置已备份到 ${result.safetyDir}`
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    try {
      fs.rmSync(dest, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 删掉一份本地备份 */
export async function deleteLocalBackup(id: string): Promise<void> {
  await localProvider().remove(id)
}

/**
 * 从云端还原。**破坏性**：会覆盖本机的 settings / accounts / servers，
 * applyConfigBundle 内部会先打一份安全副本。
 */
export async function restoreCloudBackup(id: string): Promise<{
  ok: boolean
  result?: ReturnType<typeof applyConfigBundle>
  message: string
}> {
  if (!unified.isLoggedIn()) return { ok: false, message: '还没登录统一账号' }
  const dest = path.join(store.dataDir, 'temp', `cloud-restore-${Date.now()}.zip`)
  try {
    await snap.pullSnapshot(id, dest)
    const result = applyConfigBundle(dest)
    return {
      ok: true,
      result,
      message:
        `还原完成：账号 ${result.accountsRestored} 个（需要重新登录）、` +
        `新增实例 ${result.instancesAdded} 个、服务器 ${result.serversRestored} 条。` +
        `老配置已备份到 ${result.safetyDir}`
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  } finally {
    try {
      fs.rmSync(dest, { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

// ------------------------------------------------------------ 公告（服务端通知，见 notify.ts）

export async function fetchAnnouncements(_force = false): Promise<CloudAnnouncement[]> {
  // 保留旧形状给界面用；真正的通知页走 notify:list（带服务端已读标记）
  const r = await listNotifications().catch(() => ({ items: [], loggedIn: false }))
  return r.items.map((n) => ({
    id: String(n.id),
    level: n.level === 'important' ? 'critical' : n.level === 'warn' ? 'warn' : 'info',
    title: n.title,
    body: n.body || undefined,
    url: n.url || undefined,
    pinned: n.level === 'important',
    publishedAt: n.createdAt ? Date.parse(n.createdAt) || undefined : undefined
  }))
}

// ------------------------------------------------------------ 状态与调度

export async function cloudStatus(): Promise<CloudStatus> {
  const s = getSettings()
  const kind = storageKind()
  const w = webdavSettings()
  const webdavUsable = !!w.url && !!w.username && w.hasPass
  const status: CloudStatus = {
    configured: unified.isLoggedIn(),
    hasToken: unified.isLoggedIn(),
    storage: kind,
    storageLabel: kind === 'webdav' ? 'WebDAV 网盘' : '本地文件夹',
    storageTarget: storageTarget(kind),
    webdavHasPass: w.hasPass,
    webdavUsable,
    localUsable: true,
    account: cloudAccount(),
    backups: []
  }
  if (!s.enabled) return status
  try {
    const local = await listLocalBackups()
    status.localBackups = local
    status.online = true
  } catch (e) {
    status.error = (e as Error).message
  }
  if (unified.isLoggedIn()) {
    try {
      const r = await snap.snapshots()
      status.backups = r.items.map((it) => ({
        id: String(it.id),
        kind: 'config' as const,
        size: it.bytes,
        createdAt: it.createdAt,
        note: `${it.label}${it.kind === 'auto' ? '（自动）' : '（手动）'}`
      }))
      status.limits = r.limits
      status.online = true
    } catch (e) {
      status.error = (e as Error).message
    }
  } else {
    status.limits = { autoKeep: 3, manualKeep: 5 }
  }
  return status
}

let timer: NodeJS.Timeout | undefined
let busy = false

async function tick(reason: string): Promise<void> {
  const s = getSettings()
  if (!s.enabled || !s.autoBackup || busy) return
  busy = true
  try {
    const r = await uploadConfigBackup()
    console.log(`[backup] ${reason} 自动备份：${r.message}`)
  } catch (e) {
    console.error('[backup] 自动备份异常', (e as Error).message)
  } finally {
    busy = false
  }
}

/** 启动后挂上定时器（改间隔会重挂）。失败只记日志，不打扰用户。 */
export function startCloudScheduler(): void {
  const s = getSettings()
  if (!s.enabled) return
  if (!s.autoBackup) return
  setTimeout(() => void tick('启动后'), 90_000)
  const ms = Math.max(1, s.intervalH) * 3600_000
  timer = setInterval(() => void tick('定时'), ms)
  console.log(`[backup] 自动备份已开启：每 ${s.intervalH} 小时（本地优先，云端登录后自动带上）`)
}

export function stopCloudScheduler(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}

function restartCloudScheduler(): void {
  stopCloudScheduler()
  startCloudScheduler()
}

/** 兼容旧名字：以前是「静默登记一台设备」，现在是「还没登录就什么都不做」 */
export async function ensureCloudDevice(_force = false): Promise<{ ok: boolean; message: string }> {
  if (unified.isLoggedIn()) return { ok: true, message: '已登录' }
  return { ok: false, message: '还没登录统一账号' }
}

export function unpairCloudDevice(): void {
  unified.logout()
}
