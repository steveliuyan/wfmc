import { randomUUID } from 'node:crypto'
import { offline, MicrosoftAuthenticator } from '@xmcl/user'
import type { Account } from '../shared/types'
import { store } from './store'
import { fetchJson } from './net'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
  message?: string
}

export interface DeviceCodeInfo {
  userCode: string
  verificationUri: string
  message?: string
  expiresIn: number
}

/** 添加离线账号 */
export function addOfflineAccount(username: string): Account {
  const auth = offline(username)
  const account: Account = {
    id: randomUUID(),
    type: 'offline',
    name: username,
    uuid: auth.selectedProfile.id,
    accessToken: auth.accessToken
  }
  store.setAccounts([...store.accounts.filter((a) => a.name !== username || a.type !== 'offline'), account])
  return account
}

export function removeAccount(id: string) {
  store.setAccounts(store.accounts.filter((a) => a.id !== id))
}

/**
 * 内置的公共客户端 ID：让「微软正版登录」开箱可用，不用先去 Azure 注册应用。
 * 如果微软将来把它作废（返回 unauthorized_client/invalid_client），
 * 在设置里填自己的 Azure 应用 ID 即可覆盖。
 */
export const DEFAULT_MS_CLIENT_ID = '00000000402b5328'

function msClientId(): string {
  return store.settings.microsoftClientId.trim() || DEFAULT_MS_CLIENT_ID
}

/**
 * 两套端点不能混用，混用就是 400 AADSTS700016（应用不在租户里）：
 * - 内置的 00000000402b5328 是「旧版 Live 客户端 ID」，只存在于消费级 Live 目录，
 *   必须走 login.live.com 的 oauth20 端点；
 * - 用户自填的 Azure 应用 ID 是在自己的租户里注册的，走 v2.0 /consumers。
 * 两条链路换出来的令牌都是 XBL 的 "d=" RPS 票，后面完全一样。
 */
const LIVE_ENDPOINTS = {
  deviceCode: 'https://login.live.com/oauth20_connect.srf',
  token: 'https://login.live.com/oauth20_token.srf'
}
const AAD_ENDPOINTS = {
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token'
}

function msEndpoints() {
  return store.settings.microsoftClientId.trim() ? AAD_ENDPOINTS : LIVE_ENDPOINTS
}

/** 微软正版登录 - 设备码流程第一步：拿到 user_code */
export async function startMicrosoftLogin(): Promise<DeviceCodeInfo & { deviceCode: string }> {
  const clientId = msClientId()
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'XboxLive.signin offline_access',
    response_type: 'device_code'
  })
  const res = await withRetry(() => fetchJson<DeviceCodeResponse>(msEndpoints().deviceCode, { method: 'POST', body }))
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUri: res.verification_uri || 'https://www.microsoft.com/link',
    message: res.message,
    expiresIn: res.expires_in
  }
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

/**
 * 登录请求走系统代理，偶发 "fetch failed"（代理抖动/DNS 抽风）很常见。
 * 这类纯网络错误重试两次比让用户重头点一遍划算；业务失败（400/错误码）一律原样抛出去。
 */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: Error | undefined
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e as Error
      const msg = last.message ?? ''
      const retriable =
        /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|请求失败 5\d\d|aborterror|timeout/i.test(msg)
      if (!retriable || i === tries - 1) throw last
      await new Promise((r) => setTimeout(r, 600 * (i + 1)))
    }
  }
  throw last as Error
}

/**
 * 令牌端点的「业务失败」是 400 + JSON，不是网络失败：
 * 轮询时 authorization_pending / slow_down 都是 400，刷新时 invalid_grant 也是 400。
 * 所以这里按状态码无关的方式解析 body，把判断交给调用方。
 */
async function postToken<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20_000)
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`令牌接口返回了非 JSON 内容 (${res.status}): ${text.slice(0, 200)}`)
  }
}

