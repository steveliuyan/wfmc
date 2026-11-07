import React from 'react'
import { api } from '../api'
import type { NotifyItem } from '../../shared/types'

/**
 * 「弹窗」类服务端通知的模态框。
 *
 * 对应后台「通知」页里 `display_mode = 'popup'`（弹窗（打开应用就弹出来））。
 * 只在**未读**且**本地没弹过**时出现一次；点「知道了」= 确认已读（登录了会同步到服务端）。
 * 通知只能由管理员在后台发布和删除，这里没有删除入口。
 */
export default function NoticePopup({
  item,
  remaining,
  onAck,
  onLater
}: {
  item: NotifyItem
  /** 队列里还剩几条（含当前这条） */
  remaining: number
  onAck: (n: NotifyItem) => void
  onLater: (n: NotifyItem) => void
}) {
  const crit = item.level === 'important' || item.level === 'critical'
  const warn = item.level === 'warn'
  const url = item.url
  return (
    <div className="dialog-mask">
      <div className={`dialog notice-popup ${crit ? 'crit' : warn ? 'warn' : ''}`}>
        <div className="notice-popup-head">
          <span className={`notice-tag ${crit ? 'crit' : warn ? 'warn' : ''}`}>
            {crit ? '重要' : warn ? '提醒' : '公告'}
          </span>
          {item.createdAt ? (
            <span className="muted small">{new Date(item.createdAt).toLocaleString()}</span>
          ) : null}
          {remaining > 1 ? <span className="muted small notice-popup-more">还有 {remaining - 1} 条</span> : null}
        </div>

        <div className="dialog-title">{item.title || '服务端通知'}</div>
        {item.body ? <div className="dialog-body notice-popup-body">{item.body}</div> : null}

        <div className="dialog-actions">
          {url && /^https?:\/\//i.test(url) && (
            <button className="btn ghost" onClick={() => void api.openExternal(url)}>
              打开链接 →
            </button>
          )}
          <button className="btn" onClick={() => onLater(item)}>
            稍后再看
          </button>
          <button className="btn primary" onClick={() => onAck(item)} autoFocus>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
