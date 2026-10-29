import React, { useEffect, useRef, useState } from 'react'
import { api, type TaskInfo } from '../api'

/**
 * 后台任务面板：悬浮在窗口右下角，可拖动（拖动后位置记在 localStorage），可收起、可清空。
 * 面板本身不挡住内容：默认靠右下、半透明毛玻璃，拖到别处也行。
 */
export default function TaskPanel() {
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [collapsed, setCollapsed] = useState(false)
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

  const running = tasks.filter((t) => t.status === 'running')
  const finished = tasks.filter((t) => t.status !== 'running')
  if (tasks.length === 0) return null

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
    : {}

  return (
    <div className={`task-panel ${collapsed ? 'collapsed' : ''} ${pos ? 'floating' : ''}`} style={style} ref={panelRef}>
      <div className="task-head" onMouseDown={startDrag} title="按住这里可以拖动">
        <span className="task-grip" aria-hidden>
          ⠿
        </span>
        <span className="ellipsis">后台任务 {running.length > 0 ? `· ${running.length} 个进行中` : '· 空闲'}</span>
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
        <div className="task-list">
          {[...running, ...finished].slice(0, 8).map((task) => {
            const pct = task.total
              ? Math.min(100, Math.round(((task.current ?? 0) / task.total) * 100))
              : task.status === 'done'
                ? 100
                : 0
            return (
              <div className="task-item" key={task.id}>
                <div className="task-title">
                  <span className="ellipsis" title={task.title}>
                    {task.title}
                  </span>
                  {task.status === 'running' && (
                    <button className="btn sm danger" onClick={() => api.cancelTask(task.id)}>
                      取消
                    </button>
                  )}
                  {task.status === 'done' && <span className="badge ok">完成</span>}
                  {task.status === 'error' && <span className="badge warn">失败</span>}
                  {task.status === 'canceled' && <span className="badge">已取消</span>}
                </div>
                <div className="task-sub muted small">{task.phase ?? task.error ?? ''}</div>
                {task.status === 'running' && (
                  <div className="bar" style={{ height: 6 }}>
                    <i style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
