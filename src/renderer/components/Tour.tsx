import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../tour.css'

export type TourStep = {
  /** 标题 */
  title: string
  /** 正文（一段话） */
  body: string
  /** 正文下的要点（可选） */
  points?: string[]
  /** 先跳到哪个页面（PageId），不填就停在当前页 */
  page?: string
  /** 到了这页先点一下这个元素（展开折叠面板 / 切分栏之类） */
  click?: string
  /** 高亮哪个元素（CSS 选择器）；不填就是屏幕中间一张卡片 */
  target?: string
  /** 高亮框外扩多少像素 */
  pad?: number
  /** 卡片放在目标的哪一侧，默认自动挑空间够的那一侧 */
  placement?: 'auto' | 'right' | 'left' | 'top' | 'bottom'
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

type Rect = { left: number; top: number; width: number; height: number }

/**
 * 新手引导：把要讲的地方挖个洞、打上品牌色的光圈，旁边跟着一张说明卡。
 * 不用任何第三方库，纯 CSS box-shadow 做遮罩，滚轮/窗口变化会重新量位置。
 */
export default function Tour({
  steps,
  goto,
  onClose
}: {
  steps: TourStep[]
  /** 跳页（App 里的 setPage） */
  goto: (page: string) => void
  /** 跳过 / 走完了 */
  onClose: () => void
}) {
  const [idx, setIdx] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; side: string }>({ left: -9999, top: -9999, side: 'right' })
  // 位置量好之后才让卡片登场，否则会先在屏幕外画出来再「蹦」到位置上
  const [ready, setReady] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)
  const step = steps[idx]

  const measure = useCallback(() => {
    const t = steps[idx]
    if (!t?.target) {
      setRect(null)
      return
    }
    const el = document.querySelector(t.target) as HTMLElement | null
    if (!el) {
      setRect(null)
      return
    }
    const pad = t.pad ?? 8
    const r = el.getBoundingClientRect()
    setRect({ left: Math.round(r.left - pad), top: Math.round(r.top - pad), width: Math.round(r.width + pad * 2), height: Math.round(r.height + pad * 2) })
  }, [idx, steps])

  // 进这一步：跳页 → 必要时点一下把面板展开 → 滚到可见 → 量位置
  useEffect(() => {
    let alive = true
    void (async () => {
      const t = steps[idx]
      if (!t) return
      if (t.page) {
        goto(t.page)
        await sleep(320)
      }
      if (t.click) {
        const el = document.querySelector(t.click) as HTMLElement | null
        el?.scrollIntoView({ block: 'center' })
        el?.click()
        await sleep(480)
      }
      if (!alive) return
      const el = t.target ? (document.querySelector(t.target) as HTMLElement | null) : null
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        await sleep(280)
      }
      if (!alive) return
      measure()
      // 这一步要讲的东西根本不在这（比如还没建实例）→ 直接跳到下一步，别卡住
      if (t.target && !document.querySelector(t.target) && idx < steps.length - 1) {
        await sleep(80)
        if (alive) setIdx(idx + 1)
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx])

  // 滚动 / 改窗口大小：位置要跟着走
  useEffect(() => {
    const onMove = () => measure()
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [measure])

  // 卡片位置：优先右边，放不下依次试下 / 左 / 上，最后夹在视口内
  useLayoutEffect(() => {
    const el = tipRef.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const w = el.offsetWidth
    const h = el.offsetHeight
    const gap = 16
    const edge = 14
    if (!rect) {
      setPos({ left: Math.round((vw - w) / 2), top: Math.round((vh - h) / 2), side: 'center' })
      return
    }
    const room = {
      right: vw - (rect.left + rect.width),
      left: rect.left,
      bottom: vh - (rect.top + rect.height),
      top: rect.top
    }
    const want = step?.placement && step.placement !== 'auto' ? step.placement : undefined
    // 依次试：优先放得下、不被夹、且不压住高亮块的那一侧
    const order = want
      ? [want]
      : (['right', 'bottom', 'left', 'top'] as const).filter((s) => room[s] > (s === 'right' || s === 'left' ? w : h) + gap)
    const raw = (s: string) => {
      if (s === 'right') return { left: rect.left + rect.width + gap, top: rect.top + rect.height / 2 - h / 2 }
      if (s === 'left') return { left: rect.left - gap - w, top: rect.top + rect.height / 2 - h / 2 }
      if (s === 'bottom') return { left: rect.left + rect.width / 2 - w / 2, top: rect.top + rect.height + gap }
      return { left: rect.left + rect.width / 2 - w / 2, top: rect.top - gap - h }
    }
    const slack = 40 // 差一点点也算合用，后面会夹进视口
    const fits = (p: { left: number; top: number }) =>
      p.left >= edge - slack && p.left + w <= vw - edge + slack && p.top >= edge - slack && p.top + h <= vh - edge + slack
    let side: string = order[0] ?? 'bottom'
    let left = rect.left
    let top = rect.top
    for (const s of order) {
      const p = raw(s)
      if (fits(p)) {
        side = s
        left = p.left
        top = p.top
        break
      }
    }
    // 都不合用：取压住高亮块最少的那一侧，再夹进视口
    if (left === rect.left && top === rect.top) {
      let best = Infinity
      for (const s of order.length ? order : ['bottom']) {
        const p = raw(s)
        const ox = Math.max(0, Math.min(p.left + w, rect.left + rect.width) - Math.max(p.left, rect.left))
        const oy = Math.max(0, Math.min(p.top + h, rect.top + rect.height) - Math.max(p.top, rect.top))
        const cost = ox * oy
        if (cost < best) {
          best = cost
          side = s
          left = p.left
          top = p.top
        }
      }
    }
    left = Math.max(edge, Math.min(left, vw - w - edge))
    top = Math.max(edge, Math.min(top, vh - h - edge))
    if (step?.placement && step.placement !== 'auto') side = step.placement
    setPos({ left: Math.round(left), top: Math.round(top), side })
  }, [rect, idx, step])

  // 位置一量好就放它登场（只放一次，换步骤时不再重播登场动画）
  useEffect(() => {
    if (ready || pos.left < 0) return
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [pos.left, ready])

  const last = idx === steps.length - 1
  const next = useCallback(() => {
    if (last) onClose()
    else setIdx((v) => v + 1)
  }, [last, onClose])

  // 键盘：Esc 退出、→ / Enter 下一步、← 上一步
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault()
        next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setIdx((v) => Math.max(0, v - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, onClose])

  if (!step) return null

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="新手引导">
      {rect ? (
        <div className="tour-hole" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
      ) : (
        <div className="tour-shade" />
      )}

      <div
        ref={tipRef}
        className={`tour-tip side-${pos.side}${ready ? ' ready' : ''}`}
        style={{ left: pos.left, top: pos.top, visibility: pos.left < 0 ? 'hidden' : 'visible' }}
      >
        <div className="tour-step" key={idx}>
          <div className="tour-kicker">
            新手引导 · {idx + 1} / {steps.length}
          </div>
          <h3>{step.title}</h3>
          <p className="tour-body">{step.body}</p>
          {step.points && step.points.length > 0 && (
            <ul className="tour-points">
              {step.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
        <div className="tour-foot">
          <button className="btn sm ghost" onClick={onClose}>
            跳过
          </button>
          <div className="row" style={{ gap: 8 }}>
            {idx > 0 && (
              <button className="btn sm" onClick={() => setIdx((v) => Math.max(0, v - 1))}>
                上一步
              </button>
            )}
            <button className="btn sm primary" onClick={next}>
              {last ? '知道了' : '下一步'}
            </button>
          </div>
        </div>
        <div className="tour-bar">
          <i style={{ width: `${((idx + 1) / steps.length) * 100}%` }} />
        </div>
      </div>
    </div>
  )
}
