import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, Instance, LaunchStatePayload, ProgressPayload, Settings, ThemeMode } from '../shared/types'
import { api } from './api'

export interface Toast {
  id: number
  type: 'info' | 'error' | 'success'
  message: string
}

interface Ctx {
  ready: boolean
  dataDir: string
  settings?: Settings
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: ThemeMode) => Promise<void>
  saveSettings: (patch: Partial<Settings>) => Promise<void>
  instances: Instance[]
  currentId?: string
  setCurrentId: (id?: string) => void
  current?: Instance
  refreshInstances: () => Promise<Instance[]>
  accounts: Account[]
  refreshAccounts: () => Promise<void>
  progress: Record<string, ProgressPayload>
  logs: Record<string, string[]>
  launchState: Record<string, LaunchStatePayload>
  toasts: Toast[]
  toast: (message: string, type?: Toast['type']) => void
  clearLogs: (instanceId: string) => void
  /** 清掉下载进度（失败/取消后残留的条目） */
  clearProgress: (key?: string) => void
  /** 带动效的应用内确认框（替代原生 confirm） */
  askConfirm: (opts: {
    title?: string
    message: string
    okText?: string
    cancelText?: string
    danger?: boolean
  }) => Promise<boolean>
}

const LauncherContext = createContext<Ctx>(null as never)

/** 中英切换小工具：const t = useT(); t('首页','Home') */
export function useT() {
  const { settings } = useLauncher()
  const lang = settings?.language ?? 'zh'
  return (zh: string, en: string) => (lang === 'en' ? en : zh)
}

export function useLauncher() {
  return useContext(LauncherContext)
}

