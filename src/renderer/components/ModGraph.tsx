import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ModGraph as GraphData, ModGraphNode } from '../api'

/**
 * 依赖图（D 方向）：力导向布局 + Canvas 绘制。
 * 不引第三方图库：150 个节点以内自己算完全够，也省得为了一张图加依赖。
 * 布局在 useMemo 里一次性算完（150 节点约 30ms），交互只做平移 / 缩放 / 拖点，不实时跑物理。
 */

interface Props {
  graph?: GraphData
  loading: boolean
  onRefresh: () => void
  onFixMissing: (modids: string[]) => void
  onOpenDir: (file: string) => void
  onDisable?: (file: string) => void
}

interface P {
  x: number
  y: number
  vx: number
  vy: number
}

const MAX_NODES = 150
const L = 90 // 理想边长

function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

/** 一次性力导向布局：斥力 + 弹簧，纯手写，稳定即可 */
function layout(nodes: ModGraphNode[], edges: { from: string; to: string }[]): Map<string, P> {
  const pos = new Map<string, P>()
  const n = nodes.length
  const radius = Math.max(120, Math.sqrt(n) * 70)
  nodes.forEach((node, i) => {
    const a = (i / Math.max(1, n)) * Math.PI * 2
    pos.set(node.key, { x: Math.cos(a) * radius, y: Math.sin(a) * radius, vx: 0, vy: 0 })
  })
  const idx = new Map<string, number>()
  nodes.forEach((node, i) => idx.set(node.key, i))
  const links = edges
    .map((e) => [idx.get(e.from), idx.get(e.to)] as [number | undefined, number | undefined])
    .filter((p): p is [number, number] => p[0] !== undefined && p[1] !== undefined)

  const arr = nodes.map((node) => pos.get(node.key)!)
  const repulsion = 9000
  const iterations = n > 120 ? 180 : 260

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations
    // 斥力
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]
        const b = arr[j]
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = (i % 2 ? 1 : -1) * 0.7
          dy = (j % 2 ? 1 : -1) * 0.7
          d2 = 0.98
        }
        const d = Math.sqrt(d2)
        const f = (repulsion / d2) * cooling
        const ux = (dx / d) * f
        const uy = (dy / d) * f
        a.vx += ux
        a.vy += uy
        b.vx -= ux
        b.vy -= uy
      }
    }
    // 弹簧
    for (const [i, j] of links) {
      const a = arr[i]
      const b = arr[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01
      const f = ((d - L) / d) * 0.06
      a.vx += dx * f
      a.vy += dy * f
      b.vx -= dx * f
      b.vy -= dy * f
    }
    // 向心力 + 位移
    for (const p of arr) {
      p.vx -= p.x * 0.0025
      p.vy -= p.y * 0.0025
      p.x += Math.max(-40, Math.min(40, p.vx))
      p.y += Math.max(-40, Math.min(40, p.vy))
      p.vx *= 0.72
      p.vy *= 0.72
    }
  }
  return pos
}

