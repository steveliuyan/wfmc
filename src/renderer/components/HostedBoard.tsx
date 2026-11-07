import React, { useCallback, useEffect, useState } from 'react'
import { api, friendlyError, type AddonHit, type AddonVersion, type HostedMetrics, type HostedServer, type InstalledAddon, type ServerSched } from '../api'
import { useLauncher } from '../store'

/**
 * 服主面板 2.0（C 方向）：看板 + 计划任务 + 插件与模组市场。
 * 做成独立组件挂到 Hosting 页面里，Hosting.tsx 只多一个按钮，少改大文件。
 */

interface Props {
  server: HostedServer
  running: boolean
}

type Tab = 'overview' | 'sched' | 'addons'

function fmtUptime(ms: number): string {
  if (!ms) return '—'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h} 小时 ${m} 分`
  if (m > 0) return `${m} 分 ${s % 60} 秒`
  return `${s} 秒`
}

function fmtMb(n?: number): string {
  if (n === undefined || Number.isNaN(n)) return '—'
  return n >= 1024 ? `${(n / 1024).toFixed(1)}G` : `${Math.round(n)}M`
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${Math.round(n / 1024)}KB`
}

function fmtAgo(at?: number): string {
  if (!at) return '还没跑过'
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

export default function HostedBoard({ server, running }: Props) {
  const { toast } = useLauncher()
  const [tab, setTab] = useState<Tab>('overview')
  const [metrics, setMetrics] = useState<HostedMetrics>()
  const [sched, setSched] = useState<ServerSched>()
  const [installed, setInstalled] = useState<InstalledAddon[]>([])
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<'modrinth' | 'hangar'>('modrinth')
  const [hits, setHits] = useState<AddonHit[]>([])
  const [searching, setSearching] = useState(false)
  const [picked, setPicked] = useState<{ hit: AddonHit; list: AddonVersion[] }>()
  const [busy, setBusy] = useState<string>()
  const [player, setPlayer] = useState('')

  const kind: 'plugin' | 'mod' = server.kind === 'paper' || server.kind === 'vanilla' ? 'plugin' : 'mod'

  const refreshMetrics = useCallback(async () => {
    try {
      setMetrics(await api.hostedMetrics(server.id))
    } catch {
      /* 面板刷新失败不打扰用户 */
    }
  }, [server.id])

  const refreshInstalled = useCallback(async () => {
    try {
      setInstalled(await api.addonList(server.id, kind))
    } catch {
      setInstalled([])
    }
  }, [server.id, kind])

  // 概览页 3 秒刷新一次；面板关掉（组件卸载）自动停
  useEffect(() => {
    void refreshMetrics()
    if (tab !== 'overview') return
    const timer = setInterval(() => void refreshMetrics(), 3000)
    return () => clearInterval(timer)
  }, [tab, refreshMetrics])

  useEffect(() => {
    void api.hostedSched(server.id).then(setSched).catch(() => undefined)
  }, [server.id])

  useEffect(() => {
    if (tab === 'addons') void refreshInstalled()
  }, [tab, refreshInstalled])

  const patchSched = async (patch: Partial<ServerSched>) => {
    try {
      setSched(await api.saveHostedSched(server.id, patch))
    } catch (e) {
      toast(`保存失败：${friendlyError(e)}`, 'error')
    }
  }

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    setPicked(undefined)
    try {
      const list = await api.addonSearch({
        query: query.trim(),
        kind,
        mcVersion: server.mcVersion,
        loader: kind === 'mod' ? server.kind : undefined,
        source
      })
      setHits(list)
      if (list.length === 0) toast('没搜到，换个关键词试试', 'info')
    } catch (e) {
      toast(`搜索失败：${friendlyError(e)}`, 'error')
    } finally {
      setSearching(false)
    }
  }

  const openVersions = async (hit: AddonHit) => {
    setBusy(hit.id)
    try {
      const list = await api.addonVersions(hit, {
        kind,
        mcVersion: server.mcVersion,
        loader: kind === 'mod' ? server.kind : undefined
      })
      setPicked({ hit, list })
      if (list.length === 0) toast('这个项目没有适配当前版本的下载', 'info')
    } catch (e) {
      toast(`取版本失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(undefined)
    }
  }

  const install = async (hit: AddonHit, version: AddonVersion) => {
    if (running) {
      toast('先停服再装（运行中替换 jar 会加载失败）', 'error')
      return
    }
    setBusy(version.fileUrl)
    try {
      const res = await api.addonInstall(server.id, version, kind)
      toast(`已安装 ${res.fileName}（${fmtBytes(res.bytes)}），启动后生效`, 'success')
      await refreshInstalled()
      setPicked(undefined)
    } catch (e) {
      toast(`安装失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(undefined)
    }
  }

  const uninstall = async (fileName: string) => {
    if (running) {
      toast('先停服再卸载', 'error')
      return
    }
    try {
      await api.addonRemove(server.id, fileName, kind)
      toast(`已卸载 ${fileName}（挪到 .trash 了，后悔还能捞回来）`, 'success')
      await refreshInstalled()
    } catch (e) {
      toast(`卸载失败：${friendlyError(e)}`, 'error')
    }
  }

  const act = async (name: string, action: 'kick' | 'ban' | 'op' | 'deop') => {
    try {
      toast(await api.hostedPlayerAction(server.id, name, action), 'success')
      setPlayer('')
      await refreshMetrics()
    } catch (e) {
      toast(`操作失败：${friendlyError(e)}`, 'error')
    }
  }

  const m = metrics

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        {(
          [
            ['overview', '看板'],
            ['sched', '计划任务'],
            ['addons', kind === 'plugin' ? '插件市场' : '模组市场']
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`btn sm ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
        <span className="mini-label" style={{ marginLeft: 'auto' }}>
          {server.name} · {server.kind} {server.mcVersion} · 端口 {server.port}
        </span>
      </div>

      {tab === 'overview' && (
        <div>
          <div className="row wrap" style={{ gap: 10 }}>
            {[
              ['状态', running ? (m?.ready ? '运行中' : '启动中…') : '已停止'],
              ['在线', m ? `${m.players.length} 人` : '—'],
              ['TPS', m?.tps !== undefined ? m.tps.toFixed(1) : '—'],
              ['内存', m ? `${fmtMb(m.usedMb)} / ${fmtMb(m.maxMb ?? m.memoryMb)}` : '—'],
              ['已运行', m ? fmtUptime(m.uptime) : '—'],
              [kind === 'plugin' ? '插件' : '模组', m ? `${m.mods} 个` : '—']
            ].map(([label, value]) => (
              <div key={label} className="stat" style={{ minWidth: 118 }}>
                <span>{label}</span>
                <b style={{ fontSize: 16 }}>{value}</b>
              </div>
            ))}
          </div>

          {!running && (
            <div className="mini-label" style={{ marginTop: 10 }}>
              服务端没在跑，看板里的数字要启动后才有（计划任务和插件市场照样能配）。
            </div>
          )}

          {running && m && m.players.length === 0 && (
            <div className="mini-label" style={{ marginTop: 10 }}>
              现在没人在线。有人进服 / 退服会自动出现在这里。
            </div>
          )}

          {running && m && m.players.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="mini-label" style={{ marginBottom: 6 }}>
                在线玩家（点一下就执行，不用记命令）
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                {m.players.map((name) => (
                  <div key={name} className="row" style={{ gap: 4, alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>{name}</span>
                    <button className="btn sm" onClick={() => void act(name, 'op')}>
                      给管理员
                    </button>
                    <button className="btn sm" onClick={() => void act(name, 'kick')}>
                      踢出
                    </button>
                    <button className="btn sm danger" onClick={() => void act(name, 'ban')}>
                      封禁
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="row" style={{ gap: 6, marginTop: 12 }}>
            <input
              placeholder="按名字操作某个玩家（离线也可以）"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <button className="btn sm" disabled={!player.trim()} onClick={() => void act(player.trim(), 'op')}>
              Op
            </button>
            <button className="btn sm" disabled={!player.trim()} onClick={() => void act(player.trim(), 'deop')}>
              取消 Op
            </button>
            <button className="btn sm" disabled={!player.trim()} onClick={() => void act(player.trim(), 'kick')}>
              踢出
            </button>
            <button className="btn sm danger" disabled={!player.trim()} onClick={() => void act(player.trim(), 'ban')}>
              封禁
            </button>
          </div>
        </div>
      )}

      {tab === 'sched' && sched && (
        <div>
          <div className="mini-label" style={{ marginBottom: 8 }}>
            全部默认关闭，开了才跑。停服状态下到点也不会硬拉起来（看门狗例外，它只在崩溃后动手）。
          </div>

          <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sched.backup.enabled}
                onChange={(e) => void patchSched({ backup: { ...sched.backup, enabled: e.target.checked } })}
              />
              定时备份
            </label>
            <span className="mini-label">每</span>
            <input
              type="number"
              min={5}
              max={1440}
              value={sched.backup.everyMinutes}
              onChange={(e) =>
                void patchSched({ backup: { ...sched.backup, everyMinutes: Number(e.target.value) } })
              }
              style={{ width: 80 }}
            />
            <span className="mini-label">分钟，留最近</span>
            <input
              type="number"
              min={1}
              max={50}
              value={sched.backup.keep}
              onChange={(e) => void patchSched({ backup: { ...sched.backup, keep: Number(e.target.value) } })}
              style={{ width: 70 }}
            />
            <span className="mini-label">份 · 上次 {fmtAgo(sched.lastBackupAt)}</span>
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  const file = await api.backupHostedNow(server.id)
                  toast(`已备份：${file}`, 'success')
                  setSched(await api.hostedSched(server.id))
                } catch (e) {
                  toast(`备份失败：${friendlyError(e)}`, 'error')
                }
              }}
            >
              立刻备份
            </button>
          </div>

          <div className="row wrap" style={{ gap: 10, alignItems: 'center', marginTop: 12 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sched.restart.enabled}
                onChange={(e) => void patchSched({ restart: { ...sched.restart, enabled: e.target.checked } })}
              />
              定时重启
            </label>
            <span className="mini-label">每</span>
            <input
              type="number"
              min={30}
              max={10080}
              value={sched.restart.everyMinutes}
              onChange={(e) =>
                void patchSched({ restart: { ...sched.restart, everyMinutes: Number(e.target.value) } })
              }
              style={{ width: 90 }}
            />
            <span className="mini-label">
              分钟（重启前会顺手备份一次）· 上次 {fmtAgo(sched.lastRestartAt)}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 10, alignItems: 'center', marginTop: 12 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sched.logrotate.enabled}
                onChange={(e) => void patchSched({ logrotate: { ...sched.logrotate, enabled: e.target.checked } })}
              />
              日志轮转
            </label>
            <span className="mini-label">超过</span>
            <input
              type="number"
              min={1}
              max={500}
              value={sched.logrotate.maxMb}
              onChange={(e) =>
                void patchSched({ logrotate: { ...sched.logrotate, maxMb: Number(e.target.value) } })
              }
              style={{ width: 70 }}
            />
            <span className="mini-label">MB 就归档，留最近</span>
            <input
              type="number"
              min={1}
              max={20}
              value={sched.logrotate.keep}
              onChange={(e) => void patchSched({ logrotate: { ...sched.logrotate, keep: Number(e.target.value) } })}
              style={{ width: 60 }}
            />
            <span className="mini-label">份</span>
            <button
              className="btn sm"
              onClick={async () => {
                const res = await api.logrotateNow(server.id)
                toast(res.rotated ? `已归档（原日志 ${res.sizeMb}MB）` : `没到阈值，当前 ${res.sizeMb}MB`, 'info')
                setSched(await api.hostedSched(server.id))
              }}
            >
              立刻轮转
            </button>
          </div>

          <div className="row wrap" style={{ gap: 10, alignItems: 'center', marginTop: 12 }}>
            <label className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={sched.watchdog.enabled}
                onChange={(e) => void patchSched({ watchdog: { enabled: e.target.checked } })}
              />
              崩溃自动重启（看门狗）
            </label>
            <span className="mini-label">
              服务端异常退出后按 5 秒 / 15 秒 / 45 秒退避重试三次，还不行就停手并在日志里报原因，不会无限重启
            </span>
          </div>
        </div>
      )}

      {tab === 'addons' && (
        <div>
          <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
            <input
              placeholder={`搜${kind === 'plugin' ? '插件' : '模组'}（支持中文/英文关键词）`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void search()
              }}
              style={{ maxWidth: 320 }}
            />
            <button className="btn sm primary" disabled={searching} onClick={() => void search()}>
              {searching ? '搜索中…' : '搜索'}
            </button>
            {kind === 'plugin' && (
              <>
                <button className={`btn sm ${source === 'modrinth' ? 'on' : ''}`} onClick={() => setSource('modrinth')}>
                  Modrinth
                </button>
                <button className={`btn sm ${source === 'hangar' ? 'on' : ''}`} onClick={() => setSource('hangar')}>
                  Hangar
                </button>
              </>
            )}
            <span className="mini-label">只列适配 {server.mcVersion} 的版本</span>
          </div>

          {hits.length > 0 && (
            <div style={{ maxHeight: 220, overflow: 'auto', marginBottom: 10 }}>
              {hits.map((hit) => (
                <div
                  key={`${hit.source}:${hit.id}`}
                  className="row"
                  style={{ gap: 10, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--line, #2a2a2a)' }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>
                      {hit.title} <span className="mini-label">{hit.author ? `· ${hit.author}` : ''}</span>
                    </div>
                    <div className="mini-label" style={{ whiteSpace: 'normal' }}>
                      {hit.description.slice(0, 160)}
                    </div>
                  </div>
                  <button className="btn sm" disabled={busy === hit.id} onClick={() => void openVersions(hit)}>
                    {busy === hit.id ? '取版本…' : '选版本'}
                  </button>
                </div>
              ))}
            </div>
          )}

          {picked && (
            <div style={{ marginBottom: 10 }}>
              <div className="mini-label" style={{ marginBottom: 6 }}>
                {picked.hit.title} 的可用版本（新的在上面，点「安装」就下到 {kind === 'plugin' ? 'plugins/' : 'mods/'}）
              </div>
              <div style={{ maxHeight: 200, overflow: 'auto' }}>
                {picked.list.slice(0, 20).map((v) => (
                  <div key={`${v.fileUrl}:${v.version}`} className="row" style={{ gap: 8, alignItems: 'center', padding: '4px 0' }}>
                    <span style={{ minWidth: 140 }}>{v.version}</span>
                    <span className="mini-label" style={{ flex: 1 }}>
                      {v.gameVersions.slice(0, 3).join(', ')} {v.sizeBytes ? `· ${fmtBytes(v.sizeBytes)}` : ''}
                    </span>
                    <button
                      className="btn sm primary"
                      disabled={busy === v.fileUrl}
                      onClick={() => void install(picked.hit, v)}
                    >
                      {busy === v.fileUrl ? '安装中…' : '安装'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="mini-label" style={{ marginBottom: 6 }}>
            已装 {kind === 'plugin' ? '插件' : '模组'}（{installed.length}）
            {running ? ' · 运行中不能装/卸，先停服' : ''}
          </div>
          {installed.length === 0 && <div className="mini-label">还没装任何{kind === 'plugin' ? '插件' : '模组'}。</div>}
          {installed.map((item) => (
            <div key={item.fileName} className="row" style={{ gap: 8, alignItems: 'center', padding: '3px 0' }}>
              <span style={{ flex: 1 }}>{item.fileName}</span>
              <span className="mini-label">{fmtBytes(item.bytes)}</span>
              <button className="btn sm danger" disabled={running} onClick={() => void uninstall(item.fileName)}>
                卸载
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
