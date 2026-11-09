/**
 * 配置包：把「换台电脑还想带走的那些东西」打成一个 zip，并支持还原。
 *
 * 带走的：settings.json（脱敏）、accounts.json（只留 id/type/name/uuid）、servers.json、
 *         每个实例的 instance.json（不含游戏文件和存档）。
 * 绝不带：DPAPI 加密的登录令牌（换机器解不开）、API Key、代理、绝对路径、
 *         实例里的 minecraft/ 和 backups/（太大，且敏感）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { store } from './store'
import { collectDirFiles, readZipEntry, readZipFromFile, writeZip } from './zip'
import type { Account, Instance, Settings } from '../shared/types'

/** 还原/上传都必须剥掉的设置项：机器相关或机密 */
const STRIP_SETTINGS = [
  'cloud', // 云端凭据不跟着走
  'curseforgeApiKey',
  'microsoftClientId',
  'proxy',
  'dataDir',
  'dataDirCustom',
  'useSharedData',
  'windowState',
  'activeAccountId',
  'lastUpdateCheck'
]

export interface ConfigBundleInfo {
  path: string
  bytes: number
  sha256: string
  includes: { accounts: number; instances: number; servers: number; settings: boolean }
}

function sha256OfFile(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/**
 * 打配置包。outFile 省略就放 `dataDir/temp/wfmc-config-<时间戳>.zip`。
 */
export function buildConfigBundle(
  outFile?: string,
  now = Date.now()
): ConfigBundleInfo {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-cfg-'))
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = outFile ?? path.join(store.dataDir, 'temp', `wfmc-config-${stamp}.zip`)
  try {
    // settings.json：整体拷一份，然后剥敏感项
    const settings = { ...store.settings } as Record<string, unknown>
    for (const k of STRIP_SETTINGS) delete settings[k]
    fs.writeFileSync(path.join(tmp, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8')

    // accounts.json：只留身份信息，令牌一律不带（换了机器本来也解不开）
    const accounts = store.accounts.map((a: Account) => ({
      id: a.id,
      type: a.type,
      name: a.name,
      uuid: a.uuid
    }))
    fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify({ accounts }, null, 2), 'utf-8')

    // servers.json：整个搬
    let servers = 0
    const serversFile = path.join(store.dataDir, 'servers.json')
    if (fs.existsSync(serversFile)) {
      const raw = readJsonSafe<{ servers?: unknown[] }>(serversFile, { servers: [] })
      servers = Array.isArray(raw.servers) ? raw.servers.length : 0
      fs.copyFileSync(serversFile, path.join(tmp, 'servers.json'))
    }

    // 每个实例的 instance.json（只这一份元数据）
    let instances = 0
    for (const inst of store.listInstances() as Instance[]) {
      const src = store.instanceFile(inst.id)
      if (!fs.existsSync(src)) continue
      const dstDir = path.join(tmp, 'instances', inst.id)
      fs.mkdirSync(dstDir, { recursive: true })
      fs.copyFileSync(src, path.join(dstDir, 'instance.json'))
      instances++
    }

    fs.writeFileSync(
      path.join(tmp, 'manifest.json'),
      JSON.stringify(
        { kind: 'wfmc-config', createdAt: now, appVersion: process.env.npm_package_version ?? '', accounts: accounts.length, instances, servers },
        null,
        2
      ),
      'utf-8'
    )

    fs.mkdirSync(path.dirname(dest), { recursive: true })
    writeZip(dest, collectDirFiles(tmp).map((f) => ({ name: f.name, full: f.full })))
    const bytes = fs.statSync(dest).size
    return {
      path: dest,
      bytes,
      sha256: sha256OfFile(dest),
      includes: { accounts: accounts.length, instances, servers, settings: true }
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 临时目录删不掉就算了 */
    }
  }
}

export interface ApplyConfigResult {
  settingsApplied: boolean
  accountsRestored: number
  instancesAdded: number
  instancesSkipped: number
  serversRestored: number
  /** 需要重启才生效的提示 */
  needRestart: boolean
  /** 安全副本放在哪（还原前的老状态） */
  safetyDir: string
}

/**
 * 还原配置包。原则：
 *  - 先把本机老的 settings/accounts/servers 拷一份到 `dataDir/config-restore-<ts>/`
 *  - settings 是「合并」不是「覆盖」：本机的 dataDir / cloud / 窗口位置 / 版本号永远保留
 *  - accounts 覆盖，但令牌为空 → 调用方要提示「需要重新登录」
 *  - 实例只补不删：本地已存在的实例不动（避免把别人机器上的游戏目录指过来）
 */
export function applyConfigBundle(zipPath: string): ApplyConfigResult {
  const { buf, entries } = readZipFromFile(zipPath)
  const readText = (name: string): string | undefined => {
    const e = entries.find((x) => x.name === name)
    if (!e) return undefined
    return readZipEntry(buf, e).toString('utf-8')
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const safetyDir = path.join(store.dataDir, `config-restore-${stamp}`)
  fs.mkdirSync(safetyDir, { recursive: true })
  for (const f of [store.settingsFile, store.accountsFile, path.join(store.dataDir, 'servers.json')]) {
    try {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(safetyDir, path.basename(f)))
    } catch {
      /* 单个失败不影响还原 */
    }
  }

  let settingsApplied = false
  const settingsText = readText('settings.json')
  if (settingsText) {
    try {
      const incoming = JSON.parse(settingsText) as Partial<Settings>
      const local = store.settings
      const merged: Settings = {
        ...local,
        ...incoming,
        // 这几项绝不从别人机器上带过来
        dataDir: local.dataDir,
        dataDirCustom: local.dataDirCustom,
        useSharedData: local.useSharedData,
        cloud: local.cloud,
        windowState: local.windowState,
        activeAccountId: local.activeAccountId,
        configVersion: local.configVersion
      }
      store.setSettings(merged)
      settingsApplied = true
    } catch {
      /* 坏 JSON 就跳过这一项 */
    }
  }

  let accountsRestored = 0
  const accountsText = readText('accounts.json')
  if (accountsText) {
    try {
      const raw = JSON.parse(accountsText) as { accounts?: Partial<Account>[] }
      const incoming = (raw.accounts ?? []).filter((a) => !!a?.id && !!a?.name)
      // 绝不能用备份里的账号覆盖本机账号：本机那份带着 refresh token，覆盖掉就得重新登录
      // （用户报过「正版账号老要续期 / 续期失败」，根因就是还原配置包时把令牌抹了）。
      // 这里只补本机没有的账号，且补进来的没有令牌。
      const byId = new Set(store.accounts.map((a) => a.id))
      const byUuid = new Set(store.accounts.map((a) => a.uuid).filter(Boolean))
      const added: Account[] = []
      for (const a of incoming) {
        const id = String(a.id)
        const uuid = String(a.uuid ?? '')
        if (byId.has(id) || (uuid && byUuid.has(uuid))) continue
        byId.add(id)
        if (uuid) byUuid.add(uuid)
        added.push({
          id,
          type: (a.type as Account['type']) ?? 'offline',
          name: String(a.name),
          uuid,
          accessToken: ''
        })
      }
      if (added.length > 0) store.setAccounts([...store.accounts, ...added])
      accountsRestored = added.length
    } catch {
      /* 忽略 */
    }
  }

  let serversRestored = 0
  const serversText = readText('servers.json')
  if (serversText) {
    try {
      const raw = JSON.parse(serversText) as { servers?: unknown[] }
      serversRestored = Array.isArray(raw.servers) ? raw.servers.length : 0
      fs.writeFileSync(path.join(store.dataDir, 'servers.json'), JSON.stringify(raw, null, 2), 'utf-8')
    } catch {
      /* 忽略 */
    }
  }

  let instancesAdded = 0
  let instancesSkipped = 0
  const localIds = new Set((store.listInstances() as Instance[]).map((i) => i.id))
  for (const e of entries) {
    const m = /^instances\/([^/]+)\/instance\.json$/.exec(e.name)
    if (!m) continue
    const id = m[1]
    if (localIds.has(id)) {
      instancesSkipped++
      continue
    }
    const text = readZipEntry(buf, e).toString('utf-8')
    const dir = store.instanceDir(id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(store.instanceFile(id), text, 'utf-8')
    instancesAdded++
  }

  return {
    settingsApplied,
    accountsRestored,
    instancesAdded,
    instancesSkipped,
    serversRestored,
    needRestart: settingsApplied,
    safetyDir
  }
}
