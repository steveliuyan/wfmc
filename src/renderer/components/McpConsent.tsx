import React from 'react'
import { api, type McpConsentRequest } from '../api'

/**
 * AI 助手（MCP）要干一件会改动东西的事，先在这里问用户一句。
 *
 * 这个弹层不参与 App 里那套 `modal` 排队：它是被外部请求推出来的，优先级最高，
 * 所以 z-index 单独压到所有弹层上面（`.mcp-consent-mask`）。
 * 点「记住并一直允许」会对这个工具记一笔（写进 settings.json），以后连重启启动器都不再问；
 * 想收回就去设置页「AI 助手」里清空已记住的工具。
 */
export default function McpConsent({ req, onDone }: { req: McpConsentRequest; onDone: () => void }) {
  const reply = async (allow: boolean, remember = false) => {
    try {
      await api.mcpConsentReply(req.id, allow, remember)
    } catch {
      /* 主进程已经等了 3 分钟自己拒了，这里报错不影响什么 */
    }
    onDone()
  }

  return (
    <div className="dialog-mask mcp-consent-mask">
      <div className="dialog mcp-consent">
        <div className="dialog-title">AI 助手想做一件事</div>
        <div className="mcp-consent-tool">
          <span className="mcp-consent-badge">MCP</span>
          <b>{req.title}</b>
        </div>
        <div className="mcp-consent-summary">{req.summary}</div>
        {Object.keys(req.args ?? {}).length > 0 && (
          <pre className="set-code">{JSON.stringify(req.args, null, 2)}</pre>
        )}
        <p className="muted small">
          允许这一次就会真的动手；不放心就点「拒绝」，AI 会收到「用户拒绝了这次操作」。
          嫌烦就点「记住并一直允许」，这个 AI 客户端以后调这个操作不再弹窗（存进设置，重启也记得），
          想反悔去设置页「AI 助手」清空已记住的工具。
        </p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => void reply(false)}>
            拒绝
          </button>
          <button className="btn" onClick={() => void reply(true, true)}>
            记住并一直允许
          </button>
          <button className="btn primary" onClick={() => void reply(true)} autoFocus>
            允许
          </button>
        </div>
      </div>
    </div>
  )
}
