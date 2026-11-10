import React, { useCallback, useEffect, useState } from 'react'
import { api, type McpStatusInfo } from '../api'
import { useLauncher } from '../store'

/**
 * 设置页里的「AI 助手（MCP）」分区。
 *
 * 它自己不说话，只做三件事：显示桥有没有开着、端口是多少；两个开关（允许 AI 连 / 不再逐次确认）；
 * 以及把客户端要填的那段 JSON 交出去（一键复制）。
 * 开关改完要让主进程重启桥（端口和令牌会换新的），所以改完立刻调一次 mcpRestart。
 */
export default function McpPanel() {
  const { settings, saveSettings, toast } = useLauncher()
  const [status, setStatus] = useState<McpStatusInfo>()
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.mcpStatus())
    } catch {
      /* 读不到就当没开，下面按 undefined 渲染 */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const enabled = settings?.mcp?.enabled !== false
  const trustAll = settings?.mcp?.trustAll === true

  const apply = async (patch: { enabled?: boolean; trustAll?: boolean }) => {
    setBusy(true)
    try {
      await saveSettings({ mcp: { ...(settings?.mcp ?? {}), ...patch } })
      // 令牌和端口跟着重启一起换，重启完再读一次状态
      setStatus(await api.mcpRestart())
    } catch (e) {
      toast(`设置没生效：${(e as Error)?.message ?? e}`)
    } finally {
      setBusy(false)
    }
  }

  const copyConfig = async () => {
    const cfg = status?.clientConfig?.json
    if (!cfg) return
    try {
      await navigator.clipboard.writeText(cfg)
      toast('已复制，粘到 AI 客户端的配置里就行')
    } catch {
      toast('复制失败，可以手动选中下面的文字复制')
    }
  }

  return (
    <>
      <div className="set-head">
        <div className="set-icon">🤖</div>
        <div className="set-titles">
          <div className="set-title">AI 助手（MCP）</div>
          <div className="set-desc">
            让 Claude Desktop 这类 AI 客户端直接操作启动器：查实例、开游戏、装整合包。
            接口只监听本机 127.0.0.1，还要一次性令牌；每做一件会改动东西的事，都会先弹窗问你。
          </div>
        </div>
      </div>

      <div className="switch-list">
        <label className="switch-row">
          <span className="switch-text">
            <span className="switch-title">允许 AI 助手连接</span>
            <span className="switch-desc">
              关掉之后本机接口立刻停掉，客户端再调会连不上；下次打开启动器也不会自己开
            </span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void apply({ enabled: e.target.checked })}
          />
        </label>
        <label className="switch-row">
          <span className="switch-text">
            <span className="switch-title">不再逐次确认</span>
            <span className="switch-desc">
              打开后 AI 的写操作（启动游戏、装东西）不再弹窗，直接执行。只在你盯着 AI 干活时打开，否则等于把启动器完全交出去
            </span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={trustAll}
            disabled={busy || !enabled}
            onChange={(e) => void apply({ trustAll: e.target.checked })}
          />
        </label>
      </div>

      <p className="set-note">
        {status?.running
          ? `本机接口已开，端口 ${status.port}。把下面这段填进 AI 客户端的 mcpServers 里就能用了。`
          : enabled
            ? '接口还没起来（主进程没启动完，或者端口被占了），点「刷新」再看看。'
            : '现在是关着的，打开上面的开关才会起接口。'}
      </p>

      {status?.endpointFile && (
        <div className="set-path">
          <code title={status.endpointFile}>{status.endpointFile}</code>
          <button type="button" className="btn sm" onClick={() => void refresh()} disabled={busy}>
            刷新
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={() => void copyConfig()}
            disabled={!status?.clientConfig?.json}
          >
            复制配置
          </button>
        </div>
      )}

      {status?.clientConfig?.json && (
        <pre className="set-code" onClick={() => void copyConfig()}>
          {status.clientConfig.json}
        </pre>
      )}

      {status && status.pendingConsent > 0 && (
        <p className="set-note">有 {status.pendingConsent} 个请求正等你确认，关掉这个页面也能看到弹窗。</p>
      )}
    </>
  )
}
