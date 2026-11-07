/**
 * 统一账号登录（浏览器 PKCE，product=wfmc）。
 *
 * 流程（和 3D 打印成本计算器、AI 工具箱完全一致，只是 product 不同）：
 *   1. 本地生成 code_verifier / code_challenge（S256）
 *   2. 用系统浏览器打开 https://api.20050905.xyz/v1/auth/desktop/start?...
 *   3. 用户在网页里登录（或注册），网页登完把 code 交给服务端
 *   4. 客户端轮询 /v1/auth/desktop/poll，拿到 code 后 /exchange 换 access_token
 *
 * 令牌存在本机 unified-account.json（DPAPI 加密），绝不上传、也不进配置包。
 * 不再有「设备名」「配对码」「自动接入」这些东西。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { shell } from 'electron'
import { store, decryptToken, encryptToken } from './store'
import * as uapi from './unifiedapi'

/** 登录窗口 5 分钟内没登就放弃（用户可以再点一次） */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const POLL_INTERVAL_MS = 1500

export interface AccountInfo {
  loggedIn: boolean
  email?: string
  displayName?: string
  userId?: string
}

interface StoredAccount {
  /** DPAPI 密文（enc: 前缀） */
  token?: string
  user?: uapi.UnifiedUser
  savedAt?: number
}

function accountFile(): string {
  return path.join(store.dataDir, 'unified-account.json')
}

function read(): StoredAccount {
  try {
    return JSON.parse(fs.readFileSync(accountFile(), 'utf-8')) as StoredAccount
  } catch {
    return {}
  }
}

function write(patch: StoredAccount): void {
  const next: StoredAccount = { ...read(), ...patch, savedAt: Date.now() }
  fs.mkdirSync(path.dirname(accountFile()), { recursive: true })
  fs.writeFileSync(accountFile(), JSON.stringify(next, null, 2), 'utf-8')
}

/** 当前 access_token（主进程内部用，渲染层拿不到） */
export function currentToken(): string | undefined {
  const t = decryptToken(read().token)
  return t || undefined
}

export function isLoggedIn(): boolean {
  return !!currentToken()
}

export function accountInfo(): AccountInfo {
  const a = read()
  const u = a.user ?? {}
  return {
    loggedIn: !!currentToken(),
    email: typeof u.email === 'string' ? u.email : undefined,
    displayName:
      (typeof u.display_name === 'string' && u.display_name) ||
      (typeof u.username === 'string' ? u.username : undefined),
    userId: typeof u.id === 'string' ? u.id : undefined
  }
}

let loggingIn = false

/** 打开浏览器登录；已经在登就复用这一次 */
export async function login(): Promise<{ ok: boolean; message: string; account?: AccountInfo }> {
  if (loggingIn) return { ok: false, message: '正在等浏览器里完成登录…' }
  loggingIn = true
  try {
    const { verifier, challenge } = uapi.pkcePair()
    const state = crypto.randomBytes(12).toString('base64url')
    const url = uapi.desktopStartUrl(challenge, state)
    try {
      await shell.openExternal(url)
    } catch (e) {
      return { ok: false, message: `打不开浏览器：${(e as Error).message}` }
    }
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS)
      let r: { waiting?: boolean; code?: string }
      try {
        r = await uapi.desktopPoll(challenge)
      } catch {
        continue // 网络抖一下不算失败，接着等
      }
      if (!r?.code) continue
      const ex = await uapi.desktopExchange(r.code, verifier)
      if (!ex?.access_token) return { ok: false, message: '服务器没有返回登录令牌，请重试' }
      write({ token: encryptToken(ex.access_token), user: ex.user })
      const info = accountInfo()
      return {
        ok: true,
        message: info.email ? `已登录：${info.email}` : '登录成功',
        account: info
      }
    }
    return { ok: false, message: '登录超时（5 分钟内没在浏览器里完成登录）' }
  } catch (e) {
    return { ok: false, message: uapi.unifiedErrorText(e) }
  } finally {
    loggingIn = false
  }
}

/** 退出登录：只清本机令牌，服务端会话到期自然失效 */
export function logout(): AccountInfo {
  write({ token: undefined, user: undefined })
  return accountInfo()
}

/** 拉一次账号信息，顺便验证令牌还有效 */
export async function refresh(): Promise<{ ok: boolean; message: string; account: AccountInfo }> {
  const token = currentToken()
  if (!token) return { ok: false, message: '还没登录', account: accountInfo() }
  try {
    const u = await uapi.me(token)
    write({ user: { ...(read().user ?? {}), ...u } })
    return { ok: true, message: '账号信息已更新', account: accountInfo() }
  } catch (e) {
    const msg = uapi.unifiedErrorText(e)
    const status = (e as uapi.UnifiedError)?.status
    if (status === 401) logout()
    return { ok: false, message: msg, account: accountInfo() }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
