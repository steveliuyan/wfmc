import React, { useEffect, useRef } from 'react'
import { api } from '../api'
import type { NotifyItem } from '../../shared/types'

/**
 * 通知页：服务端发的公告/通知都在这里。
 * 只能「确认」标已读，没有删除——删除只在管理员后台。
 */
export default function Notify({
  items,
  loggedIn,
  isRead,
  onAck,
  onRefresh
}: {
  items: NotifyItem[]
  loggedIn: boolean
  isRead: (n: NotifyItem) => boolean
  onAck: (n: NotifyItem) => void
  onRefresh: () => void
}) {
  const unread = items.filter((n) => !isRead(n)).length

  // 进页面就自己拉一次：通知是服务端发的，别人刚发的公告不该让用户先去点「刷新」才看得到
  const pulled = useRef(false)
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh
  useEffect(() => {
    if (pulled.current) return
    pulled.current = true
    refreshRef.current()
  }, [])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>通知</h1>
          <p className="muted small">
            {unread ? `${unread} 条未读` : '都看过了'} · 通知由管理员在后台发布和删除，这里只能点「确认」标记已读
            {loggedIn ? '' : '；未登录时已读只记在这台电脑上'}
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn sm ghost" onClick={onRefresh}>
            刷新
          </button>
        </div>
      </header>

      {items.length === 0 && (
        <div className="card">
          <p className="set-note">暂时没有通知。</p>
        </div>
      )}

      <div className="notice-list notice-page">
        {items.map((n) => {
          const crit = n.level === 'important' || n.level === 'critical'
          const warn = n.level === 'warn'
          const read = isRead(n)
          const url = n.url
          return (
            <div
              key={n.id}
              className={`notice-item ${crit ? 'crit' : warn ? 'warn' : ''} ${read ? 'read' : 'unread'}`}
            >
              <div className="notice-item-head">
                <span className={`notice-tag ${crit ? 'crit' : warn ? 'warn' : ''}`}>
                  {crit ? '重要' : warn ? '提醒' : '公告'}
                </span>
                <span className="notice-item-title">{n.title}</span>
                {n.createdAt ? (
                  <span className="notice-item-time">{new Date(n.createdAt).toLocaleString()}</span>
                ) : null}
              </div>
              {n.body && <div className="notice-item-body">{n.body}</div>}
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                {url && /^https?:\/\//i.test(url) && (
                  <button className="btn sm ghost" onClick={() => void api.openExternal(url)}>
                    打开链接 →
                  </button>
                )}
                {read ? (
                  <span className="notice-read-tag">已读</span>
                ) : (
                  <button className="btn sm primary" onClick={() => onAck(n)}>
                    确认
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
