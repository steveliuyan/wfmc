// ---------------------------------------------------------------- 备份存储后端：公共类型
//
// 为什么要有这一层：
//   以前「配置备份」只能存到 WFMC 云同步服务器（协议由 server.py 定义）。
//   现在备份位置可以三选一：
//     wfmc   = WFMC 云同步（默认，mc.20050905.xyz / 自己搭的服务器）
//     webdav = 任意标准 WebDAV（坚果云、Nextcloud、群晖、InfiniCLOUD…）
//     local  = 本地文件夹（同步盘自己处理，比如 OneDrive 目录）
//   三者都只存同一种东西：配置包 zip。文件名沿用 b_<id>.zip，另有 index.json 记元数据
//   （WFMC 协议里本来就有这两个概念，保持一致方便互相搬迁）。
//
// 注意：WebDAV / 本地目录没有服务端强约束，所以「保留份数」由客户端 prune() 执行。

import type { CloudBackup, StorageKind } from '../../shared/types'

export type { StorageKind }
export type { CloudBackup }

/** 备份文件前缀 / 索引文件名（与 WFMC 服务端保持一致） */
export const BACKUP_PREFIX = 'b_'
export const INDEX_FILE = 'index.json'

export interface BackupMeta {
  kind?: 'config' | 'instance'
  sha256?: string
  createdAt?: number
  appVersion?: string
  instanceName?: string
  note?: string
}

export interface ProviderTest {
  ok: boolean
  message: string
  /** 已有备份数（能数出来就给） */
  items?: number
  /** 已用字节（能算出来就给） */
  usedBytes?: number
}

export interface StorageProvider {
  readonly kind: StorageKind
  /** 给界面显示的名字 */
  readonly label: string
  /** 备份列表，最新在前 */
  list(opts?: { limit?: number; kind?: 'config' | 'instance' }): Promise<CloudBackup[]>
  /** 把本地 zip 放进去 */
  put(localZip: string, meta?: BackupMeta): Promise<CloudBackup>
  /** 取回一份，写到 destPath（给了 sha256 就校验） */
  get(id: string, destPath: string): Promise<{ bytes?: number; sha256?: string }>
  /** 删掉一份 */
  remove(id: string): Promise<void>
  /** 连通性 / 凭据 / 读写权限自检 */
  test(): Promise<ProviderTest>
  /** 只保留最新 keep 份，返回删掉几份 */
  prune?(keep: number): Promise<number>
}

/** 生成备份 id：时间戳 base36 + 4 位随机，天然按时间排序 */
export function newBackupId(now = Date.now()): string {
  const t = Math.max(0, Math.floor(now)).toString(36)
  const r = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `${t}${r}`
}

export function fileNameOf(id: string): string {
  return `${BACKUP_PREFIX}${id}.zip`
}

export function sortByNewest<T extends { createdAt: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => b.createdAt - a.createdAt)
}

/** 'wfmc' | 'webdav' | 'local' 之外的值一律当默认后端 */
export function normalizeStorageKind(raw: unknown): StorageKind {
  return raw === 'webdav' ? 'webdav' : 'local'
}

/** 远端/本地目录路径规整：'wfmc/' → '/wfmc'，'' → 默认值 */
export function normalizeDir(raw: unknown, fallback: string): string {
  const s = String(raw ?? '').trim().replace(/\\/g, '/')
  const parts = s.split('/').filter(Boolean)
  const body = parts.join('/')
  if (!body) return fallback
  return `/${body}`
}

export function errorText(e: unknown): string {
  const err = e as Error & { status?: number }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return '连接超时，检查网络或地址'
  return err?.message ?? String(e)
}

/** 索引文件结构（WebDAV / 本地目录共用） */
export interface BackupIndex {
  version: number
  items: CloudBackup[]
}

export function emptyIndex(): BackupIndex {
  return { version: 1, items: [] }
}

export function parseIndex(text: string): BackupIndex {
  if (!text.trim()) return emptyIndex()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('index.json 不是合法 JSON（可能被别的程序写过），请检查目录内容')
  }
  const items = (json as BackupIndex)?.items
  return { version: 1, items: Array.isArray(items) ? items.filter((i) => i && typeof i.id === 'string') : [] }
}