async function pollToken(deviceCode: string, interval: number, timeoutMs: number): Promise<TokenResponse> {
  const clientId = msClientId()
  const started = Date.now()
  let wait = Math.max(interval, 2) * 1000
  for (;;) {
    if (Date.now() - started > timeoutMs) throw new Error('登录超时，请重试')
    await new Promise((r) => setTimeout(r, wait))
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode
    })
    const res = await withRetry(() => postToken<TokenResponse>(msEndpoints().token, body))
    if (res.access_token) return res
    if (res.error === 'authorization_pending') continue
    if (res.error === 'slow_down') {
      wait += 2000
      continue
    }
    throw new Error(res.error_description || res.error || '登录失败')
  }
}

async function profileFromAccessToken(accessToken: string, refreshToken?: string, expiresIn?: number): Promise<Account> {
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) throw new Error(`获取 Minecraft 档案失败 (${res.status})，该账号可能没有拥有游戏`)
  const profile = (await res.json()) as { id: string; name: string }
  const account: Account = {
    id: randomUUID(),
    type: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    accessToken,
    refreshToken,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined
  }
  store.setAccounts([...store.accounts.filter((a) => a.uuid !== account.uuid), account])
  return account
}

/** 设备码流程第二步：等待用户完成授权并换取 Minecraft 令牌 */
export async function completeMicrosoftLogin(deviceCode: string, interval: number, expiresIn: number): Promise<Account> {
  const token = await pollToken(deviceCode, interval, expiresIn * 1000)
  const authenticator = new MicrosoftAuthenticator()
  const { minecraftXstsResponse } = await authenticator.acquireXBoxToken(token.access_token!)
  const xuid = minecraftXstsResponse.DisplayClaims.xui[0]
  const mc = await authenticator.loginMinecraftWithXBox(xuid.uhs, minecraftXstsResponse.Token)
  return await profileFromAccessToken(mc.access_token, token.refresh_token, mc.expires_in)
}

/** 刷新即将过期的微软账号 */
export async function refreshAccount(accountId: string): Promise<Account | undefined> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'microsoft' || !account.refreshToken) return account
  if (account.expiresAt && account.expiresAt - Date.now() > 60_000) return account
  const clientId = msClientId()
  if (!clientId) return account
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    scope: 'XboxLive.signin offline_access'
  })
  const token = await withRetry(() => postToken<TokenResponse>(msEndpoints().token, body))
  if (!token.access_token) return account
  const authenticator = new MicrosoftAuthenticator()
  const { minecraftXstsResponse } = await authenticator.acquireXBoxToken(token.access_token)
  const xuid = minecraftXstsResponse.DisplayClaims.xui[0]
  const mc = await authenticator.loginMinecraftWithXBox(xuid.uhs, minecraftXstsResponse.Token)
  const updated: Account = {
    ...account,
    accessToken: mc.access_token,
    refreshToken: token.refresh_token ?? account.refreshToken,
    expiresAt: Date.now() + mc.expires_in * 1000
  }
  store.setAccounts(store.accounts.map((a) => (a.id === account.id ? updated : a)))
  return updated
}

/**
 * 登录态健康检查：多久过期、要不要现在续。
 * 给 UI 的提示与启动前的自动刷新都用它。
 */
export interface AccountHealth {
  id: string
  name: string
  type: Account['type']
  /** 距离过期还有多少毫秒（负数=已过期）；无 expiresAt 时为 undefined */
  remainingMs?: number
  needsRefresh: boolean
  expired: boolean
}

const REFRESH_AHEAD_MS = 10 * 60 * 1000 // 提前 10 分钟续

export function accountHealth(): AccountHealth[] {
  const now = Date.now()
  return store.accounts.map((a) => {
    if (a.type === 'offline' || !a.expiresAt) {
      return { id: a.id, name: a.name, type: a.type, needsRefresh: false, expired: false }
    }
    const remainingMs = a.expiresAt - now
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      remainingMs,
      needsRefresh: remainingMs < REFRESH_AHEAD_MS,
      expired: remainingMs <= 0
    }
  })
}

/** 把所有快到期的账号续一遍，返回结果，交给前端提示 */
export async function refreshExpiringAccounts(): Promise<{ refreshed: string[]; failed: string[] }> {
  const refreshed: string[] = []
  const failed: string[] = []
  for (const h of accountHealth()) {
    if (!h.needsRefresh) continue
    try {
      await refreshAccount(h.id)
      refreshed.push(h.name)
    } catch {
      failed.push(h.name)
    }
  }
  return { refreshed, failed }
}