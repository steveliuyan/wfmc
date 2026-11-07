/**
 * 云端备份：配置包 <-> 统一账号的 KV + 快照。
 *
 * 服务端的模型（app.py + store.py）：
 *   - /v1/sync 存「当前数据」（KV，单条 ≤2MB）
 *   - /v1/backup 是数据的快照；每日自动快照由服务端任务做（保留份数后台可配，默认 3）
 *   - 用户点「立即备份」= 先把手上的配置包同步进 KV，再打一个手动快照（默认保留 5 份）
 *
 * 所以客户端这边只有两件事：把 zip 塞进 KV、把快照取回来。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import * as uapi from './unifiedapi'
import { currentToken } from './cloudlogin'

/** 配置包在云端 KV 里的 key（固定一个，永远只覆盖它自己） */
const BUNDLE_KEY = 'wfmc/config'

/** 单条 KV 的上限（服务端 MAX_VALUE_BYTES） */
const MAX_VALUE_BYTES = 2 * 1024 * 1024

export interface CloudSnapshot {
  id: number
  kind: 'auto' | 'manual'
  label: string
  keys: number
  bytes: number
  createdAt: number
}

function token(): string {
  const t = currentToken()
  if (!t) throw new uapi.UnifiedError(401, 'not_logged_in', '还没登录统一账号')
  return t
}

/** 把配置包推进云端 KV（覆盖上一次的） */
export async function pushBundle(
  zipPath: string,
  opts: { sha256?: string; appVersion?: string } = {}
): Promise<{ bytes: number; sha256: string; version: number }> {
  const buf = await fs.promises.readFile(zipPath)
  const sha256 = opts.sha256 || crypto.createHash('sha256').update(buf).digest('hex')
  const value = {
    kind: 'wfmc-config-bundle',
    encoding: 'base64',
    sha256,
    bytes: buf.length,
    appVersion: opts.appVersion ?? '',
    createdAt: Date.now(),
    data: buf.toString('base64')
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf-8') > MAX_VALUE_BYTES) {
    throw new Error('配置包太大，云端单条上限 2MB（可以先用「本地文件夹」备份）')
  }
  const t = token()
  let base = 0
  try {
    const cur = await uapi.syncGet(t, BUNDLE_KEY)
    base = Number(cur?.version ?? 0)
  } catch (e) {
    if ((e as uapi.UnifiedError)?.status !== 404) throw e
  }
  try {
    const r = await uapi.syncPut(t, BUNDLE_KEY, value, base)
    return { bytes: buf.length, sha256, version: Number(r?.version ?? 0) }
  } catch (e) {
    // 版本冲突（别的设备刚写过）：重读一次版本再写
    if ((e as uapi.UnifiedError)?.status === 409) {
      const cur = await uapi.syncGet(t, BUNDLE_KEY).catch(() => null)
      const r = await uapi.syncPut(t, BUNDLE_KEY, value, Number(cur?.version ?? 0))
      return { bytes: buf.length, sha256, version: Number(r?.version ?? 0) }
    }
    throw e
  }
}

/** 云端快照列表 + 服务端当前生效的保留份数（只读，改要去管理后台） */
export async function snapshots(): Promise<{
  items: CloudSnapshot[]
  limits: { autoKeep: number; manualKeep: number }
}> {
  const r = await uapi.backupList(token())
  const items: CloudSnapshot[] = (r?.items ?? []).map((it) => ({
    id: Number(it.id),
    kind: it.kind === 'auto' ? 'auto' : 'manual',
    label: it.label || (it.kind === 'auto' ? '自动备份' : '手动备份'),
    keys: Number(it.keys ?? 0),
    bytes: Number(it.bytes ?? 0),
    createdAt: Date.parse(String(it.created_at)) || Date.now()
  }))
  return {
    items,
    limits: {
      autoKeep: Number(r?.limits?.auto_keep ?? 3),
      manualKeep: Number(r?.limits?.manual_keep ?? 5)
    }
  }
}

/** 打一个手动快照（服务端按「手动保留份数」自动轮转） */
export async function createSnapshot(label: string): Promise<CloudSnapshot> {
  const t = token()
  const r = await uapi.backupCreate(t, label.slice(0, 60))
  return {
    id: Number(r?.id ?? 0),
    kind: 'manual',
    label,
    keys: Number(r?.keys ?? 0),
    bytes: Number(r?.bytes ?? 0),
    createdAt: Date.now()
  }
}

export async function deleteSnapshot(id: number | string): Promise<void> {
  await uapi.backupDelete(token(), id)
}

/** 把某份快照里的配置包取回本地（写成 zip，交给 applyConfigBundle） */
export async function pullSnapshot(id: number | string, destPath: string): Promise<{ bytes: number; sha256?: string }> {
  const data = await uapi.backupDownload(token(), id)
  const entry = data?.items?.[BUNDLE_KEY]?.value as
    | { data?: string; sha256?: string; bytes?: number }
    | undefined
  if (!entry?.data) throw new Error('这份备份里没有配置包（可能是很早以前的数据）')
  const buf = Buffer.from(entry.data, 'base64')
  if (entry.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got !== entry.sha256) throw new Error('备份内容校验失败（sha256 不匹配）')
  }
  fs.mkdirSync(destPath.replace(/[\\/][^\\/]+$/, ''), { recursive: true })
  await fs.promises.writeFile(destPath, buf)
  return { bytes: buf.length, sha256: entry.sha256 }
}
