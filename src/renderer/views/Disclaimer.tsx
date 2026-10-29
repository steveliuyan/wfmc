import React from 'react'
import { DISCLAIMER_SECTIONS, DISCLAIMER_TITLE, DISCLAIMER_VERSION } from '../../shared/disclaimer'

/**
 * 免责声明弹窗：
 * - mode='consent'：首启强制确认（同意 / 退出）
 * - mode='view'：设置页随时查看（关闭）
 */
export default function Disclaimer({
  mode,
  onAgree,
  onClose
}: {
  mode: 'consent' | 'view'
  onAgree?: () => void
  onClose?: () => void
}) {
  return (
    <div className="dialog-mask" onClick={mode === 'view' ? onClose : undefined}>
      <div className="dialog disclaimer" onClick={(e) => e.stopPropagation()}>
        <div className="disclaimer-head">
          <h2>{DISCLAIMER_TITLE}</h2>
          <span className="muted small">版本 {DISCLAIMER_VERSION}</span>
        </div>

        <div className="disclaimer-body">
          {DISCLAIMER_SECTIONS.map((s) => (
            <section key={s.heading}>
              <h3>{s.heading}</h3>
              <p>{s.body}</p>
            </section>
          ))}
        </div>

        <div className="dialog-actions">
          {mode === 'consent' ? (
            <>
              <button className="btn" onClick={() => window.close()}>
                不同意并退出
              </button>
              <button className="btn primary" onClick={onAgree} autoFocus>
                我已阅读并同意
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={onClose}>
              知道了
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
