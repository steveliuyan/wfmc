/**
 * 统一账号（api.20050905.xyz）网络层。
 *
 * 纯 HTTP，不 import electron，方便单测。客户端只认这一个地址，界面上不再暴露、
 * 也不允许用户改（改地址 = 连到别人的账号体系，没有意义也不需要）。
 *
 * 协议（服务端 app.py）：
 *   GET  /v1/health
 *   GET  /v1/me                                  Bearer
 *   GET  /v1/auth/desktop/start?challenge&state&product   返回登录网页（用系统浏览器打开）
 *   GET  /v1/auth/desktop/poll?challenge        -> {waiting} | {code}
 *   POST /v1/auth/desktop/exchange              {code, code_verifier} -> {access_token, user}
 *   GET  /v1/sync                               全部 KV
 *   GET  /v1/sync/{key} / PUT /v1/sync/{key}    单条 KV（带 base_version，冲突 409）
 *   GET  /v1/backup                             快照列表 + limits{auto_keep,manual_keep}
 *   POST /v1/backup/create                      {label} 手动快照
 *   GET  /v1/backup/{id}/download               快照内容（JSON）
 *   POST /v1/backup/{id}/restore                快照写回 KV
 *   DELETE /v1/backup/{id}
 */
import crypto from 'node:crypto'

/** 唯一的服务端地址（不再让用户填，也不在界面上显示） */
export const UNIFIED_BASE_URL = 'https://api.20050905.xyz'

/** 桌面登录的产品代号（服务端 product 表里的 code） */
export const UNIFIED_PRODUCT = 'wfmc'

export class UnifiedError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'UnifiedError'
    this.status = status
    this.code = code
  }
}

interface RequestOpts {
  method?: string
  token?: string
  body?: unknown
  timeoutMs?: number
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = 'GET', token, body, timeoutMs = 20000 } = opts
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(UNIFIED_BASE_URL + path, {
      method,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WFMC-Launcher',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
    const text = await res.text()
    let data: unknown = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const err = ((data as { error?: { code?: string; message?: string } })?.error ?? {}) as {
        code?: string
        message?: string
      }
      throw new UnifiedError(res.status, err.code ?? `http_${res.status}`, err.message ?? `服务器返回 ${res.status}`)
    }
    return (data ?? {}) as T
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw new UnifiedError(0, 'timeout', '连接超时，请检查网络')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ------------------------------------------------------------------ 登录（PKCE）

export interface UnifiedUser {
  id?: string
  email?: string
  username?: string
  display_name?: string
  product?: string
  product_name?: string
  created_at?: string
  [k: string]: unknown
}

/** 生成 PKCE 的 verifier / challenge（S256） */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 浏览器要打开的登录页地址 */
export function desktopStartUrl(challenge: string, state: string, product = UNIFIED_PRODUCT): string {
  const q = new URLSearchParams({ challenge, state, product })
  return `${UNIFIED_BASE_URL}/v1/auth/desktop/start?${q.toString()}`
}

/** 轮询登录结果；拿到 code 就去 exchange */
export async function desktopPoll(challenge: string): Promise<{ waiting?: boolean; code?: string }> {
  return request(`/v1/auth/desktop/poll?${new URLSearchParams({ challenge }).toString()}`, { timeoutMs: 15000 })
}

export async function desktopExchange(
  code: string,
  verifier: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; user?: UnifiedUser }> {
  return request('/v1/auth/desktop/exchange', {
    method: 'POST',
    body: { code, code_verifier: verifier }
  })
}

// ------------------------------------------------------------------ 账号 / 同步 / 备份

export async function health(): Promise<{ ok?: boolean; version?: string; note?: string }> {
  return request('/v1/health', { timeoutMs: 10000 })
}

export async function me(token: string): Promise<UnifiedUser & { quotas?: Record<string, number> }> {
  return request('/v1/me', { token })
}

export interface UnifiedBackupItem {
  id: number
  kind: 'auto' | 'manual'
  label: string
  keys: number
  bytes: number
  created_at: string
  kind_label?: string
}

export interface UnifiedLimits {
  auto_keep: number
  manual_keep: number
}

export async function backupList(token: string): Promise<{ items: UnifiedBackupItem[]; limits: UnifiedLimits }> {
  return request('/v1/backup', { token, timeoutMs: 20000 })
}

export async function backupCreate(token: string, label: string): Promise<{ id: number; keys: number; bytes: number }> {
  return request('/v1/backup/create', { method: 'POST', token, body: { label }, timeoutMs: 60000 })
}

export interface SnapshotFile {
  backup?: { id: number; kind: string; label: string; created_at: string }
  exported_at?: string
  items?: Record<string, { value: unknown; version?: number; updated_at?: string }>
}

export async function backupDownload(token: string, id: number | string): Promise<SnapshotFile> {
  return request(`/v1/backup/${encodeURIComponent(String(id))}/download`, { token, timeoutMs: 60000 })
}

export async function backupDelete(token: string, id: number | string): Promise<void> {
  await request(`/v1/backup/${encodeURIComponent(String(id))}`, { method: 'DELETE', token })
}

export async function syncGet(
  token: string,
  key: string
): Promise<{ key: string; value: unknown; version: number; updated_at?: string }> {
  return request(`/v1/sync/${encodeURIComponent(key)}`, { token })
}

export async function syncPut(
  token: string,
  key: string,
  value: unknown,
  baseVersion = 0
): Promise<{ key: string; version: number }> {
  return request(`/v1/sync/${encodeURIComponent(key)}`, {
    method: 'PUT',
    token,
    body: { value, base_version: baseVersion },
    timeoutMs: 60000
  })
}

// ------------------------------------------------------------------ 通知（公告）

export interface UnifiedNotice {
  id: number
  title: string
  body?: string
  url?: string
  level?: string
  mode?: string
  created_at?: string
  read?: boolean
}

/** 未登录也能拉：服务端只返回 audience='public' 的公告 */
export async function notificationPublic(
  product = UNIFIED_PRODUCT,
  limit = 30
): Promise<{ ok?: boolean; items: UnifiedNotice[] }> {
  const q = new URLSearchParams({ product, limit: String(limit) })
  return request(`/v1/notifications/public?${q.toString()}`, { timeoutMs: 15000 })
}

/** 登录后拉：本人可见的全部通知（全平台 + 本产品），带服务端已读标记 */
export async function notificationList(token: string): Promise<{ items: UnifiedNotice[]; unread?: number }> {
  return request('/v1/notifications', { token, timeoutMs: 20000 })
}

/** 标记已读。客户端**没有**删除接口：通知只由管理员后台删除 */
export async function notificationMarkRead(
  token: string,
  ids: number[]
): Promise<{ ok?: boolean; marked?: number }> {
  return request('/v1/notifications/read', { method: 'POST', token, body: { ids }, timeoutMs: 20000 })
}

/** 把异常翻成人话 */
export function unifiedErrorText(e: unknown): string {
  const err = e as UnifiedError
  if (err?.name === 'UnifiedError') {
    if (err.status === 401) return '登录已失效，请重新登录'
    if (err.status === 413) return '配置包太大，服务器放不下（单条上限 2MB）'
    if (err.status === 429) return '操作太频繁，请稍后再试'
    if (err.status === 0) return err.message
    return err.message || `服务器返回 ${err.status}`
  }
  return (e as Error)?.message ?? String(e)
}
