import React from 'react'
import { markWhatsNewSeen, type WhatsNewEntry } from '../whatsnew'

/**
 * 升级公告弹层。数据来自 `whatsnew.ts`（写死在包里），渲染前不请求任何东西，
 * 所以断网、没登录也能看到「这次更新了什么」。
 */
export default function WhatsNew({
  entry,
  onClose
}: {
  entry: WhatsNewEntry
  onClose: () => void
}) {
  const close = () => {
    markWhatsNewSeen(entry.version)
    onClose()
  }
  return (
    <div className="dialog-mask">
      <div className="dialog whats-new">
        <div className="dialog-title">这次更新了什么</div>
        <div className="muted small">版本 v{entry.version}</div>
        <ul className="whats-new-list">
          {entry.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button className="btn primary" onClick={close} autoFocus>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
