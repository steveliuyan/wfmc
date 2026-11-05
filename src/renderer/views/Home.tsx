import React, { useEffect, useRef, useState } from 'react'
import lottie from 'lottie-web'
import { api, friendlyError, formatDuration, formatLastPlayed, formatSize, progressPercent, progressText } from '../api'
import { useLauncher, useT } from '../store'
import symbolAnim from '../assets/lottie-symbol.json'
import type { PageId } from '../App'

// 默认落位：左边数据面板、右边启动日志（两块并排等高），快捷操作整行放下面
const BLOCK_IDS = ['stats', 'log', 'quick']
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
    refreshInstances,
    refreshAccounts,
    accounts,
    askConfirm,
    dataDir,
    runningTask
  } = useLauncher()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  // 数据目录占多大（主进程带缓存，最多走 2.5 秒盘）
  const [dataSize, setDataSize] = useState<{ bytes: number; partial: boolean } | null>(null)
  // 数据目录体检结果：insideInstall = 放在安装目录里了（更新会把它清空）
  const [dataHealth, setDataHealth] = useState<{ installDir: string; insideInstall: boolean } | null>(null)
  const [dataBusy, setDataBusy] = useState(false)
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
  // 一个操作没跑完，别的按钮一律锁住（不然校验还没完就能点启动，两个任务抢同一批文件）
  const locked = busy || !!runningTask
  const workingText = busy
    ? '处理中…'
    : runningTask?.title?.includes('校验')
      ? '校验中…'
      : runningTask
        ? '有任务在跑…'
        : ''

  // ── 主页布局：三块卡片可以按住拖起来，像手机桌面那样浮在空中换位置 ──
  const [layout, setLayout] = useState<string[]>(() => normalizeLayout(settings?.homeLayout))
  const layoutRef = useRef(layout)
  const [editing, setEditing] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null)
  const [ghost, setGhost] = useState({ w: 0, h: 0 })
  const dragOffset = useRef({ x: 0, y: 0 })
  const gridRef = useRef<HTMLDivElement>(null)
  const pressTimer = useRef<number | undefined>(undefined)
  const rafRef = useRef(0)
  const prevRects = useRef<Map<string, DOMRect> | null>(null)
  const lastSwap = useRef(0)
  // 便携版看不到实例时，用它把「便携版目录 vs 本机安装版目录」讲清楚
  const [sharedInfo, setSharedInfo] = useState<Awaited<ReturnType<typeof api.dataSharedInfo>> | undefined>()
  useEffect(() => {
    if (instances.length > 0) return
    api
      .dataSharedInfo()
      .then(setSharedInfo)
      .catch(() => undefined)
  }, [instances.length])

  // 更新/换版本之后，启动时可能自动接上了旧数据 —— 说一句，免得玩家以为「数据没了」
  useEffect(() => {
    api
      .adoptInfo()
      .then((info) => {
        if (!info) return
        const where = info.to.length > 42 ? `…${info.to.slice(-40)}` : info.to
        const acc = info.accounts > 0 ? `，${info.accounts} 个账号也一起找回来了` : ''
        toast(`接着用之前的数据了：${where}${acc}`, 'success')
        refreshInstances()
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  // 数据目录占多大：显示在「本机」那一块，换了目录/清完数据要重算
  const refreshDataSize = () => {
    api
      .dataSize()
      .then((r) => setDataSize({ bytes: r.bytes, partial: r.partial }))
      .catch(() => setDataSize(null))
    // 顺手体检一次：数据目录要是落在安装目录里，更新安装包会把整份数据带走，必须红字提示
    api
      .dataHealth()
      .then((h) => setDataHealth({ installDir: h.installDir, insideInstall: h.insideInstall }))
      .catch(() => setDataHealth(null))
  }
  useEffect(() => {
    refreshDataSize()
  }, [settings?.dataDir])

  // 数据面板里的「换目录 / 清空账号」：不用跑设置页也能就地改
  const pickDataDir = async () => {
    const dir = await api.pickFolder()
    if (!dir) return
    setDataBusy(true)
    try {
      const r = await api.setDataDir(dir)
      await saveSettings({})
      await Promise.all([refreshInstances(), refreshAccounts()])
      refreshDataSize()
      toast(`数据目录已换成 ${r.dir}（那边有 ${r.instances} 个实例）`, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setDataBusy(false)
    }
  }

  const clearAccounts = async () => {
    const ok = await askConfirm({
      title: '清空账号',
      message: `会把当前数据目录里的 ${accounts.length} 个账号（离线 / 正版 / 外置）全部删掉；实例、存档、模组一个都不动，删之前还会留一份 accounts.json.bak。`,
      okText: '清空账号',
      danger: true
    })
    if (!ok) return
    setDataBusy(true)
    try {
      const r = await api.clearData('accounts')
      await Promise.all([refreshAccounts(), saveSettings({})])
      refreshDataSize()
      toast(`已清空 ${r.cleared} 个账号（备份在 accounts.json.bak）`, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setDataBusy(false)
    }
  }

  useEffect(() => {
    const next = normalizeLayout(settings?.homeLayout)
    setLayout((prev) => (next.join('|') === prev.join('|') ? prev : next))
  }, [settings?.homeLayout])

  /** 记录当前每个格子在哪，重排之后按差值补间（FLIP），卡片才会「滑」过去而不是瞬移 */
  const snapshot = () => {
    const m = new Map<string, DOMRect>()
    gridRef.current?.querySelectorAll('[data-slot]').forEach((el) => {
      const node = el as HTMLElement
      const id = node.dataset.slot
      if (id) m.set(id, node.getBoundingClientRect())
    })
    return m
  }

  useEffect(() => {
    if (!dragId) return
    const move = (e: PointerEvent) => {
      const nx = e.clientX - dragOffset.current.x
      const ny = e.clientY - dragOffset.current.y
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => setDragPos({ x: nx, y: ny }))

      const slots = Array.from(gridRef.current?.querySelectorAll('[data-slot]') ?? []) as HTMLElement[]
      // 命中判定要「进得够深」：只看指针是否落在矩形里的话，卡片贴边时会两块同时命中，
      // 加上换位后又立刻命中回来，就变成两格来回闪。所以要求指针进到格子中间 56% 的区域。
      const over = slots.find((c) => {
        if (c.dataset.slot === dragId) return false
        const r = c.getBoundingClientRect()
        const ix = r.width * 0.22
        const iy = r.height * 0.22
        return e.clientX >= r.left + ix && e.clientX <= r.right - ix && e.clientY >= r.top + iy && e.clientY <= r.bottom - iy
      })
      const overId = over?.dataset.slot
      // 刚换过位就歇 260ms，别让指针在缝上抽一下又换回去（这就是「快速闪烁」的来源）
      if (!overId || Date.now() - lastSwap.current < 260) return
      setLayout((prev) => {
        const from = prev.indexOf(dragId)
        const to = prev.indexOf(overId)
        if (from < 0 || to < 0 || from === to) return prev
        prevRects.current = snapshot()
        // 两块**对调**（不是把拖的那块插进去、其它整体挪一格）：
        // 大卡和小卡互换位置时，这样才符合「我拖到哪、它就来这、原来那个去我那」的直觉
        const next = [...prev]
        next[from] = overId
        next[to] = dragId
        lastSwap.current = Date.now()
        return next
      })
    }
    const up = () => {
      cancelAnimationFrame(rafRef.current)
      setDragId(null)
      setDragPos(null)
      saveSettings({ homeLayout: layoutRef.current }).catch(() => undefined)
      toast('布局已保存', 'success')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragId])

  // 让位动画：被挤走的卡片从旧位置滑到新位置
  useEffect(() => {
    const prev = prevRects.current
    if (!prev) return
    prevRects.current = null
    gridRef.current?.querySelectorAll('[data-slot]').forEach((el) => {
      const node = el as HTMLElement
      const id = node.dataset.slot
      if (!id) return
      const before = prev.get(id)
      if (!before) return
      const after = node.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      node.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        { duration: 260, easing: 'cubic-bezier(.22, .9, .24, 1)' }
      )
    })
  }, [layout])

  const beginPress = (e: React.PointerEvent, id: string) => {
    if (!editing || dragId) return
    if (e.button !== 0) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dragOffset.current = { x: e.clientX - r.left, y: e.clientY - r.top }
    const size = { w: r.width, h: r.height }
    window.clearTimeout(pressTimer.current)
    // 按住 140ms 才算「拿起」，短按还是正常的点击
    pressTimer.current = window.setTimeout(() => {
      setGhost(size)
      setDragPos({ x: e.clientX - dragOffset.current.x, y: e.clientY - dragOffset.current.y })
      setDragId(id)
    }, 140)
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
      const totalMs = instances.reduce((s, i) => s + (i.playTimeMs ?? 0), 0)
      const installedCount = instances.filter((i) => i.installed).length
      const latest = [...instances].filter((i) => i.lastPlayed).sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0]
      return (
        <>
          <h3>数据面板</h3>
          {/* 顶上三个小格子：先把「玩了多少」讲清楚，下面的条形图才不会孤零零挂在中间 */}
          <div className="stat-tiles">
            <div>
              <b>{instances.length}</b>
              <span>个实例</span>
            </div>
            <div>
              <b title={totalMs ? formatDuration(totalMs) : undefined}>{formatDuration(totalMs)}</b>
              <span>累计游玩</span>
            </div>
            <div>
              <b>
                {installedCount}/{instances.length}
              </b>
              <span>已装好</span>
            </div>
          </div>
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
          {/* 实例少的时候中间会空一截，用本机信息填住（顺便让人一眼看到数据存在哪） */}
          <div className="stat-extra">
            <div className="mini-label">本机</div>
            <div className="kv">
              <span>数据目录</span>
              <b className="ellipsis" title={settings?.dataDir}>
                {settings?.dataDir ? `…\\${settings.dataDir.split(/[\\/]/).filter(Boolean).slice(-2).join('\\')}` : '—'}
              </b>
            </div>
            {dataHealth?.insideInstall && (
              <div className="muted small warn-text">
                ⚠ 数据目录在安装目录（{dataHealth.installDir}）里，更新安装包会把它清空 —— 点「换目录」挪出去
              </div>
            )}
            <div className="kv">
              <span>默认内存</span>
              <b>{settings?.maxMemory ? `${settings.maxMemory} MB` : '默认'}</b>
            </div>
            <div className="kv">
              <span>Java</span>
              <b className="ellipsis" title={settings?.javaPath || '自动选择'}>
                {settings?.javaPath ? settings.javaPath.split(/[\\/]/).filter(Boolean).pop() : '自动选择'}
              </b>
            </div>
            <div className="kv">
              <span>占用</span>
              <b>
                {dataSize
                  ? `${formatSize(dataSize.bytes)}${dataSize.partial ? ' +' : ''}`
                  : '统计中…'}
              </b>
            </div>
            <div className="stat-actions">
              <button className="btn ghost sm" disabled={dataBusy} onClick={pickDataDir} title="换一个数据目录（只换指向，不复制不删文件）">
                换目录
              </button>
              <button
                className="btn ghost sm danger"
                disabled={dataBusy || accounts.length === 0}
                onClick={clearAccounts}
                title="清空账号列表，实例和存档不动"
              >
                清空账号{accounts.length ? `（${accounts.length}）` : ''}
              </button>
            </div>
          </div>
          <div className="stat-foot muted small">
            {latest
              ? `最近启动：${latest.name} · ${formatLastPlayed(latest.lastPlayed ?? 0)}`
              : '还没启动过游戏，先装一个实例吧。'}
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
                prevRects.current = snapshot()
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
          <i>⠿</i> 按住卡片把它「拿起来」，其它卡片会自动让位，松手就放到那儿并保存。上面那块大卡片固定不动。
        </div>
      )}

      {instances.length === 0 && (
        <div className="card empty">
          <h2>还没有任何实例</h2>
          {sharedInfo && sharedInfo.portable && sharedInfo.sharedInstances > 0 && !sharedInfo.usingShared ? (
            <>
              <p className="muted">
                你现在开的是<b>便携版</b>，它的数据放在 exe 旁边的{' '}
                <code className="small">{sharedInfo.ownDir}</code> 里，所以这里是空的。
                <br />
                但这台电脑上已经有一份数据：<b>{sharedInfo.sharedInstances}</b> 个实例，
                约 <b>{Math.max(1, Math.round(sharedInfo.sharedBytes / 1024 / 1024))} MB</b>（
                <code className="small">{sharedInfo.sharedDir}</code>）。要用哪一份？
              </p>
              <div className="row wrap">
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      const r = await api.useSharedData(true)
                      toast(`已切到本机数据：${r.instances} 个实例、${r.accounts} 个账号`, 'success')
                      await refreshInstances()
                      setSharedInfo(await api.dataSharedInfo().catch(() => undefined))
                    } catch (e) {
                      toast(`切换失败：${friendlyError(e)}`, 'error')
                    }
                  }}
                >
                  用本机这份数据（推荐，不占额外空间）
                </button>
                <button className="btn" onClick={() => goto('download')}>
                  就用便携版自己的目录，去下载游戏
                </button>
              </div>
              <p className="muted small">
                切换只是改「指向哪个目录」，不会复制也不会删文件；以后想改回来，到「设置 → 数据目录」里换回去就行。
              </p>
            </>
          ) : sharedInfo?.usingShared ? (
            <>
              <p className="muted">
                便携版现在用的是本机那份数据（<code className="small">{sharedInfo.currentDir}</code>），但里面也没有实例。
              </p>
              <button className="btn primary" onClick={() => goto('download')}>
                去下载游戏
              </button>
            </>
          ) : (
            <>
              <p className="muted">去「下载游戏」装一个原版或整合包，或者到「实例」里手动新建。</p>
              <button className="btn primary" onClick={() => goto('download')}>
                去下载游戏
              </button>
            </>
          )}
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
                <button className="btn primary lg" disabled={locked} onClick={launch}>
                  {locked ? workingText || '处理中…' : '启动游戏'}
                </button>
              )}
              <button className="btn" disabled={locked} onClick={() => runTask(() => api.installGame(current.id), '安装完成')}>
                重新安装
              </button>
              <button className="btn" disabled={locked} onClick={() => runTask(() => api.repairGame(current.id), '文件校验完成')}>
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
              <b title={current.lastPlayed ? new Date(current.lastPlayed).toLocaleString() : undefined}>
                {current.lastPlayed ? formatLastPlayed(current.lastPlayed) : '还没玩过'}
              </b>
            </div>
            <div className="stat">
              <span>内存设置</span>
              <b>{current.maxMemory ? `${current.maxMemory} MB` : '默认'}</b>
            </div>
          </div>
        </div>
      )}

      {/* 进行中：用 0fr→1fr 折叠，出现/收起都是滑出来的，不会硬生生顶上来 */}
      <div className={`progress-fold ${activeProgress.length > 0 ? 'open' : ''}`}>
        <div>
          <div className="card">
            <h3>进行中</h3>
            {activeProgress.map((p, idx) => {
              const pct = progressPercent(p)
              return (
                <div className="progress-row" key={idx}>
                  <div className="progress-label">
                    <span>{p.phase}</span>
                    <span className="muted">
                      {progressText(p)}
                    </span>
                  </div>
                  <div className="bar">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className={`grid-2 home-grid ${editing ? 'editing' : ''}`} ref={gridRef}>
        {layout.map((id) => (
          <div key={id} data-slot={id} className="slot">
            {dragId === id ? (
              <div className="card placeholder" style={{ height: ghost.h || undefined }}>
                <span className="placeholder-label">⠿ {BLOCK_NAMES[id] ?? id} 会放在这里</span>
              </div>
            ) : (
              <div
                className={`card ${editing ? 'movable' : ''}`}
                data-tour={id === 'log' ? 'home-log' : undefined}
                onPointerDown={(e) => beginPress(e, id)}
                onPointerUp={endPress}
                onPointerCancel={endPress}
                onPointerLeave={endPress}
              >
                {editing && <div className="drag-grip">⠿ {BLOCK_NAMES[id] ?? id} · 按住拖动</div>}
                {renderBlock(id)}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 拿起来的那张卡浮在鼠标上 */}
      {dragId && dragPos && (
        <div
          className="drag-float"
          style={{ width: ghost.w || undefined, transform: `translate3d(${dragPos.x}px, ${dragPos.y}px, 0)` }}
        >
          <div className="card dragging">
            <div className="drag-grip">⠿ {BLOCK_NAMES[dragId] ?? dragId}</div>
            {renderBlock(dragId)}
          </div>
        </div>
      )}
    </div>
  )
}
