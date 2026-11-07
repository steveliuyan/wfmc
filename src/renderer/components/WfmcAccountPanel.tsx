import React, { useCallback, useEffect, useState } from 'react'
import { api, friendlyError } from '../api'
import { useLauncher } from '../store'
import type { WfmcAccountStatus } from '../../shared/types'

/**
 * 账号面板。
 *
 * 账号体系已经统一：以前 WFMC 有自己一套「用户名 + 密码 + 两步验证 + 设备绑定」，
 * 现在跟网页端共用同一个账号（浏览器里登录，走 PKCE 回调），启动器这边**不碰密码**。
 *
 * 所以这一块只做三件事：看当前登录的是谁、登录 / 退出、去网页上改密码和两步验证。
 */
export default function WfmcAccountPanel() {
  const { toast } = useLauncher()
  const [status, setStatus] = useState<WfmcAccountStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.accountStatus())
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    try {
      setMsg(await fn())
    } catch (e) {
      const m = friendlyError(e)
      setMsg(m)
      toast(m, 'error')
    } finally {
      setBusy('')
      await refresh()
    }
  }

  const loggedIn = !!status?.loggedIn
  const who = status?.displayName || status?.email || ''

  return (
    <>
      <div className="set-head">
        <div className="set-icon">👤</div>
        <div className="set-titles">
          <div className="set-title">账号</div>
          <div className="set-desc">
            启动器用的账号就是网页上的那个账号，登录在浏览器里完成，启动器不保存密码。
            登录后备份可以多存一份到云端；不登录也能正常玩，只是备份只在本地。
          </div>
        </div>
      </div>

      <div className="set-block">
        <div className="set-block-title">
          登录状态
          <span className={loggedIn ? 'cloud-badge ok' : 'cloud-badge'}>{loggedIn ? '已登录' : '未登录'}</span>
        </div>
        {loggedIn ? (
          <>
            <p className="set-note" style={{ marginTop: 0 }}>
              当前账号：<b>{who || '（未命名）'}</b>
              {status?.email && who !== status.email ? `（${status.email}）` : ''}
            </p>
            <div className="set-actions">
              <button
                className="btn sm"
                disabled={busy === 'refresh'}
                onClick={() =>
                  void run('refresh', async () => {
                    const r = await api.accountRefresh()
                    return r.message || (r.ok ? '账号状态已刷新' : '刷新失败')
                  })
                }
              >
                {busy === 'refresh' ? '刷新中…' : '刷新'}
              </button>
              <button
                className="btn sm ghost"
                onClick={() =>
                  void run('logout', async () => {
                    if (!window.confirm('退出登录？\n备份还会继续存本地，只是不再往云端传。')) return '已取消'
                    const r = await api.accountLogout()
                    return r.message
                  })
                }
              >
                退出登录
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="set-note" style={{ marginTop: 0 }}>
              点下面的按钮，启动器会打开浏览器里的登录页（没账号可以直接在那里注册）。
              登录完成后会自动回到启动器，不用在这里填任何东西。
            </p>
            <div className="set-actions">
              <button
                className="btn sm primary"
                disabled={busy === 'login'}
                onClick={() =>
                  void run('login', async () => {
                    const r = await api.accountLogin()
                    toast(r.message, r.ok ? 'success' : 'error')
                    return r.message
                  })
                }
              >
                {busy === 'login' ? '等待浏览器里完成登录…' : '用浏览器登录 / 注册'}
              </button>
            </div>
          </>
        )}
      </div>

      <div className="set-block">
        <div className="set-block-title">密码与两步验证</div>
        <p className="set-note" style={{ marginTop: 0 }}>
          这些都在网页上改，启动器不保存密码，也就不提供表单。
        </p>
        <div className="set-actions">
          <button className="btn sm" onClick={() => void api.openExternal('https://api.20050905.xyz/account')}>
            打开账号管理网页
          </button>
        </div>
      </div>

      {msg && <p className="set-note">{msg}</p>}
    </>
  )
}
