/**
 * 应用内通知（服务端 app_notification）。
 *
 * 服务端接口（app.py / store.py）：
 *   GET  /v1/notifications/public?product=wfmc   不用 token，只给 audience='public' 的公告
 *   GET  /v1/notifications                       Bearer，本人可见（全平台 + 本产品），带已读
 *   POST /v1/notifications/read  {ids}           Bearer，标记已读
 *
 * 约定：通知只能由**管理员后台**发布和删除，客户端只有「确认已读」，没有删除入口。
 * 未登录时服务端记不住谁读过，已读状态由渲染层存 localStorage（不是凭证）。
 */
import { BrowserWindow, Notification } from 'electron'
import type { NotifyItem, NotifyListResult } from '../shared/types'
import * as unified from './cloudlogin'
import { notificationList, notificationMarkRead, notificationPublic, unifiedErrorText } from './unifiedapi'

interface RawNotice {
  id: number
  title?: string
  body?: string
  url?: string
  level?: string
  mode?: string
  created_at?: string
  read?: boolean
}

function toItem(n: RawNotice): NotifyItem {
  return {
    id: Number(n.id),
    title: n.title ?? '',
    body: n.body ?? '',
    url: n.url ?? '',
    level: n.level ?? 'info',
    mode: n.mode ?? 'silent',
    createdAt: n.created_at ?? '',
    read: !!n.read
  }
}

/**
 * 拉通知：登录了走 /v1/notifications（服务端记已读），没登录走公开接口。
 * 登录但令牌过期时退回公开接口，至少还能看到面向所有人的公告。
 */
export async function listNotifications(): Promise<NotifyListResult> {
  const token = unified.currentToken()
  if (token) {
    try {
      const r = await notificationList(token)
      return { items: (r.items ?? []).map(toItem), loggedIn: true }
    } catch {
      /* 令牌过期 / 服务器抽风：下面退回公开接口 */
    }
  }
  try {
    const pub = await notificationPublic()
    return { items: (pub.items ?? []).map((n) => toItem({ ...n, read: false })), loggedIn: false }
  } catch {
    return { items: [], loggedIn: false }
  }
}

/** 标记已读。未登录时什么也不发，交给渲染层记本地。 */
export async function markNotificationsRead(  ids: unknown
): Promise<{ ok: boolean; message: string; loggedIn: boolean }> {
  const list = Array.isArray(ids)
    ? ids
        .map((x) => Number(x))
        .filter((x) => Number.isFinite(x) && x > 0)
        .slice(0, 100)
    : []
  if (list.length === 0) return { ok: true, message: '', loggedIn: unified.isLoggedIn() }
  const token = unified.currentToken()
  if (!token) return { ok: true, message: '未登录：已读只记在本机', loggedIn: false }
  try {
    await notificationMarkRead(token, list)
    return { ok: true, message: '已标记已读', loggedIn: true }
  } catch (e) {
    return { ok: false, message: unifiedErrorText(e), loggedIn: true }
  }
}

/**
 * 弹一条**系统通知**（Windows 右下角 / macOS 通知中心）。
 *
 * 只在服务端把通知设成 mode='popup' 时调用 —— 后台「通知」页勾选「弹窗（打开应用就弹出来）」
 * 就是这个 `display_mode='popup'`。点通知会把主窗口叫到前面。
 *
 * 注意：Windows 的 toast 依赖应用有 AppUserModelID 且有快捷方式，装在未打包环境（npm run dev）
 * 时可能不显示，打包进 exe 后正常；`Notification.isSupported()` 为 false 时静默降级。
 */
export function popSystemNotice(payload: { title?: string; body?: string }): {
  ok: boolean
  message: string
} {
  const title = (payload?.title ?? '').toString().trim().slice(0, 100) || 'WFMC 通知'
  const body = (payload?.body ?? '').toString().trim().slice(0, 300)
  if (!Notification.isSupported()) return { ok: false, message: '当前系统不支持系统通知' }
  try {
    const n = new Notification({ title, body })
    n.on('click', () => {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    })
    n.show()
    return { ok: true, message: '' }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
