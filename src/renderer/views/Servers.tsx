import React, { useEffect, useState } from 'react'
import { api, friendlyError } from '../api'
import { useLauncher, useT } from '../store'
import { joinWithSync } from '../joinWithSync'
import type { SavedServer, ServerStatus } from '../../shared/types'
import type { PageId } from '../App'

export default function Servers({ goto }: { goto: (p: PageId) => void }) {
  const { current, currentId, toast, askConfirm } = useLauncher()
  const t = useT()
  const [servers, setServers] = useState<SavedServer[]>([])
  const [status, setStatus] = useState<Record<string, ServerStatus>>({})
  const [pinging, setPinging] = useState<Record<string, boolean>>({})
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [query, setQuery] = useState('')
  const [queryResult, setQueryResult] = useState<ServerStatus>()
  const [querying, setQuerying] = useState(false)

  const refresh = async () => setServers(await api.listServers())

  useEffect(() => {
    refresh()
  }, [])

  const doPing = async (srv: SavedServer) => {
    setPinging((p) => ({ ...p, [srv.id]: true }))
    try {
      const res = await api.pingServer(srv.address, srv.port)
      setStatus((prev) => ({ ...prev, [srv.id]: res }))
    } catch (e) {
      setStatus((prev) => ({ ...prev, [srv.id]: { online: false, error: (e as Error).message } }))
    } finally {
      setPinging((p) => ({ ...p, [srv.id]: false }))
    }
  }

  const pingAll = async () => {
    for (const srv of servers) await doPing(srv)
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('服务器', 'Servers')}</h1>
          <p className="muted">
            收藏服务器、查在线人数与延迟，支持 SRV 记录解析，一键带 IP 进服。
            {current ? ` 进服实例：${current.name}` : ' 先在左侧选一个实例。'}
          </p>
        </div>
        <button className="btn" onClick={pingAll}>
          全部刷新
        </button>
      </header>

      <div className="card">
        <h3>快速查询 / 添加</h3>
        <div className="row wrap">
          <input
            className="grow"
            placeholder="服务器地址，例如 mc.hypixel.net 或 play.example.com:25566"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <input
            className="w140"
            placeholder="备注名（可选）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn primary"
            onClick={async () => {
              if (!address.trim()) return toast('先填服务器地址', 'error')
              await api.addServer({ name, address })
              setName('')
              setAddress('')
              await refresh()
              toast('已添加', 'success')
            }}
          >
            收藏
          </button>
          <button
            className="btn"
            disabled={querying}
            onClick={async () => {
              if (!address.trim()) return toast('先填服务器地址', 'error')
              setQuerying(true)
              try {
                setQueryResult(await api.pingServer(address))
              } finally {
                setQuerying(false)
              }
            }}
          >
            {querying ? '查询中…' : '只查询'}
          </button>
        </div>
        {queryResult && (
          <div className="card inner">
            <div className="row wrap">
              {queryResult.favicon && <img src={queryResult.favicon} alt="" style={{ width: 48, height: 48, borderRadius: 8 }} />}
              <div>
                <div>
                  {queryResult.online ? (
                    <span className="badge ok">在线</span>
                  ) : (
                    <span className="badge warn">离线</span>
                  )}{' '}
                  <b>{queryResult.online ? `${queryResult.players?.online ?? 0}/${queryResult.players?.max ?? 0} 人` : queryResult.error}</b>
                  {queryResult.latency !== undefined && <span className="muted small"> · {queryResult.latency} ms</span>}
                </div>
                <div className="muted small">
                  {queryResult.version ? `版本 ${queryResult.version}` : ''}
                  {queryResult.srv ? ` · SRV → ${queryResult.srv.host}:${queryResult.srv.port}` : ''}
                </div>
                {queryResult.motd && <div className="small" style={{ marginTop: 4 }}>{queryResult.motd}</div>}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="cards">
        {servers.length === 0 && <div className="card empty">还没有收藏服务器。上面填个地址点「收藏」就行。</div>}
        {servers.map((srv) => {
          // 先用上次缓存的 MOTD / 图标把卡片画出来，再点刷新拿最新
          const st = status[srv.id] ?? srv.lastStatus
          return (
            <div className="card" key={srv.id}>
              <div className="instance-head">
                <h3 className="row" style={{ gap: 8 }}>
                  {srv.icon && <img src={srv.icon} alt="" className="server-icon" />}
                  {srv.name}
                </h3>
                {st ? (
                  st.online ? (
                    <span className="badge ok">在线</span>
                  ) : (
                    <span className="badge warn">离线</span>
                  )
                ) : (
                  <span className="badge">未查询</span>
                )}
              </div>
              <div className="muted small">
                {srv.address}
                {srv.port ? `:${srv.port}` : ''}
                {st?.srv ? ` · SRV ${st.srv.host}:${st.srv.port}` : ''}
              </div>
              {st?.online && (
                <div className="small" style={{ marginTop: 6 }}>
                  <b>
                    {st.players?.online ?? 0}/{st.players?.max ?? 0} 人
                  </b>
                  <span className="muted"> · {st.latency} ms{st.version ? ` · ${st.version}` : ''}</span>
                  {st.motd && <div className="muted small">{st.motd}</div>}
                </div>
              )}
              {st && !st.online && <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>{st.error}</div>}
              <div className="row wrap" style={{ marginTop: 10 }}>
                <button className="btn sm" disabled={pinging[srv.id]} onClick={() => doPing(srv)}>
                  {pinging[srv.id] ? '查询中…' : '刷新'}
                </button>
                <button
                  className="btn primary sm"
                  disabled={!currentId || !current?.installed}
                  onClick={async () => {
                    try {
                      const joined = await joinWithSync({
                        instanceId: currentId!,
                        host: srv.address,
                        port: srv.port ?? 25565,
                        toast,
                        askConfirm
                      })
                      if (joined) goto('home')
                    } catch (e) {
                      toast(`进服失败：${friendlyError(e)}`, 'error')
                    }
                  }}
                >
                  一键进服
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await api.removeServer(srv.id)
                    await refresh()
                  }}
                >
                  移除
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
