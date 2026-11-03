import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, type TaskInfo } from '../api'

/**
 * 后台任务面板：悬浮在窗口右下角，可拖动（拖动后位置记在 localStorage），可收起、可清空。
 * 面板本身不挡住内容：默认靠右下、半透明毛玻璃，拖到别处也行。
 *
 * 任务是棵树：一个安装/整合包任务会拆出「补客户端 / 补库 / 补资源」等子任务，
 * 父任务显示聚合进度（子任务按大小加权），暂停/取消整棵树一起生效。
 */
export default function TaskPanel() {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [collapsed, setCollapsed] = useState(false)
  /** 折叠起来的父任务 id（默认都展开，点一下才折） */
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const [pos, setPos] = useState<{ x: number; y: number } | undefined>(() => {
    try {
      const raw = localStorage.getItem('taskPanelPos')
      if (raw) return JSON.parse(raw) as { x: number; y: number }
    } catch {
      /* 忽略 */
    }
    return undefined
  })
  const dragRef = useRef<{ dx: number; dy: number; dragging: boolean }>({ dx: 0, dy: 0, dragging: false })
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.listTasks().then(setTasks)
    const off = api.onTask((task) => {
      setTasks((prev) => {
        const rest = prev.filter((t) => t.id !== task.id)
        return [task, ...rest].sort((a, b) => b.createdAt - a.createdAt)
      })
    })
    return off
  }, [])

  // 拖动：按下标题栏开始，松开结束；位置限制在窗口内
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return
      const w = panelRef.current?.offsetWidth ?? 300
      const h = panelRef.current?.offsetHeight ?? 200
      const x = Math.max(8, Math.min(window.innerWidth - w - 8, e.clientX - dragRef.current.dx))
      const y = Math.max(8, Math.min(window.innerHeight - h - 8, e.clientY - dragRef.current.dy))
      setPos({ x, y })
    }
    const onUp = () => {
      if (dragRef.current.dragging) {
        dragRef.current.dragging = false
        setPos((p) => {
          if (p) {
            try {
              localStorage.setItem('taskPanelPos', JSON.stringify(p))
            } catch {
              /* 忽略 */
            }
          }
          return p
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const startDrag = (e: React.MouseEvent) => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) return
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, dragging: true }
  }

  const byParent = useMemo(() => {
    const map = new Map<string, TaskInfo[]>()
    for (const t of tasks) {
      if (!t.parentId) continue
      const list = map.get(t.parentId)
      if (list) list.push(t)
      else map.set(t.parentId, [t])
    }
    // 子任务按创建时间正序：先跑的在上面
    for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt)
    return map
  }, [tasks])

  // 只把"没有父任务（或父任务已经被清掉）"的当顶层
  const roots = tasks.filter((t) => !t.parentId || !tasks.some((p) => p.id === t.parentId))

  // 暂停的也算"没跑完"：它还占着一条任务，不能混进已完成里被清掉
  const running = roots.filter((t) => t.status === 'running' || t.status === 'paused')
  const paused = roots.filter((t) => t.status === 'paused')
  const finished = roots.filter((t) => t.status !== 'running' && t.status !== 'paused')
  if (tasks.length === 0) return null

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  const toggleFold = (id: string) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const renderTask = (task: TaskInfo, depth: number): React.ReactNode => {
    const kids = byParent.get(task.id) ?? []
    const open = !folded.has(task.id)
    const pct = task.total
      ? Math.min(100, Math.round(((task.current ?? 0) / task.total) * 100))
      : task.status === 'done'
        ? 100
        : 0
    const active = task.status === 'running' || task.status === 'paused'

    return (
      <div key={task.id} className={`task-node depth-${Math.min(depth, 2)}`}>
        <div className="task-item">
          <div className="task-title">
            {kids.length > 0 ? (
              <button className={`task-fold ${open ? 'open' : ''}`} onClick={() => toggleFold(task.id)} title="展开 / 折叠子步骤">
                ▸
              </button>
            ) : (
              depth > 0 && <span className="task-branch" aria-hidden />
            )}
            <span className="ellipsis" title={task.title}>
              {task.title}
            </span>
            {kids.length > 0 && (
              <span className="task-count muted small">
                {task.childDone ?? 0}/{task.childTotal ?? kids.length}
              </span>
            )}
            {active && (
              <>
                {task.status === 'running' ? (
                  <button
                    className="btn sm ghost"
                    title="停在这儿，已经下完的文件不会重下"
                    onClick={() => api.pauseTask(task.id)}
                  >
                    暂停
                  </button>
                ) : (
                  <button className="btn sm" onClick={() => api.resumeTask(task.id)}>
                    继续
                  </button>
                )}
                <button className="btn sm danger" onClick={() => api.cancelTask(task.id)}>
                  取消
                </button>
              </>
            )}
            {task.status === 'done' && <span className="badge ok">完成</span>}
            {task.status === 'error' && <span className="badge warn">失败</span>}
            {task.status === 'canceled' && <span className="badge">已取消</span>}
          </div>
          <div className="task-sub muted small">
            {task.status === 'paused'
              ? `已暂停 · 点「继续」接着跑${task.phase ? `（${task.phase}）` : ''}`
              : task.phase ?? task.error ?? ''}
          </div>
          {active && (
            <div className={`bar ${task.status === 'paused' ? 'paused' : ''}`} style={{ height: 6 }}>
              <i style={{ width: `${pct}%` }} />
            </div>
          )}
        </div>
        {kids.length > 0 && open && <div className="task-children">{kids.map((k) => renderTask(k, depth + 1))}</div>}
      </div>
    )
  }

  return (
    <div className={`task-panel ${collapsed ? 'collapsed' : ''} ${pos ? 'floating' : ''}`} style={style} ref={panelRef}>
      <div className="task-head" onMouseDown={startDrag} title="按住这里可以拖动">
        <span className="task-grip" aria-hidden>
          ⠿
        </span>
        <span className="ellipsis">
          后台任务{' '}
          {running.length > 0
            ? `· ${running.length} 个进行中${paused.length ? `（${paused.length} 个已暂停）` : ''}`
            : '· 空闲'}
        </span>
        <span className="row">
          <button
            className="btn sm ghost"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setCollapsed((v) => !v)}
          >
            {collapsed ? '展开' : '收起'}
          </button>
          <button
            className="btn sm ghost"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={async () => {
              setTasks(await api.clearTasks())
            }}
          >
            清除
          </button>
          <button
            className="btn sm ghost"
            onMouseDown={(e) => e.stopPropagation()}
            title="回到右下角"
            onClick={() => {
              setPos(undefined)
              localStorage.removeItem('taskPanelPos')
            }}
          >
            ⟲
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="task-list">{[...running, ...finished].slice(0, 8).map((task) => renderTask(task, 0))}</div>
      )}
    </div>
  )
}
