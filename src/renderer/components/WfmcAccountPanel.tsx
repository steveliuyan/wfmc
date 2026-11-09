import React, { useCallback, useEffect, useState } from 'react'
import { api, friendlyError } from '../api'
import { useLauncher } from '../store'
import type { CloudStatus, WfmcAccountStatus } from '../../shared/types'

/**
 * 账号面板。
 *
 * 账号体系已经统一：以前 WFMC 有自己一套「用户名 + 密码 + 两步验证 + 设备绑定」，
 * 现在跟网页端共用同一个账号（浏览器里登录，走 PKCE 回调），启动器这边**不碰密码**。
 *
 * 所以这一块只做三件事：看当前登录的是谁、登录 / 退出、去网页上改密码和两步验证。
 *
 * variant='cloud' 时用作「云同步」分区的头：状态、刷新/退出、管理账号、测试连接全并到这一块，
 * 下面 CloudPanel 只留「备份怎么存」，不再重复一颗「已登录」徽章。
 */
export default function WfmcAccountPanel({ variant = 'account' }: { variant?: 'account' | 'cloud' }) {
  const { toast } = useLauncher()
  const isCloud = variant === 'cloud'
  const [status, setStatus] = useState<WfmcAccountStatus | null>(null)
  const [cloud, setCloud] = useState<CloudStatus | null>(null)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.accountStatus())
    } catch (e) {
      setMsg(friendlyError(e))
    }
  }, [])

  // 云同步分区里还要显示「云端保留几份」，顺手取一次（失败就当没有，不影响登录态）
  const refreshCloud = useCallback(async () => {
    if (!isCloud) return
    try {
      setCloud(await api.cloudStatus())
    } catch {
      /* 忽略 */
    }
  }, [isCloud])

  useEffect(() => {
    void refresh()
    void refreshCloud()
  }, [refresh, refreshCloud])

  // 浏览器里登录完回跳会触发 protocol 事件，这里跟着刷一次
  useEffect(
    () =>
      api.onProtocol(() => {
        void refresh()
        void refreshCloud()
      }),
    [refresh, refreshCloud]
  )

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
      await refreshCloud()
    }
  }

  const loggedIn = !!status?.loggedIn
  const who = status?.displayName || status?.email || ''
  const autoKeep = cloud?.limits?.autoKeep ?? 3
  const manualKeep = cloud?.limits?.manualKeep ?? 5

  return (
    <>
      <div className="set-head">
        <div className="set-icon">{isCloud ? '☁' : '👤'}</div>
        <div className="set-titles">
          <div className="set-title">{isCloud ? '云端账号' : '账号'}</div>
          <div className="set-desc">
            {isCloud
              ? '就是启动器同一个账号。登录之后每次备份会额外往云端存一份，换电脑时能直接还原；不登录也一切正常，只是备份只在本地。'
              : '启动器用的账号就是网页上的那个账号，登录在浏览器里完成，启动器不保存密码。登录后备份可以多存一份到云端；不登录也能正常玩，只是备份只在本地。'}
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
              {isCloud ? `。云端保留自动 ${autoKeep} 份 / 手动 ${manualKeep} 份，由服务器统一管理。` : ''}
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
              <button
                className="btn sm ghost"
                onClick={() => void api.openExternal('https://api.20050905.xyz/account?product=wfmc')}
              >
                管理账号
              </button>
              {isCloud && (
                <button
                  className="btn sm ghost"
                  disabled={busy === 'test'}
                  onClick={() =>
                    void run('test', async () => {
                      const r = await api.testCloud()
                      toast(r.message, r.authorized ? 'success' : 'error')
                      return r.message
                    })
                  }
                >
                  {busy === 'test' ? '测试中…' : '测试连接'}
                </button>
              )}
            </div>
            {isCloud && (
              <p className="set-note">
                改密码、看账号信息在「账号」页；这里管的是备份存哪、云端留几份。
                登录令牌只存在本机（换了机器本来也解不开），还原后需要重新登录一次。
              </p>
            )}
          </>
        ) : (
          <>
            <p className="set-note" style={{ marginTop: 0 }}>
              点下面的按钮，启动器会打开浏览器里的登录页（没账号可以直接在那里注册）。
              登录完成后会自动回到启动器，不用在这里填任何东西。
              {isCloud ? '不登录也一切正常，只是备份只留在本地。' : ''}
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

      {!isCloud && (
        <div className="set-block">
          <div className="set-block-title">密码与两步验证</div>
          <p className="set-note" style={{ marginTop: 0 }}>
            这些都在网页上改，启动器不保存密码，也就不提供表单。
          </p>
          <div className="set-actions">
            <button className="btn sm" onClick={() => void api.openExternal('https://api.20050905.xyz/account?product=wfmc')}>
              打开账号管理网页
            </button>
          </div>
        </div>
      )}

      {msg && <p className="set-note">{msg}</p>}
    </>
  )
}