export default function ModGraph({ graph, loading, onRefresh, onFixMissing, onOpenDir, onDisable }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [filter, setFilter] = useState<'all' | 'missing' | 'breaks' | 'cycle'>('all')
  const [size, setSize] = useState({ w: 900, h: 560 })
  const [hover, setHover] = useState<string>('')
  const view = useRef({ x: 0, y: 0, k: 1 })
  const drag = useRef<{ mode: 'pan' | 'node'; key?: string; sx: number; sy: number; ox: number; oy: number } | null>(null)
  const [tick, setTick] = useState(0)

  const cycleKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of graph?.cycles ?? []) for (const k of c.keys) s.add(k)
    return s
  }, [graph])

  const breakKeys = useMemo(() => {
    const s = new Set<string>()
    for (const e of graph?.edges ?? []) if (e.kind === 'breaks') {
      s.add(e.from)
      s.add(e.to)
    }
    return s
  }, [graph])

  // 折叠：节点太多时先按「缺前置 / 有冲突 / 普通」分组，默认只画重点
  const shown = useMemo(() => {
    const nodes = graph?.nodes ?? []
    if (filter === 'missing') return nodes.filter((n) => n.missing)
    if (filter === 'breaks') return nodes.filter((n) => breakKeys.has(n.key))
    if (filter === 'cycle') return nodes.filter((n) => cycleKeys.has(n.key))
    if (nodes.length <= MAX_NODES) return nodes
    const important = nodes.filter((n) => n.missing || breakKeys.has(n.key) || cycleKeys.has(n.key))
    if (important.length > 0 && important.length < MAX_NODES) return important
    return [...nodes].sort((a, b) => b.in - a.in).slice(0, MAX_NODES)
  }, [graph, filter, breakKeys, cycleKeys])

  const shownEdges = useMemo(() => {
    const keys = new Set(shown.map((n) => n.key))
    return (graph?.edges ?? []).filter((e) => keys.has(e.from) && keys.has(e.to))
  }, [graph, shown])

  const pos = useMemo(() => layout(shown, shownEdges.filter((e) => e.kind !== 'breaks')), [shown, shownEdges])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const fit = () => setSize({ w: el.clientWidth, h: 560 })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 换图时把视图复位到「能看到全部」
  useEffect(() => {
    view.current = { x: 0, y: 0, k: 1 }
    setSelected('')
    setTick((t) => t + 1)
  }, [graph])

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = size.w * dpr
    cv.height = size.h * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.w, size.h)

    const { x: px, y: py, k } = view.current
    const cx = size.w / 2
    const cy = size.h / 2
    const tx = (p: P) => ({ x: cx + (p.x + px) * k, y: cy + (p.y + py) * k })
    const nodeByKey = new Map(shown.map((n) => [n.key, n] as const))

    // 边
    for (const e of shownEdges) {
      const a = pos.get(e.from)
      const b = pos.get(e.to)
      if (!a || !b) continue
      const pa = tx(a)
      const pb = tx(b)
      ctx.beginPath()
      ctx.moveTo(pa.x, pa.y)
      // 轻微弧度，双向依赖不至于完全重合
      const mx = (pa.x + pb.x) / 2 + (pb.y - pa.y) * 0.08
      const my = (pa.y + pb.y) / 2 - (pb.x - pa.x) * 0.08
      ctx.quadraticCurveTo(mx, my, pb.x, pb.y)
      if (e.kind === 'breaks') {
        ctx.strokeStyle = '#e0533d'
        ctx.setLineDash([6, 5])
        ctx.lineWidth = 1.6
      } else if (e.kind === 'missing') {
        ctx.strokeStyle = '#e0a13d'
        ctx.setLineDash([4, 4])
        ctx.lineWidth = 1.4
      } else {
        ctx.strokeStyle = 'rgba(150,160,180,0.42)'
        ctx.setLineDash([])
        ctx.lineWidth = 1
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 点
    for (const n of shown) {
      const p = pos.get(n.key)
      if (!p) continue
      const q = tx(p)
      const r = Math.max(4, Math.min(14, (n.missing ? 7 : 5) + n.in * 0.9)) * Math.max(0.75, Math.min(1.4, k))
      const isSel = n.key === selected
      const isHover = n.key === hover
      ctx.beginPath()
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2)
      if (n.missing) {
        ctx.fillStyle = hexA('#e0a13d', 0.14)
        ctx.fill()
        ctx.strokeStyle = '#e0a13d'
      } else if (n.disabled) {
        ctx.fillStyle = hexA('#6b7280', 0.5)
        ctx.fill()
        ctx.strokeStyle = '#6b7280'
      } else if (cycleKeys.has(n.key)) {
        ctx.fillStyle = hexA('#e0533d', 0.22)
        ctx.fill()
        ctx.strokeStyle = '#e0533d'
      } else {
        ctx.fillStyle = hexA('#4f8cff', 0.22)
        ctx.fill()
        ctx.strokeStyle = '#4f8cff'
      }
      ctx.lineWidth = isSel || isHover ? 2.4 : 1.3
      if (breakKeys.has(n.key) && !n.missing) {
        ctx.setLineDash([3, 3])
        ctx.lineWidth = 2
      }
      ctx.stroke()
      ctx.setLineDash([])

      const showLabel = isSel || isHover || n.missing || n.in >= 2 || k > 1.3
      if (showLabel) {
        const label = n.name.length > 18 ? n.name.slice(0, 17) + '…' : n.name
        ctx.font = `${Math.max(9, Math.min(13, 11 * k))}px system-ui, "Microsoft YaHei", sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        const w = ctx.measureText(label).width
        ctx.fillStyle = 'rgba(12,14,18,0.72)'
        ctx.fillRect(q.x - w / 2 - 3, q.y + r + 3, w + 6, 15)
        ctx.fillStyle = n.missing ? '#f0be6a' : '#cbd5e1'
        ctx.fillText(label, q.x, q.y + r + 5)
      }
    }
    void nodeByKey
  }, [shown, shownEdges, pos, size, selected, hover, k0(tick)])

  const pick = (mx: number, my: number): { node?: ModGraphNode; key?: string } => {
    const { x: px, y: py, k } = view.current
    const cx = size.w / 2
    const cy = size.h / 2
    let best: { node?: ModGraphNode; key?: string; d: number } = { d: 16 }
    for (const n of shown) {
      const p = pos.get(n.key)
      if (!p) continue
      const sx = cx + (p.x + px) * k
      const sy = cy + (p.y + py) * k
      const d = Math.hypot(sx - mx, sy - my)
      const r = Math.max(6, 5 + n.in * 0.9) * Math.max(0.75, Math.min(1.4, k)) + 4
      if (d <= r && d < best.d) best = { node: n, key: n.key, d }
    }
    return { node: best.node, key: best.key }
  }

  const onDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const hit = pick(mx, my)
    drag.current = hit.key
      ? { mode: 'node', key: hit.key, sx: mx, sy: my, ox: 0, oy: 0 }
      : { mode: 'pan', sx: mx, sy: my, ox: view.current.x, oy: view.current.y }
  }

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const d = drag.current
    if (!d) {
      const h = pick(mx, my).key ?? ''
      if (h !== hover) setHover(h)
      return
    }
    if (d.mode === 'pan') {
      view.current = { ...view.current, x: d.ox + (mx - d.sx), y: d.oy + (my - d.sy) }
      setTick((t) => t + 1)
    } else if (d.key) {
      const p = pos.get(d.key)
      if (p) {
        p.x += (mx - d.sx) / view.current.k
        p.y += (my - d.sy) / view.current.k
        d.sx = mx
        d.sy = my
        setTick((t) => t + 1)
      }
    }
  }

  const onUp = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const d = drag.current
    drag.current = null
    if (!d) return
    const moved = Math.hypot(mx - d.sx, my - d.sy)
    if (d.mode === 'node' && d.key && moved < 4) setSelected((cur) => (cur === d.key ? '' : d.key!))
  }

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    const v = view.current
    const next = Math.max(0.35, Math.min(3, v.k * (e.deltaY > 0 ? 0.9 : 1.1)))
    // 以鼠标位置为中心缩放
    const cx = size.w / 2
    const cy = size.h / 2
    const wx = (mx - cx) / v.k - v.x
    const wy = (my - cy) / v.k - v.y
    view.current = { x: (mx - cx) / next - wx, y: (my - cy) / next - wy, k: next }
    setTick((t) => t + 1)
  }

  const node = shown.find((n) => n.key === selected)
  const dependents = useMemo(() => {
    if (!node) return []
    return (graph?.edges ?? [])
      .filter((e) => e.to === node.key && e.kind !== 'breaks')
      .map((e) => graph?.nodes.find((n) => n.key === e.from)?.name ?? e.from)
  }, [graph, node])
  const requires = useMemo(() => {
    if (!node) return []
    return (graph?.edges ?? [])
      .filter((e) => e.from === node.key && e.kind !== 'breaks')
      .map((e) => graph?.nodes.find((n) => n.key === e.to)?.name ?? e.to)
  }, [graph, node])

  if (loading && !graph) return <div className="card empty">正在读模组依赖…</div>
  if (!graph) return <div className="card empty">还没有读到依赖信息</div>
  if (graph.nodes.length === 0) return <div className="card empty">这个实例的 mods 目录是空的，没有依赖可画</div>

  const s = graph.stats
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="row wrap" style={{ padding: '10px 12px', gap: 8, alignItems: 'center' }}>
        <b>依赖图</b>
        <span className="muted small">
          {s.mods} 个模组 · {s.edges} 条关系
          {s.missingCount > 0 ? ` · 缺 ${s.missingCount} 个前置` : ''}
          {s.cycleCount > 0 ? ` · ${s.cycleCount} 处循环依赖` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button className={`btn small ${filter === 'all' ? 'primary' : ''}`} onClick={() => setFilter('all')}>
          全部
        </button>
        <button
          className={`btn small ${filter === 'missing' ? 'primary' : ''}`}
          onClick={() => setFilter('missing')}
          disabled={s.missingCount === 0}
        >
          缺前置 {s.missingCount || ''}
        </button>
        <button
          className={`btn small ${filter === 'breaks' ? 'primary' : ''}`}
          onClick={() => setFilter('breaks')}
          disabled={breakKeys.size === 0}
        >
          冲突 {breakKeys.size || ''}
        </button>
        <button
          className={`btn small ${filter === 'cycle' ? 'primary' : ''}`}
          onClick={() => setFilter('cycle')}
          disabled={s.cycleCount === 0}
        >
          循环 {cycleKeys.size || ''}
        </button>
        <button className="btn small" onClick={onRefresh}>
          重新读
        </button>
        {graph.missing.length > 0 && (
          <button
            className="btn small primary"
            onClick={() => onFixMissing(graph.missing.map((m) => m.id))}
            title="去 Modrinth 找这些前置并装到 mods 里（连带它们自己的前置）"
          >
            一键补全缺失前置（{graph.missing.length}）
          </button>
        )}
      </div>

      {graph.missing.length > 0 && filter !== 'all' && (
        <div className="notice-bar warn" style={{ margin: '0 12px 8px' }}>
          缺前置：{graph.missing.map((m) => `${m.label}${m.range ? `（要 ${m.range}）` : ''}`).join('、')}
        </div>
      )}

      <div ref={wrapRef} style={{ position: 'relative', borderTop: '1px solid var(--line)' }}>
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, display: 'block', cursor: drag.current ? 'grabbing' : hover ? 'pointer' : 'grab' }}
          onMouseDown={onDown}
          onMouseMove={onMove}
          onMouseUp={onUp}
          onMouseLeave={() => {
            drag.current = null
            setHover('')
          }}
          onWheel={onWheel}
        />
        <div className="muted small" style={{ position: 'absolute', left: 10, bottom: 8, pointerEvents: 'none' }}>
          滚轮缩放 · 拖动空白处平移 · 点一个点看详情
        </div>

        {node && (
          <div
            className="card"
            style={{
              position: 'absolute',
              right: 10,
              top: 10,
              width: 300,
              maxHeight: size.h - 24,
              overflow: 'auto',
              background: 'var(--card)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.35)'
            }}
          >
            <div className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <b>{node.name}</b>
                <div className="muted small">
                  {node.missing ? '缺失的前置（没装）' : node.id ? `${node.id}${node.version ? ` · ${node.version}` : ''}` : ''}
                </div>
              </div>
              <button className="btn small" onClick={() => setSelected('')}>
                ×
              </button>
            </div>
            {!node.missing && (
              <div className="muted small" style={{ marginTop: 6 }}>
                {node.file} · {(node.bytes / 1048576).toFixed(1)} MB{node.disabled ? ' · 已禁用' : ''}
              </div>
            )}
            {node.missing && (
              <div className="muted small" style={{ marginTop: 6 }}>
                被 {node.in} 个模组需要{dependents.length ? `：${dependents.slice(0, 6).join('、')}` : ''}
              </div>
            )}
            {requires.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="muted small">它依赖（{requires.length}）</div>
                <div className="small">{requires.slice(0, 12).join('、')}</div>
              </div>
            )}
            {dependents.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="muted small">谁依赖它（{dependents.length}）</div>
                <div className="small">{dependents.slice(0, 12).join('、')}</div>
              </div>
            )}
            <div className="row wrap" style={{ marginTop: 10, gap: 6 }}>
              {node.missing && node.id && (
                <button className="btn small primary" onClick={() => onFixMissing([node.id!])}>
                  装这个前置
                </button>
              )}
              {!node.missing && node.file && (
                <button className="btn small" onClick={() => onOpenDir(node.file!)}>
                  打开所在文件夹
                </button>
              )}
              {!node.missing && node.file && onDisable && !node.disabled && (
                <button className="btn small" onClick={() => onDisable(node.file!)}>
                  停用
                </button>
              )}
            </div>
          </div>
        )}

        {graph.cycles.length > 0 && (
          <div
            className="notice-bar warn"
            style={{ position: 'absolute', left: 10, top: 10, maxWidth: 'calc(100% - 330px)' }}
          >
            循环依赖：{graph.cycles.map((c) => c.label).join('；')} —— 互相等对方先加载，游戏通常卡在启动阶段
          </div>
        )}
      </div>
    </div>
  )
}

/** 让 tick 变化触发重绘（把 tick 塞进依赖数组的取巧写法） */
function k0(t: number): number {
  return t
}
