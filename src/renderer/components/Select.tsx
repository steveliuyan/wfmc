import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

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

/**
 * 自己画的 Select：系统原生 <select> 的下拉框改不了样式、也没有动效，
 * 这里换成带弹出动画 + 搜索 + 键盘导航的版本（900 个 MC 版本也能秒选）。
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
  const wrapRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const current = options.find((o) => o.value === value)
  const showSearch = !loading && (searchable ?? options.length > filterThreshold)

  const filtered = useMemo(() => {
    if (!query.trim()) return options
    const q = query.trim().toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [options, query])

  // 点外面关掉
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // 打开时滚到当前项
  useLayoutEffect(() => {
    if (!open) return
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

      {open && (
        <div className="sel-pop" role="listbox">
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
          <div className="sel-list" ref={listRef}>
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
      )}
    </div>
  )
}
