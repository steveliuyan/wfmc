import React, { useEffect, useRef, useState } from 'react'
import { api, friendlyError, type AccessEntry, type HostedServer } from '../api'
import Select from '../components/Select'
import type { PageId } from '../App'
import { useLauncher, useT } from '../store'

/** 版本列表在渲染层再缓存一层：来回切页面不重复请求 */
const vCache = {
  paper: undefined as { at: number; data: string[] } | undefined,
  loader: new Map<string, { at: number; data: string[] }>(),
  ttl: 10 * 60 * 1000
}

export default function Hosting({ goto }: { goto: (p: PageId) => void }) {
  const { toast, settings, askConfirm, instances } = useLauncher()
  const t = useT()
  const [servers, setServers] = useState<HostedServer[]>([])
  const [kind, setKind] = useState<'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge'>('paper')
  const [versions, setVersions] = useState<string[]>([])
  const [paperVersions, setPaperVersions] = useState<string[]>([])
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [loaderVersions, setLoaderVersions] = useState<string[]>([])
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [loaderVersion, setLoaderVersion] = useState('')
  const [mcVersion, setMcVersion] = useState('')
  const [name, setName] = useState('')
  const [memory, setMemory] = useState(2048)
  const [port, setPort] = useState(25565)
  const [creating, setCreating] = useState(false)
  const [mode, setMode] = useState<'blank' | 'instance'>('blank')
  const [fromInstanceId, setFromInstanceId] = useState<string>()
  const [modsCount, setModsCount] = useState<Record<string, number>>({})
  const [modPanel, setModPanel] = useState<string>()
  const [modImportFrom, setModImportFrom] = useState<string>()
  // 每个服务端只允许展开一个面板；按钮高亮 + ▾/▴ 表示当前是否展开
  const [panel, setPanel] = useState<Record<string, 'console' | 'props' | 'ops' | undefined>>({})
  const [stopping, setStopping] = useState<Record<string, boolean>>({})
  const [propsJson, setPropsJson] = useState<Record<string, string>>({})
  const [propsText, setPropsText] = useState('')
  const [showRaw, setShowRaw] = useState<Record<string, boolean>>({})

  const togglePanel = (id: string, kind: 'console' | 'props' | 'ops' | undefined) =>
    setPanel((prev) => ({ ...prev, [id]: prev[id] === kind ? undefined : kind }))
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [running, setRunning] = useState<Record<string, boolean>>({})
  const [command, setCommand] = useState('')
  const [whitelist, setWhitelist] = useState<AccessEntry[]>([])
  const [opList, setOpList] = useState<AccessEntry[]>([])
  const [newName, setNewName] = useState('')
  const [stats, setStats] = useState<Record<string, { players: string[]; tps?: number; done: boolean }>>({})
  const logRef = useRef<HTMLPreElement>(null)

  const refresh = async () => {
    const list = await api.listHosted()
    setServers(list)
    const states: Record<string, boolean> = {}
    for (const s of list) states[s.id] = (await api.hostedStatus(s.id)).running
    setRunning(states)
  }

  useEffect(() => {
    api.remoteVersions().then((list) => {
      const all = list.map((v) => v.id)
      setVersions(all)
      setMcVersion(all.find((v) => v.startsWith('1.20')) ?? all[0] ?? '')
    })
    if (vCache.paper && Date.now() - vCache.paper.at < vCache.ttl) {
      setPaperVersions(vCache.paper.data)
    } else {
      api.paperVersions().then((list) => {
        vCache.paper = { at: Date.now(), data: list }
        setPaperVersions(list)
      })
    }
    refresh()

    const offLog = api.onHostLog(({ id, line }) =>
      setLogs((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), line].slice(-800) }))
    )
    const offExit = api.onHostExit(({ id }) => {
      setRunning((prev) => ({ ...prev, [id]: false }))
      refresh()
    })
    return () => {
      offLog()
      offExit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs, panel])

  const versionOptions = kind === 'paper' ? paperVersions : versions

  // 换加载器 / 换 MC 版本时重新拉对应的加载器版本（带 10 分钟缓存，来回切页面不闪）
  useEffect(() => {
    if (kind === 'vanilla' || kind === 'paper' || !mcVersion) {
      setLoaderVersions([])
      setLoaderVersion('')
      setLoaderLoading(false)
      return
    }
    const key = `${kind}:${mcVersion}`
    const hit = vCache.loader.get(key)
    if (hit && Date.now() - hit.at < vCache.ttl) {
      setLoaderVersions(hit.data)
      setLoaderVersion((prev) => prev || hit.data[0] || '')
      setLoaderLoading(false)
      return
    }
    setLoaderLoading(true)
    api
      .loaderServerVersions(kind, mcVersion)
      .then((list) => {
        vCache.loader.set(key, { at: Date.now(), data: list })
        setLoaderVersions(list)
        setLoaderVersion((prev) => prev || list[0] || '')
      })
      .catch(() => setLoaderVersions([]))
      .finally(() => setLoaderLoading(false))
  }, [kind, mcVersion])

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('一键开服', 'Server Hosting')}</h1>
          <p className="muted">Vanilla / Paper 服务端一键下载、起停、发命令、改配置。开完去「联机」页把端口分享给好友。</p>
        </div>
        <button className="btn" onClick={refresh}>
          刷新
        </button>
      </header>

      <div className="hosting-banner">
        <span>
          这里是<strong>开服务端</strong>（独立进程常驻，关掉窗口也会缩到托盘继续跑）；
          如果你只是想临时开个房间和朋友玩<span className="muted">（你在游戏里开局域网，退出就没）</span>，去「联机」页。
        </span>
        <button className="btn sm" onClick={() => goto('online')}>
          去「联机」开房间
        </button>
      </div>

      <div className="card">
        <h3>新建服务端</h3>
        <div className="row wrap" style={{ marginBottom: 10 }}>
          <span className="muted small">怎么建：</span>
          <button
            className={`chip ${mode === 'blank' ? 'on' : ''}`}
            onClick={() => setMode('blank')}
          >
            开个空白新服
          </button>
          <button
            className={`chip ${mode === 'instance' ? 'on' : ''}`}
            onClick={() => setMode('instance')}
          >
            照现有实例开（带 mod）
          </button>
        </div>
        {mode === 'instance' && (
          <div className="card inner" style={{ marginBottom: 12 }}>
            <div className="mini-label">选一个实例，按它的版本 / 加载器开服，并把 mods 与 config 一起搬过去</div>
            <Select
              value={fromInstanceId ?? ''}
              width="100%"
              placeholder="选择实例"
              options={instances.map((i) => ({
                value: i.id,
                label: i.name,
                hint: `${i.mcVersion} · ${i.loader}`
              }))}
              onChange={setFromInstanceId}
            />
            <p className="muted small" style={{ marginTop: 8 }}>
              Fabric / Forge / NeoForge 实例会开对应加载器的服务端；原版实例会开原版服（mod 装不进去，需要插件就选 Paper）。
              Quilt 实例按 Fabric 服务端处理。
            </p>
          </div>
        )}
        <div className="form-grid">
          <label style={{ display: mode === 'instance' ? 'none' : undefined }}>
            服务端类型
            <Select
              value={kind}
              width="100%"
              options={[
                { value: 'paper', label: 'Paper（推荐，性能好、插件生态）' },
                { value: 'vanilla', label: 'Vanilla（官方原版）' },
                { value: 'fabric', label: 'Fabric（轻量模组）' },
                { value: 'forge', label: 'Forge（模组老牌）' },
                { value: 'neoforge', label: 'NeoForge（新 Forge）' }
              ]}
              onChange={(k) => {
                setKind(k as typeof kind)
                const list = k === 'paper' ? paperVersions : versions
                setMcVersion(list[0] ?? '')
              }}
            />
          </label>
          <label style={{ display: mode === 'instance' ? 'none' : undefined }}>
            游戏版本
            <Select
              value={mcVersion}
              width="100%"
              placeholder="选择版本"
              loading={versionOptions.length === 0}
              loadingText="正在拉版本列表…"
              options={versionOptions.map((v) => ({ value: v, label: v }))}
              onChange={setMcVersion}
            />
          </label>
          {loaderVersions.length > 0 && (
          <label style={{ display: mode === 'instance' ? 'none' : undefined }}>
              {kind} 版本
              <Select
                value={loaderVersion}
                width="100%"
                loading={loaderLoading}
              loadingText="正在拉版本列表…"
              options={loaderVersions.map((v) => ({ value: v, label: v }))}
                onChange={setLoaderVersion}
              />
            </label>
          )}
          <label>
            名称
            <input value={name} placeholder="例如 朋友服" onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            内存 (MB)
            <input type="number" value={memory} onChange={(e) => setMemory(Number(e.target.value) || 2048)} />
          </label>
          <label>
            端口
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 25565)} />
          </label>
        </div>
        <div className="row">
          <button
            className="btn primary"
            disabled={creating || !mcVersion}
            onClick={async () => {
              setCreating(true)
              try {
                await api.createHosted({
                  name,
                  kind,
                  mcVersion,
                  memoryMb: memory,
                  port,
                  loaderVersion: loaderVersion || undefined
                })
                await refresh()
                toast('服务端已创建，记得先同意 EULA 再启动', 'success')
              } catch (e) {
                toast(`创建失败：${friendlyError(e)}`, 'error')
              } finally {
                setCreating(false)
              }
            }}
          >
            {creating ? '下载服务端中…' : '创建并下载'}
          </button>
          <span className="muted small">
            默认 {settings?.downloadSource === 'mirror' ? 'BMCLAPI 镜像' : '官方源'}；Paper 走 PaperMC API。
          </span>
        </div>
      </div>

      <div className="cards">
        {servers.length === 0 && <div className="card empty">还没有服务端。上面选个版本点「创建并下载」。</div>}
        {servers.map((s) => (
          <div className="card" key={s.id}>
            <div className="instance-head">
              <h3>{s.name}</h3>
              <span className={`badge ${running[s.id] ? 'ok' : ''}`}>{running[s.id] ? '运行中' : '已停止'}</span>
            </div>
            <div className="muted small">
              {s.kind} {s.mcVersion}
              {s.build ? ` build ${s.build}` : ''} · {s.memoryMb}MB · 端口 {s.port}
              {s.eulaAccepted ? ' · EULA 已同意' : ' · 未同意 EULA'}
            </div>
            <div className="row wrap" style={{ marginTop: 10 }}>
              {!s.eulaAccepted && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.acceptEula(s.id)
                    await refresh()
                    toast('已同意 EULA（Minecraft EULA 由你与 Mojang 之间成立）', 'success')
                  }}
                >
                  同意 EULA
                </button>
              )}
              <button
                className="btn sm primary"
                disabled={running[s.id] || !s.eulaAccepted}
                onClick={async () => {
                  try {
                    await api.startHosted(s.id)
                    setRunning((prev) => ({ ...prev, [s.id]: true }))
                    setPanel((prev) => ({ ...prev, [s.id]: 'console' }))
                    if (s.kind === 'fabric' || s.kind === 'forge' || s.kind === 'neoforge') {
                      const m = await api.hostedManifest(s.id).catch(() => undefined)
                      if (m?.port) {
                        toast(
                          `模组清单已开在 ${m.port} 端口：好友用 WFMC 进服前会自动检查并补 mod（本机可访问 http://127.0.0.1:${m.port}/manifest.json）`,
                          'success'
                        )
                      }
                    }
                  } catch (e) {
                    toast(`启动失败：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                启动
              </button>
              <button
                className="btn sm"
                disabled={!running[s.id] || !!stopping[s.id]}
                onClick={async () => {
                  const res = await api.stopHosted(s.id)
                  setStopping((p) => ({ ...p, [s.id]: true }))
                  toast(res.message, 'info')
                }}
              >
                {stopping[s.id] ? '正在保存…' : '停止'}
              </button>
              {stopping[s.id] && (
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    await api.killHosted(s.id)
                    toast('已强制结束（上次自动保存之后的进度可能丢）', 'error')
                  }}
                >
                  强制结束
                </button>
              )}
              <button
                className={`btn sm ${panel[s.id] === 'console' ? 'on' : ''}`}
                onClick={() => togglePanel(s.id, 'console')}
              >
                控制台 {panel[s.id] === 'console' ? '▴' : '▾'}
              </button>
              <button
                className={`btn sm ${panel[s.id] === 'props' ? 'on' : ''}`}
                onClick={async () => {
                  const opening = panel[s.id] !== 'props'
                  togglePanel(s.id, 'props')
                  if (opening) {
                    setPropsText(await api.hostedProps(s.id))
                    setPropsJson(await api.hostedPropsJson(s.id))
                  }
                }}
              >
                服务器设置 {panel[s.id] === 'props' ? '▴' : '▾'}
              </button>
              <button
                className={`btn sm ${panel[s.id] === 'ops' ? 'on' : ''}`}
                onClick={async () => {
                  const opening = panel[s.id] !== 'ops'
                  togglePanel(s.id, 'ops')
                  if (opening) {
                    const [wl, ops] = await Promise.all([
                      api.accessList(s.id, 'whitelist'),
                      api.accessList(s.id, 'ops')
                    ])
                    setWhitelist(wl)
                    setOpList(ops)
                  }
                }}
              >
                玩家管理 {panel[s.id] === 'ops' ? '▴' : '▾'}
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    const file = await api.backupHosted(s.id)
                    toast(`已备份：${file}`, 'success')
                  } catch (e) {
                    toast(`备份失败：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                备份世界
              </button>
              {(s.kind === 'fabric' || s.kind === 'forge' || s.kind === 'neoforge') && (
                <button
                  className={`btn sm ${modPanel === s.id ? 'on' : ''}`}
                  onClick={async () => {
                    const opening = modPanel !== s.id
                    setModPanel(opening ? s.id : undefined)
                    const count = await api.hostedModsCount(s.id)
                    setModsCount((p) => ({ ...p, [s.id]: count }))
                  }}
                >
                  模组 {modsCount[s.id] ? `(${modsCount[s.id]})` : ''} {modPanel === s.id ? '▴' : '▾'}
                </button>
              )}
              <button className="btn sm" onClick={() => api.openHostedDir(s.id)}>
                目录
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (!(await askConfirm({ title: '删除服务端', message: `「${s.name}」的存档会一起删掉，确定？`, okText: '删除', danger: true }))) return
                  await api.deleteHosted(s.id)
                  await refresh()
                }}
              >
                删除
              </button>
            </div>

            {panel[s.id] === 'console' && (
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="mini-label">常用操作（点一下就执行，不用记命令）</div>
                <div className="row wrap" style={{ marginBottom: 8 }}>
                  {[
                    ['看谁在线', 'list'],
                    ['保存世界', 'save-all'],
                    ['切成白天', 'time set day'],
                    ['天气放晴', 'weather clear'],
                    ['重载白名单', 'whitelist reload'],
                    ['保存并关服', 'stop']
                  ].map(([label, cmd]) => (
                    <button
                      key={cmd}
                      className="btn sm"
                      disabled={!running[s.id]}
                      onClick={async () => {
                        await api.hostedCommand(s.id, cmd)
                        toast(`已发送「${label}」`, 'success')
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <pre className="log" ref={logRef}>
                  {(logs[s.id] ?? ['点「启动」之后，服务器说的话会显示在这里']).join('\n')}
                </pre>
                <div className="row" style={{ marginTop: 8 }}>
                  <input
                    className="grow"
                    placeholder="也可以直接打字，比如 say 大家好、op 玩家名"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key !== 'Enter' || !command.trim()) return
                      await api.hostedCommand(s.id, command)
                      setCommand('')
                    }}
                  />
                  <button
                    className="btn"
                    onClick={async () => {
                      if (!command.trim()) return
                      await api.hostedCommand(s.id, command)
                      setCommand('')
                    }}
                  >
                    发送
                  </button>
                </div>
                <p className="muted small">这里是直接对服务器说话；不确定就先点上面的常用按钮，乱敲可能改坏东西。</p>
              </div>
            )}


            {panel[s.id] === 'ops' && (
              <div style={{ marginTop: 12 }}>
                <div className="mini-label">白名单（whitelist.json）</div>
                <div className="row wrap">
                  <input
                    placeholder="玩家名字"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    style={{ width: 200 }}
                  />
                  <button
                    className="btn sm"
                    onClick={async () => {
                      if (!newName.trim()) return
                      setWhitelist(await api.addAccess(s.id, 'whitelist', newName.trim()))
                      setNewName('')
                      toast('已加入白名单（记得在 server.properties 里开 white-list=true）', 'success')
                    }}
                  >
                    加白名单
                  </button>
                </div>
                <div className="chips" style={{ marginTop: 6 }}>
                  {whitelist.length === 0 && <span className="muted small">还没有白名单条目</span>}
                  {whitelist.map((w) => (
                    <span className="chip on" key={w.name}>
                      {w.name}
                      <button
                        className="chip-x"
                        onClick={async () => setWhitelist(await api.removeAccess(s.id, 'whitelist', w.name))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>

                <div className="mini-label" style={{ marginTop: 10 }}>管理员（ops.json，等级 4）</div>
                <div className="chips">
                  {opList.length === 0 && <span className="muted small">还没有 OP</span>}
                  {opList.map((o) => (
                    <span className="chip on" key={o.name}>
                      {o.name}
                      <button className="chip-x" onClick={async () => setOpList(await api.removeAccess(s.id, 'ops', o.name))}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <div className="row wrap" style={{ marginTop: 6 }}>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      if (!newName.trim()) return toast('先在上面填名字', 'error')
                      setOpList(await api.addAccess(s.id, 'ops', newName.trim()))
                      setNewName('')
                      toast('已设为 OP（重启服务端或 /reload 生效）', 'success')
                    }}
                  >
                    把上面的名字设为 OP
                  </button>
                  <button
                    className="btn sm"
                    disabled={!running[s.id]}
                    onClick={async () => {
                      await api.hostedCommand(s.id, 'whitelist reload')
                      toast('已通知服务端重载白名单', 'success')
                    }}
                  >
                    让服务端重载 whitelist
                  </button>
                </div>
              </div>
            )}

            {running[s.id] && (
              <div className="muted small" style={{ marginTop: 8 }}>
                在线玩家：
                {(stats[s.id]?.players.length ?? 0) === 0 ? '无' : stats[s.id]!.players.join('、')}
                {stats[s.id]?.tps ? ` · TPS ${stats[s.id]!.tps}` : ''}
                {' · '}
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.hostedCommand(s.id, 'list')
                    await new Promise((r) => setTimeout(r, 700))
                    const fresh = await api.hostedStats(s.id)
                    setStats((prev) => ({ ...prev, [s.id]: fresh }))
                  }}
                >
                  刷新玩家列表
                </button>
              </div>
            )}

            {modPanel === s.id && (
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="mini-label">服务端 mods 目录里有 {modsCount[s.id] ?? 0} 个 mod</div>
                <div className="row wrap">
                  <Select
                    value={modImportFrom ?? ''}
                    width={260}
                    placeholder="从哪个实例搬 mods"
                    options={instances.map((i) => ({ value: i.id, label: i.name, hint: i.mcVersion }))}
                    onChange={setModImportFrom}
                  />
                  <button
                    className="btn sm primary"
                    disabled={!modImportFrom}
                    onClick={async () => {
                      if (!modImportFrom) return
                      try {
                        const r = await api.importServerMods(s.id, { instanceId: modImportFrom })
                        setModsCount((p) => ({ ...p, [s.id]: r.total }))
                        toast(`已搬入 ${r.mods} 个 mod、${r.configs} 个配置`, 'success')
                      } catch (e) {
                        toast(`导入失败：${friendlyError(e)}`, 'error')
                      }
                    }}
                  >
                    从实例导入
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const file = await api.pickFile()
                      if (!file) return
                      try {
                        toast('正在从整合包提取 mod…')
                        const r = await api.importServerMods(s.id, { packFile: file })
                        setModsCount((p) => ({ ...p, [s.id]: r.total }))
                        toast(`已导入 ${r.mods} 个 mod`, 'success')
                      } catch (e) {
                        toast(`导入失败：${friendlyError(e)}`, 'error')
                      }
                    }}
                  >
                    从整合包文件导入
                  </button>
                </div>
                <p className="muted small">
                  服务端 mod 必须和客户端**完全一致**（同版本、同加载器），否则朋友进不来。
                  支持 .mrpack 和带 mods/ 目录的整合包 zip；原版/Paper 服务端只能装插件，装不了 mod。
                </p>
              </div>
            )}

            {panel[s.id] === 'props' && (
              <div className="panel" style={{ marginTop: 12 }}>
                <div className="mini-label">服务器设置（改完点保存，重启服务端生效）</div>
                <div className="prop-form">
                  <label className="prop-item">
                    <span className="prop-name">服务器标语</span>
                    <input
                      value={propsJson['motd'] ?? ''}
                      placeholder="显示在玩家服务器列表里的那句话"
                      onChange={(e) => setPropsJson({ ...propsJson, motd: e.target.value })}
                    />
                    <span className="prop-hint">玩家在多人游戏列表里看到的那一行字</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">端口</span>
                    <input
                      type="number"
                      value={propsJson['server-port'] ?? '25565'}
                      onChange={(e) => setPropsJson({ ...propsJson, 'server-port': e.target.value })}
                    />
                    <span className="prop-hint">默认 25565；改完记得去「联机」页分享新端口</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">最多玩家</span>
                    <input
                      type="number"
                      value={propsJson['max-players'] ?? '20'}
                      onChange={(e) => setPropsJson({ ...propsJson, 'max-players': e.target.value })}
                    />
                    <span className="prop-hint">同时在线的上限</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">正版验证</span>
                    <Select
                      value={propsJson['online-mode'] ?? 'true'}
                      width="100%"
                      options={[
                        { value: 'true', label: '开（只让正版账号进）' },
                        { value: 'false', label: '关（离线玩家也能进）' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, 'online-mode': v })}
                    />
                    <span className="prop-hint">开 = 必须是有正版账号的人；关 = 一起玩的朋友没正版也能进</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">白名单模式</span>
                    <Select
                      value={propsJson['white-list'] ?? 'false'}
                      width="100%"
                      options={[
                        { value: 'false', label: '关（谁都能进）' },
                        { value: 'true', label: '开（只有白名单能进）' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, 'white-list': v })}
                    />
                    <span className="prop-hint">开了之后用「玩家管理」把朋友名字加进白名单</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">难度</span>
                    <Select
                      value={propsJson['difficulty'] ?? 'easy'}
                      width="100%"
                      options={[
                        { value: 'peaceful', label: '和平（没怪物）' },
                        { value: 'easy', label: '简单' },
                        { value: 'normal', label: '普通' },
                        { value: 'hard', label: '困难' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, difficulty: v })}
                    />
                    <span className="prop-hint">怪物的强度与饥饿消耗</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">默认游戏模式</span>
                    <Select
                      value={propsJson['gamemode'] ?? 'survival'}
                      width="100%"
                      options={[
                        { value: 'survival', label: '生存' },
                        { value: 'creative', label: '创造' },
                        { value: 'adventure', label: '冒险' },
                        { value: 'spectator', label: '旁观' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, gamemode: v })}
                    />
                    <span className="prop-hint">新玩家进来时的默认模式</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">玩家互殴（PVP）</span>
                    <Select
                      value={propsJson['pvp'] ?? 'true'}
                      width="100%"
                      options={[
                        { value: 'true', label: '允许' },
                        { value: 'false', label: '禁止' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, pvp: v })}
                    />
                    <span className="prop-hint">关掉之后朋友之间打不掉血</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">视距</span>
                    <input
                      type="number"
                      min={4}
                      max={32}
                      value={propsJson['view-distance'] ?? '8'}
                      onChange={(e) => setPropsJson({ ...propsJson, 'view-distance': e.target.value })}
                    />
                    <span className="prop-hint">越大看得越远，也越吃配置与带宽（建议 6–10）</span>
                  </label>

                  <label className="prop-item">
                    <span className="prop-name">允许飞行</span>
                    <Select
                      value={propsJson['allow-flight'] ?? 'false'}
                      width="100%"
                      options={[
                        { value: 'false', label: '禁止（防作弊）' },
                        { value: 'true', label: '允许' }
                      ]}
                      onChange={(v) => setPropsJson({ ...propsJson, 'allow-flight': v })}
                    />
                    <span className="prop-hint">装了飞行类模组时要开，否则会被踢</span>
                  </label>
                </div>

                <div className="row wrap" style={{ marginTop: 12 }}>
                  <button
                    className="btn primary sm"
                    onClick={async () => {
                      try {
                        setPropsJson(await api.patchHostedProps(s.id, propsJson))
                        toast('设置已保存，重启服务端后生效', 'success')
                      } catch (e) {
                        toast(`保存失败：${friendlyError(e)}`, 'error')
                      }
                    }}
                  >
                    保存设置
                  </button>
                  <button className="btn sm" onClick={() => togglePanel(s.id, undefined)}>
                    收起
                  </button>
                  <button className="btn sm ghost" onClick={() => setShowRaw((p) => ({ ...p, [s.id]: !p[s.id] }))}>
                    {showRaw[s.id] ? '收起高级编辑' : '高级：直接改原始文件'}
                  </button>
                </div>

                {showRaw[s.id] && (
                  <div style={{ marginTop: 10 }}>
                    <p className="muted small">
                      下面是 server.properties 原文。不懂的键别看，改错会导致开不了服；只有你清楚含义时再动。
                    </p>
                    <textarea
                      className="props-editor"
                      value={propsText}
                      onChange={(e) => setPropsText(e.target.value)}
                      rows={10}
                    />
                    <div className="row" style={{ marginTop: 8 }}>
                      <button
                        className="btn primary sm"
                        onClick={async () => {
                          await api.setHostedProps(s.id, propsText)
                          setPropsJson(await api.hostedPropsJson(s.id))
                          toast('原始配置已保存', 'success')
                        }}
                      >
                        保存原文
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