function resolveTheme(mode?: ThemeMode): 'light' | 'dark' {
  if (mode === 'dark') return 'dark'
  if (mode === 'light') return 'light'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function LauncherProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  const [dataDir, setDataDir] = useState('')
  const [settings, setSettings] = useState<Settings>()
  const [instances, setInstances] = useState<Instance[]>([])
  const [currentId, setCurrentId] = useState<string>()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [progress, setProgress] = useState<Record<string, ProgressPayload>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [launchState, setLaunchState] = useState<Record<string, LaunchStatePayload>>({})
  const [toasts, setToasts] = useState<Toast[]>([])
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  const [dialog, setDialog] = useState<{
    title?: string
    message: string
    okText: string
    cancelText: string
    danger: boolean
    resolve: (ok: boolean) => void
  }>()
  const toastSeq = useRef(0)

  const askConfirm = (opts: {
    title?: string
    message: string
    okText?: string
    cancelText?: string
    danger?: boolean
  }): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      setDialog({
        title: opts.title,
        message: opts.message,
        okText: opts.okText ?? '确定',
        cancelText: opts.cancelText ?? '取消',
        danger: opts.danger ?? false,
        resolve: (ok) => {
          setDialog(undefined)
          resolve(ok)
        }
      })
    })

  const toast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++toastSeq.current
    setToasts((prev) => [...prev, { id, type, message }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), type === 'error' ? 8000 : 4000)
  }, [])

  const refreshInstances = useCallback(async () => {
    const list = await api.listInstances()
    setInstances(list)
    setCurrentId((prev) => prev ?? list[0]?.id)
    return list
  }, [])

  const refreshAccounts = useCallback(async () => {
    setAccounts(await api.accounts())
  }, [])

  const saveSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await api.setSettings(patch))
  }, [])

  const setTheme = useCallback(async (theme: ThemeMode) => {
    setSettings(await api.setTheme(theme))
  }, [])

  // 主题：写 data-theme 到 html，跟随系统时监听系统切换
  useEffect(() => {
    const apply = () => {
      const t = resolveTheme(settings?.theme)
      setResolvedTheme(t)
      document.documentElement.dataset.theme = t
    }
    apply()
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onChange = () => settings?.theme === 'system' && apply()
    mq?.addEventListener?.('change', onChange)
    return () => mq?.removeEventListener?.('change', onChange)
  }, [settings?.theme])

  // 主题自定义：主色 / 圆角 / 背景图 → 直接改 CSS 变量
  useEffect(() => {
    const root = document.documentElement
    const custom = settings?.themeCustom
    if (custom?.accent) {
      root.style.setProperty('--accent', custom.accent)
      root.style.setProperty(
        '--accent-soft',
        `color-mix(in srgb, ${custom.accent} 18%, transparent)`
      )
    } else {
      root.style.removeProperty('--accent')
      root.style.removeProperty('--accent-soft')
    }
    if (typeof custom?.radius === 'number') root.style.setProperty('--radius', `${custom.radius}px`)
    else root.style.removeProperty('--radius')

    const body = document.body
    if (custom?.wallpaper) {
      body.style.backgroundImage = `url("file://${custom.wallpaper.replace(/\\/g, '/')}")`
      body.style.backgroundSize = 'cover'
      body.style.backgroundPosition = 'center'
    } else {
      body.style.backgroundImage = ''
    }
  }, [settings?.themeCustom?.accent, settings?.themeCustom?.radius, settings?.themeCustom?.wallpaper])

  useEffect(() => {
    ;(async () => {
      const info = await api.info()
      setDataDir(info.dataDir)
      setSettings(await api.getSettings())
      await refreshInstances()
      await refreshAccounts()
      setReady(true)
    })()

    const offProgress = api.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.key]: p }))
      // 完成/失败的进度条留 3 秒让人看见，然后自动消失（不然「进行中」会永远挂着）
      if (p.done) {
        setTimeout(() => {
          setProgress((prev) => {
            if (prev[p.key]?.done) {
              const next = { ...prev }
              delete next[p.key]
              return next
            }
            return prev
          })
        }, 3000)
      }
    })
    // 任务结束（完成/失败/取消）时，把挂着这条任务名的进度条一起清掉：
    // 有些下载链路自己不上报 done，进度条会永远停在 100%
    const offTaskClean = api.onTask((task) => {
      if (task.status === 'running') return
      setTimeout(() => {
        setProgress((prev) => {
          let changed = false
          const next = { ...prev }
          for (const [k, p] of Object.entries(prev)) {
            if (p.taskId === task.id) {
              delete next[k]
              changed = true
            }
          }
          return changed ? next : prev
        })
      }, 1500)
    })
    const offLog = api.onLog(({ instanceId, line }) =>
      setLogs((prev) => {
        const arr = [...(prev[instanceId] ?? []), line]
        return { ...prev, [instanceId]: arr.slice(-1500) }
      })
    )
    const offState = api.onLaunchState((p) =>
      setLaunchState((prev) => ({ ...prev, [p.instanceId]: p }))
    )
    return () => {
      offProgress()
      offLog()
      offState()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const clearLogs = useCallback((instanceId: string) => {
    setLogs((prev) => ({ ...prev, [instanceId]: [] }))
  }, [])

  const clearProgress = useCallback((key?: string) => {
    setProgress((prev) => {
      if (!key) return {}
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  const current = useMemo(() => instances.find((i) => i.id === currentId), [instances, currentId])

  const value: Ctx = {
    ready,
    dataDir,
    settings,
    resolvedTheme,
    setTheme,
    saveSettings,
    instances,
    currentId,
    setCurrentId,
    current,
    refreshInstances,
    accounts,
    refreshAccounts,
    progress,
    logs,
    launchState,
    toasts,
    toast,
    clearLogs,
    clearProgress,
    askConfirm
  }

  return (
    <LauncherContext.Provider value={value}>
      {children}
      {dialog && (
        <div
          className="dialog-mask"
          onClick={() => dialog.resolve(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') dialog.resolve(false)
            if (e.key === 'Enter') dialog.resolve(true)
          }}
        >
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">{dialog.title ?? '确认一下'}</div>
            <div className="dialog-body">{dialog.message}</div>
            <div className="dialog-actions">
              <button className="btn" onClick={() => dialog.resolve(false)}>
                {dialog.cancelText}
              </button>
              <button
                className={`btn ${dialog.danger ? 'danger' : 'primary'}`}
                autoFocus
                onClick={() => dialog.resolve(true)}
              >
                {dialog.okText}
              </button>
            </div>
          </div>
        </div>
      )}
    </LauncherContext.Provider>
  )
}
