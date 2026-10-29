import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  /** 选项超过这个数量就自动带搜索框 */
  filterThreshold?: number
  searchable?: boolean
  width?: number | string
  disabled?: boolean
  className?: string
  /** 数据还在加载：展开时先显示骨架行，不要显示「没有匹配项」 */
  loading?: boolean
  loadingText?: string
  /** 空结果时的文案（默认「没有匹配项」） */
  emptyText?: string
  /** 空结果时给个重试按钮 */
  onRetry?: () => void
}

const GAP = 6
const MIN_SPACE = 180

/**
 * 自己画的 Select：系统原生 <select> 的下拉框改不了样式、也没有动效，
 * 这里换成带弹出动画 + 搜索 + 键盘导航的版本（900 个 MC 版本也能秒选）。
 *
 * 弹出层用 portal 挂到 body + position:fixed —— 卡片、折叠面板（overflow:hidden）
 * 都裁不到它，滚轮也永远滚得动。
 */
export default function Select({
  value,
  options,
  onChange,
  placeholder = '请选择',
  filterThreshold = 12,
  searchable,
  width,
  disabled,
  className,
  loading = false,
  loadingText = '加载中…',
  emptyText,
  onRetry
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const current = options.find((o) => o.value === value)
  const showSearch = !loading && (searchable ?? options.length > filterThreshold)

  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = query.trim().toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [options, query])

  /** 量一下按钮在哪，算弹出层位置：下面放不下就翻到上面 */
  const place = () => {
    const btn = btnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP - 12
    const above = r.top - GAP - 12
    const up = below < MIN_SPACE && above > below
    const maxHeight = Math.max(160, Math.min(320, up ? above : below))
    setPos({
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 200) - 12),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
      minWidth: r.width,
      maxHeight
    })
  }

  // 点外面关掉（弹出层已经不在 wrap 里了，得单独判断）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (wrapRef.current?.contains(t)) return
      if (popRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 页面滚动 / 窗口缩放时跟着按钮走，别让它飘到别处
  useEffect(() => {
    if (!open) return
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 打开时滚到当前项
  useLayoutEffect(() => {
    if (!open) return
    place()
    setQuery('')
    const found = options.findIndex((o) => o.value === value)
    setHighlight(found >= 0 ? found : 0)
    requestAnimationFrame(() => {
      if (showSearch) searchRef.current?.focus()
      const list = listRef.current
      if (!list) return
      // 只滚下拉框自己的列表，绝不用 scrollIntoView（那会把整个页面滚走，显得"蹦一下"）
      if (found >= 0) {
        const item = list.querySelector<HTMLElement>(`[data-idx="${found}"]`)
        if (item) list.scrollTop = Math.max(0, item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2)
      } else {
        list.scrollTop = 0
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const justPicked = useRef(false)

  const commit = (v: string) => {
    justPicked.current = true
    onChange(v)
    setOpen(false)
    // 下一帧复位，避免影响后续正常点击
    requestAnimationFrame(() => {
      justPicked.current = false
    })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(filtered.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = filtered[highlight]
      if (target) commit(target.value)
    }
  }

  useEffect(() => {
    if (!open) return
    const list = listRef.current
    if (!list) return
    const item = list.querySelector<HTMLElement>(`[data-idx="${highlight}"]`)
    if (!item) return
    // 同上：只滚列表容器，避免整页被带着滚
    const top = item.offsetTop
    const bottom = top + item.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }, [highlight, open])

  const popup = open && pos && (
    <div
      className="sel-pop portal"
      role="listbox"
      ref={popRef}
      style={{
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        minWidth: pos.minWidth,
        maxHeight: pos.maxHeight
      }}
      onKeyDown={onKeyDown}
    >
      {showSearch && (
        <div className="sel-search">
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索…"
            onChange={(e) => {
              setQuery(e.target.value)
              setHighlight(0)
            }}
          />
        </div>
      )}
      <div className="sel-list" ref={listRef} style={{ maxHeight: Math.max(120, pos.maxHeight - (showSearch ? 52 : 12)) }}>
        {loading && filtered.length === 0 && (
          <div className="sel-loading">
            {Array.from({ length: 5 }).map((_, i) => (
              <span key={i} className="sk-line" style={{ width: `${68 + ((i * 11) % 26)}%` }} />
            ))}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="sel-empty">
            <div className="muted small">{emptyText ?? (query ? '没有匹配项' : '暂时没有数据')}</div>
            {onRetry && (
              <button
                className="btn sm"
                style={{ marginTop: 8 }}
                onClick={(e) => {
                  e.stopPropagation()
                  onRetry()
                }}
              >
                重试
              </button>
            )}
          </div>
        )}
        {filtered.map((opt, i) => (
          <div
            key={opt.value}
            data-idx={i}
            role="option"
            aria-selected={opt.value === value}
            className={`sel-item ${opt.value === value ? 'on' : ''} ${i === highlight ? 'hl' : ''}`}
            onMouseEnter={() => setHighlight(i)}
            onClick={() => commit(opt.value)}
            style={{ animationDelay: `${Math.min(i, 10) * 8}ms` }}
          >
            <span className="ellipsis">{opt.label}</span>
            {opt.hint && <span className="muted small">{opt.hint}</span>}
            {opt.value === value && <span className="sel-check">✓</span>}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <div
      className={`sel ${open ? 'open' : ''} ${className ?? ''}`}
      ref={wrapRef}
      style={{ width }}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="sel-btn"
        ref={btnRef}
        disabled={disabled}
        onClick={() => {
          if (justPicked.current) return
          setOpen((v) => !v)
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sel-value ellipsis">{current?.label ?? (loading ? loadingText : placeholder)}</span>
        <span className="sel-arrow">▾</span>
      </button>

      {popup && createPortal(popup, document.body)}
    </div>
  )
}
