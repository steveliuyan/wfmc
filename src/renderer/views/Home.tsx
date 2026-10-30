import React, { useEffect, useRef, useState } from 'react'
import lottie from 'lottie-web'
import { api, friendlyError, formatDuration } from '../api'
import { useLauncher, useT } from '../store'
import symbolAnim from '../assets/lottie-symbol.json'
import type { PageId } from '../App'

const BLOCK_IDS = ['stats', 'quick', 'log']
const BLOCK_NAMES: Record<string, string> = { stats: '数据面板', quick: '快捷操作', log: '启动日志' }
const normalizeLayout = (v?: string[]) => {
  const kept = (v ?? []).filter((x) => BLOCK_IDS.includes(x))
  return [...kept, ...BLOCK_IDS.filter((x) => !kept.includes(x))]
}

export default function Home({ goto }: { goto: (p: PageId) => void }) {
  const {
    current,
    currentId,
    instances,
    setCurrentId,
    progress,
    logs,
    launchState,
    toast,
    clearLogs,
    settings,
    saveSettings,
    refreshInstances
  } = useLauncher()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const animRef = useRef<HTMLDivElement>(null)

  const state = currentId ? launchState[currentId] : undefined
  const lines = currentId ? logs[currentId] ?? [] : []
  // 折叠状态存本地：切页面回来 / 重开软件都还是上次的样子
  const [logCollapsed, setLogCollapsed] = useState(() => localStorage.getItem('logCollapsed') === '1')
  const toggleLog = () => {
    setLogCollapsed((v) => {
      const next = !v
      localStorage.setItem('logCollapsed', next ? '1' : '0')
      return next
    })
  }
  const activeProgress = Object.values(progress).filter((p) => p.total && !p.done)

  // ── 主页布局：下面三块卡片可以按住拖动换位置，顺序存进 settings.homeLayout ──
  const [layout, setLayout] = useState<string[]>(() => normalizeLayout(settings?.homeLayout))
  const layoutRef = useRef(layout)
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const pressTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  useEffect(() => {
    const next = normalizeLayout(settings?.homeLayout)
    setLayout((prev) => (next.join('|') === prev.join('|') ? prev : next))
  }, [settings?.homeLayout])

  useEffect(() => {
    if (!dragId) return
    const move = (e: PointerEvent) => {
      const cards = Array.from(gridRef.current?.querySelectorAll('[data-block]') ?? []) as HTMLElement[]
      const over = cards.find((c) => {
        const r = c.getBoundingClientRect()
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom
      })
      const overId = over?.dataset.block
      if (!overId || overId === dragId) return
      setLayout((prev) => {
        const from = prev.indexOf(dragId)
        const to = prev.indexOf(overId)
        if (from < 0 || to < 0 || from === to) return prev
        const next = [...prev]
        next.splice(from, 1)
        next.splice(to, 0, dragId)
        return next
      })
    }
    const up = () => {
      setDragId(null)
      saveSettings({ homeLayout: layoutRef.current }).catch(() => undefined)
      toast('布局已保存', 'success')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId])

  const beginPress = (id: string) => {
    if (!editing || dragId) return
    window.clearTimeout(pressTimer.current)
    pressTimer.current = window.setTimeout(() => setDragId(id), 160)
  }
  const endPress = () => {
    if (!dragId) window.clearTimeout(pressTimer.current)
  }

  useEffect(() => {
    if (!animRef.current) return
    const anim = lottie.loadAnimation({
      container: animRef.current,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: symbolAnim as unknown as object
    })
    return () => anim.destroy()
  }, [])

  useEffect(() => {
    if (currentId) api.isRunning(currentId).then(setRunning)
  }, [currentId, state?.state])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines.length])

  const launch = async () => {
    if (!currentId) return toast('先创建一个实例', 'error')
    setBusy(true)
    try {
      if (!current?.installed) {
        toast('首次启动，正在安装游戏文件…')
        await api.installGame(currentId)
      }
      await api.launchGame(currentId)
      setRunning(true)
    } catch (e) {
      toast(`启动失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const runTask = async (fn: () => Promise<unknown>, okMsg: string) => {
    if (!currentId) return
    setBusy(true)
    try {
      await fn()
      toast(okMsg, 'success')
      await refreshInstances()
    } catch (e) {
      toast(`操作失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const renderBlock = (id: string) => {
    if (id === 'stats') {
      const max = Math.max(...instances.map((x) => x.playTimeMs ?? 0), 1)
      return (
        <>
          <h3>数据面板</h3>
          <div className="stat-bars">
            {[...instances]
              .sort((a, b) => (b.playTimeMs ?? 0) - (a.playTimeMs ?? 0))
              .slice(0, 6)
              .map((i) => {
                const pct = Math.round(((i.playTimeMs ?? 0) / max) * 100)
                return (
                  <div className="stat-row" key={i.id}>
                    <span className="ellipsis" title={i.name}>
                      {i.name}
                      <span className="muted small"> · {i.mcVersion}</span>
                    </span>
                    <div className="stat-bar">
                      <i style={{ width: `${Math.max(pct, 2)}%` }} />
                    </div>
                    <span className="muted small">{formatDuration(i.playTimeMs ?? 0)}</span>
                  </div>
                )
              })}
            {instances.length === 0 && <div className="muted small">还没有实例，去「实例」页建一个。</div>}
          </div>
          <div className="muted small" style={{ marginTop: 10 }}>
            共 {instances.length} 个实例 · 总时长{' '}
            {formatDuration(instances.reduce((s, i) => s + (i.playTimeMs ?? 0), 0))} · 已装{' '}
            {instances.filter((i) => i.installed).length} 个
          </div>
        </>
      )
    }

    if (id === 'quick') {
      return (
        <>
          <h3>快捷操作</h3>
          <div className="quick">
            <button className="btn" onClick={() => goto('download')}>
              装原版 / 整合包
            </button>
            <button className="btn" onClick={() => goto('resources')}>
              装模组 / 光影
            </button>
            <button className="btn" onClick={() => goto('manage')}>
              管模组 / 存档 / 日志
            </button>
            <button className="btn" onClick={() => goto('instances')}>
              实例设置
            </button>
          </div>
          {instances.length > 1 && (
            <div style={{ marginTop: 16 }}>
              <div className="mini-label">切换实例</div>
              <div className="chips">
                {instances.map((i) => (
                  <button key={i.id} className={`chip ${i.id === currentId ? 'on' : ''}`} onClick={() => setCurrentId(i.id)}>
                    {i.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )
    }

    return (
      <>
        <div className="row-between" style={{ border: 'none', paddingBottom: 0 }}>
          <h3 style={{ margin: 0 }}>启动日志</h3>
          <div className="row">
            <button
              className={`btn sm ghost log-toggle ${logCollapsed ? 'is-collapsed' : ''}`}
              title={logCollapsed ? '展开日志' : '收起日志'}
              onClick={toggleLog}
            >
              <i className="chev">▾</i>
              {logCollapsed ? '展开' : '收起'}
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const p = await api.saveText(`wfmc-${currentId ?? 'log'}.log`, lines.join('\n'))
                if (p) toast(`已导出到 ${p}`, 'success')
              }}
            >
              导出
            </button>
            <button className="btn sm" onClick={() => currentId && clearLogs(currentId)}>
              清空
            </button>
          </div>
        </div>
        <div className={`log-wrap ${logCollapsed ? 'collapsed' : ''}`}>
          <pre className="log" ref={logRef}>
            {lines.length ? lines.join('\n') : '暂无日志。启动游戏后这里会显示实时输出。'}
          </pre>
        </div>
      </>
    )
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('首页', 'Home')}</h1>
          <p className="muted">选个实例，点启动。缺文件会自动下载。</p>
        </div>
        <div className="row">
          {editing && (
            <button
              className="btn ghost sm"
              onClick={() => {
                const def = [...BLOCK_IDS]
                setLayout(def)
                saveSettings({ homeLayout: def }).catch(() => undefined)
                toast('已恢复默认布局', 'info')
              }}
            >
              恢复默认
            </button>
          )}
          <button className={`btn sm ${editing ? 'primary' : ''}`} onClick={() => setEditing((v) => !v)}>
            {editing ? '完成' : '编辑布局'}
          </button>
        </div>
      </header>

      {editing && (
        <div className="layout-hint">
          <i>⠿</i> 按住下面的卡片拖动就能换位置，松手自动保存。上面那块大卡片固定不动。
        </div>
      )}

      {instances.length === 0 && (
        <div className="card empty">
          <h2>还没有任何实例</h2>
          <p className="muted">去「下载游戏」装一个原版或整合包，或者到「实例」里手动新建。</p>
          <button className="btn primary" onClick={() => goto('download')}>
            去下载游戏
          </button>
        </div>
      )}

      {current && (
        <div className="hero">
          <div className="hero-lottie" ref={animRef} />
          <div className="hero-left">
            <div className="hero-title">
              {current.name}
              <span className={`badge ${current.loader}`}>{current.loader}</span>
              {current.installed ? <span className="badge ok">已安装</span> : <span className="badge warn">未安装</span>}
            </div>
            <div className="hero-meta">
              游戏版本 <b>{current.mcVersion}</b>
              {current.loaderVersion && (
                <>
                  {' '}
                  · 加载器 <b>{current.loaderVersion}</b>
                </>
              )}
              {current.versionId && current.versionId !== current.mcVersion && (
                <>
                  {' '}
                  · 启动版本 <b>{current.versionId}</b>
                </>
              )}
            </div>
            <div className="hero-actions">
              {running ? (
                <button
                  className="btn danger lg"
                  onClick={async () => {
                    await api.killGame(current.id)
                    setRunning(false)
                  }}
                >
                  结束游戏
                </button>
              ) : (
                <button className="btn primary lg" disabled={busy} onClick={launch}>
                  {busy ? '处理中…' : '启动游戏'}
                </button>
              )}
              <button className="btn" disabled={busy} onClick={() => runTask(() => api.installGame(current.id), '安装完成')}>
                重新安装
              </button>
              <button className="btn" disabled={busy} onClick={() => runTask(() => api.repairGame(current.id), '文件校验完成')}>
                校验文件
              </button>
              <button className="btn ghost" onClick={() => api.openInstanceFolder(current.id)}>
                打开目录
              </button>
            </div>
            {state?.message && (
              <div className={`state-line ${state.state}`}>
                {state.state === 'running' ? '● ' : state.state === 'error' ? '✕ ' : '· '}
                {state.message}
              </div>
            )}
          </div>
          <div className="hero-right">
            <div className="stat">
              <span>累计游玩</span>
              <b>{formatDuration(current.playTimeMs)}</b>
            </div>
            <div className="stat">
              <span>最近启动</span>
              <b>{current.lastPlayed ? new Date(current.lastPlayed).toLocaleString() : '还没玩过'}</b>
            </div>
            <div className="stat">
              <span>内存设置</span>
              <b>{current.maxMemory ? `${current.maxMemory} MB` : '默认'}</b>
            </div>
          </div>
        </div>
      )}

      {activeProgress.length > 0 && (
        <div className="card">
          <h3>进行中</h3>
          {activeProgress.map((p, idx) => {
            const pct = p.total ? Math.min(100, Math.round(((p.current ?? 0) / p.total) * 100)) : 0
            return (
              <div className="progress-row" key={idx}>
                <div className="progress-label">
                  <span>{p.phase}</span>
                  <span className="muted">
                    {p.current ?? 0}/{p.total ?? 0}
                  </span>
                </div>
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}

      <div className={`grid-2 ${editing ? 'editing' : ''}`} ref={gridRef}>
        {layout.map((id) => (
          <div
            key={id}
            data-block={id}
            className={`card ${editing ? 'movable' : ''} ${dragId === id ? 'dragging' : ''}`}
            onPointerDown={() => beginPress(id)}
            onPointerUp={endPress}
            onPointerLeave={endPress}
          >
            {editing && <div className="drag-grip">⠿ {BLOCK_NAMES[id] ?? id} · 按住拖动</div>}
            {renderBlock(id)}
          </div>
        ))}
      </div>
    </div>
  )
}
