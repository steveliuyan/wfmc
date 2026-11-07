import React, { useCallback, useEffect, useRef, useState } from 'react'
import lottie, { type AnimationItem } from 'lottie-web'
import { LauncherProvider, useLauncher } from './store'
import { api, type AccountHealth, type SearchHit } from './api'
import type { NotifyItem } from '../shared/types'
import { translate } from './i18n'
import Select from './components/Select'
import Home from './views/Home'
import Instances from './views/Instances'
import Download from './views/Download'
import Resources from './views/Resources'
import Servers from './views/Servers'
import Online from './views/Online'
import Hosting from './views/Hosting'
import Skin from './views/Skin'
import TaskPanel from './views/TaskPanel'
import MusicPlayer from './views/MusicPlayer'
import Disclaimer from './views/Disclaimer'
import { setAutoI18n } from './autoI18n'
import { setDeepLink } from './deeplink'
import Manage from './views/Manage'
import SettingsView from './views/Settings'
import Notify from './views/Notify'
import NoticePopup from './views/NoticePopup'
import WhatsNew from './components/WhatsNew'
import { pendingWhatsNew } from './whatsnew'
import Tour from './components/Tour'
import { tourSteps } from './tour-steps'
import logoHorizontal from './assets/lottie-horizontal.json'
import logoBadge from './assets/logo-badge.png'

export type PageId =
  | 'home'
  | 'instances'
  | 'download'
  | 'resources'
  | 'servers'
  | 'online'
  | 'hosting'
  | 'skin'
  | 'manage'
  | 'notify'
  | 'settings'

/** 一组细线图标（SVG），配合 CSS 做 hover/active 动效 */
export const Icons = {
  home: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </svg>
  ),
  instances: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </svg>
  ),
  download: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </svg>
  ),
  layers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.4 3.8 5.6 3.8 9S14.5 18.6 12 21c-2.5-2.4-3.8-5.6-3.8-9S9.5 5.4 12 3Z" />
    </svg>
  ),
  wifi: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8 15.5a6 6 0 0 1 8 0" />
      <path d="M11 18.5a2 2 0 0 1 2 0" />
      <circle cx="12" cy="21" r="1" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="4" width="19" height="14" rx="2.5" />
      <path d="M10 8.5l5 2.5-5 2.5v-5Z" />
      <path d="M8 21h8" />
    </svg>
  ),
  user: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7Z" />
      <circle cx="12" cy="10" r="2.2" />
      <path d="M8.2 17c.7-1.8 2.1-2.7 3.8-2.7s3.1.9 3.8 2.7" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  ),
  sun: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ),
  moon: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z" />
    </svg>
  ),
  bell: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M13.7 20a2 2 0 0 1-3.4 0" />
    </svg>
  )
}

/** 已读通知 id 存这儿（纯 UI 状态，不是凭证） */
const NOTICE_SEEN_KEY = 'wfmc.notices.seen'

const nav: { id: PageId; label: string; icon: keyof typeof Icons }[] = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'instances', label: '实例', icon: 'instances' },
  { id: 'download', label: '下载游戏', icon: 'download' },
  { id: 'resources', label: '模组 · 光影', icon: 'sparkle' },
  { id: 'servers', label: '服务器', icon: 'server' },
  { id: 'online', label: '联机', icon: 'wifi' },
  { id: 'hosting', label: '一键开服', icon: 'play' },
  { id: 'skin', label: '皮肤 · 外置登录', icon: 'user' },
  { id: 'manage', label: '内容管理', icon: 'layers' },
  { id: 'notify', label: '通知', icon: 'bell' },
  { id: 'settings', label: '设置', icon: 'settings' }
]

/** 启动画面：用图标包里的横版进场动画 */
function BootSplash({ done }: { done: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [anim, setAnim] = useState<AnimationItem>()

  useEffect(() => {
    if (!ref.current) return
    const instance = lottie.loadAnimation({
      container: ref.current,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: logoHorizontal as unknown as object
    })
    setAnim(instance)
    return () => instance.destroy()
  }, [])

  useEffect(() => {
    if (done) anim?.destroy()
  }, [done, anim])

  return (
    <div className={`boot ${done ? 'boot-done' : ''}`}>
      <div className="boot-logo" ref={ref} />
      <div className="boot-tip">正在加载 WFMC …</div>
    </div>
  )
}

/** 首次运行引导：设置目录 / 内存 / 账号，三步搞定 */
function Onboarding() {
  const { settings, saveSettings, refreshAccounts, toast, dataDir } = useLauncher()

  const [step, setStep] = useState(0)
  const [mem, setMem] = useState(settings?.maxMemory ?? 4096)
  const [user, setUser] = useState('Steve')

  if (!settings) return null

  const finish = async () => {
    await saveSettings({ onboarded: true, maxMemory: mem })
    toast('设置完成，去下载游戏吧', 'success')
  }

  // 跳过：只记 onboarded，其它全用默认值
  const skip = async () => {
    await saveSettings({ onboarded: true })
    toast('已跳过引导，随时可以在「设置」里改', 'success')
  }

  // Esc 等同跳过
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void skip()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="onboard-mask">
      <div className="onboard">
        <div className="onboard-head">
          <div className="onboard-mark">WFMC</div>
          <div className="row" style={{ gap: 10 }}>
            <span className="muted small">三步完成初始化</span>
            <button className="btn sm ghost onboard-skip" onClick={skip} title="跳过引导，用默认设置（Esc 同效）">
              跳过
            </button>
          </div>
        </div>

        {step === 0 && (
          <div className="onboard-body">
            <h2>数据放哪儿？</h2>
            <p className="muted">
              游戏、实例、Java 运行时都会放在这个目录下。默认位置：
              <br />
              <code>{settings.dataDir || dataDir}</code>
            </p>
            <div className="row">
              <button
                className="btn"
                onClick={async () => {
                  const dir = await window.launcher.invoke<string | undefined>('dialog:pick-folder')
                  if (dir) {
                    await saveSettings({ dataDir: dir })
                    toast('数据目录改成 ' + dir)
                  }
                }}
              >
                换个目录
              </button>
              <button className="btn primary" onClick={() => setStep(1)}>
                下一步
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="onboard-body">
            <h2>分配多少内存？</h2>
            <p className="muted">给游戏的最大内存。电脑 16G 内存建议 4–6G，装了光影/大量模组可以再高点。</p>
            <div className="chips">
              {[2048, 4096, 6144, 8192].map((m) => (
                <button key={m} className={`chip ${mem === m ? 'on' : ''}`} onClick={() => setMem(m)}>
                  {m / 1024} GB
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn" onClick={() => setStep(0)}>
                上一步
              </button>
              <button className="btn primary" onClick={() => setStep(2)}>
                下一步
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboard-body">
            <h2>起个游戏名</h2>
            <p className="muted">离线账号的名字，进游戏后显示这个。想玩正版可以稍后在设置里微软登录。</p>
            <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="Steve" />
            <div className="row" style={{ marginTop: 18 }}>
              <button className="btn" onClick={() => setStep(1)}>
                上一步
              </button>
              <button
                className="btn primary"
                onClick={async () => {
                  try {
                    await window.launcher.invoke('account:add-offline', user.trim() || 'Steve')
                    await refreshAccounts()
                  } catch {
                    /* 账号可选 */
                  }
                  await finish()
                }}
              >
                完成，开始用
              </button>
            </div>
          </div>
        )}

        <div className="onboard-steps">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i === step ? 'on' : ''} />
          ))}
        </div>
      </div>
    </div>
  )
}

function Shell() {
  const { ready, instances, currentId, setCurrentId, accounts, toasts, settings, resolvedTheme, setTheme, toast, refreshInstances, refreshAccounts, saveSettings } = useLauncher()
  const [health, setHealth] = useState<AccountHealth[]>([])
  const [newRelease, setNewRelease] = useState<{ version: string; tag: string } | undefined>()
  const [shellTick, setShellTick] = useState(0)
  // 左下角账号：点一下就地展开列表切换，不用每次都跑设置页
  const [acctOpen, setAcctOpen] = useState(false)
  const [newName, setNewName] = useState('')
  // 新手引导（高亮讲解）：首次自动放一遍，之后靠侧边栏入口手动重放
  const [tourOpen, setTourOpen] = useState(false)
  const closeTour = useCallback(() => {
    setTourOpen(false)
    void saveSettings({ tourDone: true })
  }, [saveSettings])

  // 第一次进主界面（免责声明和基础引导都过了）自动放一遍新手引导
  useEffect(() => {
    if (!ready || !settings) return
    if (!settings.disclaimerAccepted || !settings.onboarded || settings.tourDone) return
    const timer = setTimeout(() => setTourOpen(true), 900)
    return () => clearTimeout(timer)
  }, [ready, settings])
  const activeAccount = accounts.find((x) => x.id === settings?.activeAccountId) ?? accounts[0]
  const acctType = (t?: string) => (t === 'microsoft' ? '正版' : t === 'yggdrasil' ? '外置' : '离线')

  const pickAccount = async (id: string) => {
    try {
      await api.setActiveAccount(id)
      await saveSettings({})
      await refreshAccounts()
      setAcctOpen(false)
      const a = accounts.find((x) => x.id === id)
      toast(a ? `已切到 ${a.name}` : '已切换账号', 'success')
    } catch (e) {
      toast(`切换失败：${(e as Error).message}`, 'error')
    }
  }

  const addOfflineQuick = async () => {
    const name = newName.trim() || 'Steve'
    try {
      await api.addOffline(name)
      await refreshAccounts()
      setNewName('')
      toast(`已添加离线账号 ${name}`, 'success')
    } catch (e) {
      toast(`添加失败：${(e as Error).message}`, 'error')
    }
  }

  // 登录态巡检：快过期时在侧边栏提示，点一下续期
  useEffect(() => {
    let alive = true
    const check = async () => {
      const list = await api.accountHealth().catch(() => [])
      if (alive) setHealth(list)
    }
    check()
    const timer = setInterval(check, 5 * 60 * 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [shellTick])

  const accountWarn = (() => {
    const bad = health.find((h) => h.needsRefresh)
    if (!bad) return ''
    return bad.expired ? '登录已过期，点这里重新登录' : '微软登录即将过期，点这里续期'
  })()

  // 开机检查更新：默认每 6 小时一次，发现新版本在侧边栏提示
  useEffect(() => {
    if (!ready || !settings) return
    if (settings.autoCheckUpdate === false || !settings.updateUrl) return
    const last = settings.lastUpdateCheck ?? 0
    if (Date.now() - last < 6 * 60 * 60 * 1000) return
    let alive = true
    api
      .checkReleases()
      .then((res) => {
        if (!alive || !res.hasUpdate || !res.latest) return
        setNewRelease({ version: res.latest.version, tag: res.latest.tag })
        toast('发现新版本 ' + res.latest.version + '，可在「设置 → 检查更新」查看', 'success')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, settings?.updateUrl, settings?.autoCheckUpdate])

  // 英文模式：运行时把页面上的中文文案整体替换（词典见 i18n-zh.ts）
  useEffect(() => {
    setAutoI18n(settings?.language === 'en')
  }, [settings?.language])
    useLauncher()
  const [page, setPageRaw] = useState<PageId>(() => {
    const q = new URLSearchParams(window.location.search).get('page')
    return (q as PageId) || 'home'
  })
  const [navDir, setNavDir] = useState<'fwd' | 'back'>('fwd')
  const pageRef = useRef<PageId>(page)
  pageRef.current = page
  // 切页时按导航里的先后顺序决定进场方向（往后翻从右边进、往前翻从左边进）
  const setPage = useCallback((id: PageId) => {
    const from = nav.findIndex((n) => n.id === pageRef.current)
    const to = nav.findIndex((n) => n.id === id)
    if (from >= 0 && to >= 0 && to !== from) setNavDir(to > from ? 'fwd' : 'back')
    setPageRaw(id)
  }, [])
  const [booted, setBooted] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [paletteQuery, setPaletteQuery] = useState('')
  const [paletteHits, setPaletteHits] = useState<SearchHit[]>([])
  const [paletteSel, setPaletteSel] = useState(0)
  const [paletteBusy, setPaletteBusy] = useState(false)
  const [dropHint, setDropHint] = useState(false)
  const [dropKind, setDropKind] = useState<'file' | 'link'>('file')

  // 服务端通知：主进程拉（未登录也能拉公开公告），渲染层只负责显示。
  // 已读：登录了由服务端记；未登录只存 localStorage 的 id（不是凭证）。
  const [notifyItems, setNotifyItems] = useState<NotifyItem[]>([])
  const [notifyLoggedIn, setNotifyLoggedIn] = useState(false)
  /** 待弹的「弹窗」类通知（mode='popup'），一次显示队首那条 */
  const [popupQueue, setPopupQueue] = useState<NotifyItem[]>([])
  // 升级公告：只在版本变了之后第一次打开时弹（内容写死在 whatsnew.ts，不走服务端）
  const [whatsNew, setWhatsNew] = useState(() => pendingWhatsNew())
  /** 本次运行里已经弹过的 id：同一条不会每分钟重复弹（重启后仍未读会再弹一次，符合「打开应用就弹」） */
  const poppedRef = useRef<Set<string>>(new Set())
  const [noticeSeen, setNoticeSeen] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(NOTICE_SEEN_KEY) || '[]') as unknown
      return Array.isArray(raw) ? (raw as string[]) : []
    } catch {
      return []
    }
  })
  const markNoticesSeen = useCallback((ids: string[]) => {
    setNoticeSeen((prev) => {
      const next = Array.from(new Set([...prev, ...ids]))
      try {
        localStorage.setItem(NOTICE_SEEN_KEY, JSON.stringify(next.slice(-200)))
      } catch {
        /* 存不了就算了，下次还提示一遍 */
      }
      return next
    })
  }, [])

  const isNoticeRead = useCallback(
    (n: NotifyItem) => n.read || noticeSeen.includes(String(n.id)),
    [noticeSeen]
  )

  /** 确认一条通知：本地立刻标已读；登录了再告诉服务端（未登录只记本机） */
  const ackNotice = useCallback(
    (n: NotifyItem) => {
      markNoticesSeen([String(n.id)])
      void api.notificationRead([n.id]).catch(() => undefined)
    },
    [markNoticesSeen]
  )

  /** 关掉一条弹窗通知：ack=true 表示点了「知道了」（确认已读），false 是「稍后再看」 */
  const dismissPopup = useCallback(
    (n: NotifyItem, ack: boolean) => {
      if (ack) ackNotice(n)
      setPopupQueue((prev) => prev.filter((x) => String(x.id) !== String(n.id)))
    },
    [ackNotice]
  )

  const loadNotices = useCallback(
    async (announce = false) => {
      const r = await api.notifications().catch(() => undefined)
      if (!r) return
      setNotifyItems(r.items)
      setNotifyLoggedIn(r.loggedIn)

      // ---- mode='popup'（后台勾了「弹窗」）：模态弹窗 + 右下角系统通知，一条只弹一次 ----
      const fresh = r.items.filter(
        (n) => n.mode === 'popup' && !n.read && !noticeSeen.includes(String(n.id)) && !poppedRef.current.has(String(n.id))
      )
      if (fresh.length) {
        for (const n of fresh) poppedRef.current.add(String(n.id))
        setPopupQueue((prev) => {
          const have = new Set(prev.map((x) => String(x.id)))
          return [...prev, ...fresh.filter((n) => !have.has(String(n.id)))]
        })
        const top = fresh[0]
        const more = fresh.length > 1 ? `（还有 ${fresh.length - 1} 条）` : ''
        void api
          .notificationPop({ title: top.title || 'WFMC 通知', body: `${top.body || top.title || ''}${more}` })
          .catch(() => undefined)
      }

      if (!announce) return
      // 「重要」的未读进去了弹一句 toast（本地标过已读就不再弹；已经走上面弹窗的不再重复）
      const hot = r.items.find(
        (n) =>
          !n.read &&
          !noticeSeen.includes(String(n.id)) &&
          n.mode !== 'popup' &&
          (n.level === 'important' || n.level === 'critical')
      )
      if (hot) toast(hot.title || '服务端有一条新通知', 'info')
    },
    [noticeSeen, toast]
  )

  useEffect(() => {
    const t = setTimeout(() => setBooted(true), 900)
    return () => clearTimeout(t)
  }, [])

  // 服务端通知：启动几秒后拉一次，之后每分钟拉一次（拉不到就当没有）
  useEffect(() => {
    if (!booted) return
    let alive = true
    const first = setTimeout(() => {
      if (alive) void loadNotices(true)
    }, 6000)
    const timer = setInterval(() => {
      if (alive) void loadNotices(false)
    }, 60000)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [booted, loadNotices])

  // 前端错误也记进本地日志（诊断包会带上）
  useEffect(() => {
    const onError = (e: ErrorEvent) => api.reportError('window', e.message, e.error?.stack)
    const onReject = (e: PromiseRejectionEvent) => {
      const reason = e.reason as Error | string
      api.reportError('promise', typeof reason === 'string' ? reason : (reason?.message ?? '未知'), (reason as Error)?.stack)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onReject)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onReject)
    }
  }, [])

  // Ctrl+K 全局搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        setPaletteQuery('')
      }
      if (e.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 拖拽：文件（整合包/实例包/mod）或链接（LittleSkin 外置登录卡片）
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes('Files')
    const isLinkDrag = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      return types.includes('text/uri-list') || types.includes('text/plain')
    }

    const onDragOver = (e: DragEvent) => {
      if (isFileDrag(e) || isLinkDrag(e)) {
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'copy'
        setDropKind(isFileDrag(e) ? 'file' : 'link')
        setDropHint(true)
      }
    }
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDropHint(false)
    }
    const onDrop = async (e: DragEvent) => {
      e.preventDefault()
      setDropHint(false)

      // 1) 文件：整合包 / 实例包 / mod
      if (e.dataTransfer?.files?.length) {
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.launcher.pathOfFile(f))
          .filter(Boolean)
        if (paths.length === 0) return
        try {
          const res = await api.handleDrop(currentId, paths)
          res.done.forEach((m) => toast(m, 'success'))
          res.failed.forEach((m) => toast(m, 'error'))
          await refreshInstances()
        } catch (err) {
          toast(`拖拽安装失败：${(err as Error).message}`, 'error')
        }
        return
      }

      // 2) 链接：LittleSkin 那种 authlib-injector 卡片
      const text =
        e.dataTransfer?.getData('text/uri-list') ||
        e.dataTransfer?.getData('text/plain') ||
        e.dataTransfer?.getData('URL') ||
        ''
      if (!text.trim()) {
        toast('没读到拖进来的内容（可以复制卡片链接再点「粘贴」）', 'error')
        return
      }
      const parsed = await api.parseInjectorCard(text).catch(() => undefined)
      const apiRoot = parsed ?? (/^https?:\/\//i.test(text.trim()) ? text.trim() : undefined)
      if (!apiRoot) {
        toast('这不是外置登录链接：请把 LittleSkin 的「Yggdrasil 外置登录」卡片拖进来', 'error')
        return
      }
      await saveSettings({ yggdrasilApi: apiRoot })
      setPage('skin')
      toast(`已识别验证服务器：${apiRoot}`, 'success')
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  // Ctrl+K：输入后 120ms 打一次 IPC（主进程只 readdir，不解析 jar）
  useEffect(() => {
    if (!paletteOpen) return
    const q = paletteQuery.trim()
    if (!q) {
      setPaletteHits([])
      return
    }
    setPaletteBusy(true)
    const timer = setTimeout(async () => {
      try {
        setPaletteHits(await api.searchAll(q, currentId))
      } catch {
        setPaletteHits([])
      } finally {
        setPaletteBusy(false)
      }
    }, 120)
    return () => clearTimeout(timer)
  }, [paletteOpen, paletteQuery, currentId])

  // 跳到设置页的某一节（页面本身没有锚点路由，就滚过去）
  const goSettings = (anchor: string) => {
    setPage('settings')
    setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 280)
  }

  // 模糊匹配：忽略空格/下划线/连字符，还允许子序列（mcf → Moon Create Factory）
  const fuzzy = (text: string, q: string) => {
    const nq = q.toLowerCase().replace(/[\s_\-.·]+/g, '')
    if (!nq) return true
    const nt = text.toLowerCase().replace(/[\s_\-.·]+/g, '')
    if (nt.includes(nq)) return true
    let i = 0
    for (const ch of nt) {
      if (ch === nq[i]) i++
      if (i === nq.length) return true
    }
    return false
  }

  // 把命中的那段用 <b> 标出来（只标第一处，够用了）
  const mark = (text: string, q: string) => {
    const t = q.trim()
    if (!t) return text
    const at = text.toLowerCase().indexOf(t.toLowerCase())
    if (at < 0) return text
    return (
      <>
        {text.slice(0, at)}
        <b>{text.slice(at, at + t.length)}</b>
        {text.slice(at + t.length)}
      </>
    )
  }

  type PaletteItem = { key: string; label: string; group: string; sub?: string; run: () => void }

  const staticItems: PaletteItem[] = [
    ...nav.map((n) => ({
      key: `page-${n.id}`,
      label: translate(settings?.language, `nav.${n.id}`, n.label),
      group: '页面',
      run: () => setPage(n.id)
    })),
    ...instances.map((i) => ({
      key: `ins-${i.id}`,
      label: i.name,
      group: '实例',
      sub: `${i.mcVersion} · 切到它`,
      run: () => {
        setCurrentId(i.id)
        setPage('home')
      }
    })),
    { key: 'act-updates', label: '检查 Mod 更新', group: '动作', sub: '内容管理', run: () => { setDeepLink({ tab: 'updates' }); setPage('manage') } },
    { key: 'act-crash', label: '看崩溃报告 / 运行日志', group: '动作', sub: '内容管理', run: () => { setDeepLink({ tab: 'crash' }); setPage('manage') } },
    { key: 'act-saves', label: '存档快照与回滚', group: '动作', sub: '内容管理', run: () => { setDeepLink({ tab: 'saves' }); setPage('manage') } },
    { key: 'act-shots', label: '看游戏截图', group: '动作', sub: '内容管理', run: () => { setDeepLink({ tab: 'shots' }); setPage('manage') } },
    { key: 'act-host', label: '开一个服务端', group: '动作', sub: '一键开服', run: () => setPage('hosting') },
    { key: 'act-online', label: '联机 / 穿透 / 房间码', group: '动作', sub: '联机', run: () => setPage('online') },
    { key: 'act-skin', label: '换皮肤 / 外置登录', group: '动作', sub: '皮肤', run: () => setPage('skin') },
    { key: 'act-usage', label: '清理缓存 / 下载 / 日志', group: '设置', sub: '数据目录占用明细', run: () => goSettings('set-data') },
    { key: 'set-java', label: 'Java 运行时', group: '设置', sub: '手动指定 / 自动下载', run: () => goSettings('set-java') },
    { key: 'set-download', label: '下载源 / 线程 / 限速', group: '设置', sub: '下载', run: () => goSettings('set-download') },
    { key: 'set-performance', label: '内存与性能预设', group: '设置', sub: '性能', run: () => goSettings('set-performance') },
    { key: 'set-appearance', label: '主题 / 外观 / 语言', group: '设置', sub: '界面与行为', run: () => goSettings('set-appearance') },
    { key: 'set-update', label: '检查启动器更新', group: '设置', sub: '更新', run: () => goSettings('set-update') },
    { key: 'set-credits', label: '致谢 / 关于', group: '设置', sub: '关于', run: () => goSettings('set-credits') }
  ]

  const hitItems: PaletteItem[] = paletteHits.map((h) => ({
    key: `hit-${h.page}-${h.tab ?? ''}-${h.instanceId ?? ''}-${h.title}`,
    label: h.title,
    group: h.group,
    sub: h.subtitle,
    run: () => {
      if (h.instanceId) setCurrentId(h.instanceId)
      if (h.tab) setDeepLink({ instanceId: h.instanceId, tab: h.tab })
      setPage(h.page as PageId)
    }
  }))

  const q = paletteQuery.trim()
  // 搜索命中的实例已经作为「实例」结果返回了，静态入口里同名的就不再重复列一遍
  const hitInsIds = new Set(paletteHits.map((h) => h.instanceId).filter((v): v is string => !!v))
  const filteredStatic = staticItems
    .filter((it) => !(it.key.startsWith('ins-') && hitInsIds.has(it.key.slice(4))))
    .filter((it) => fuzzy(`${it.label} ${it.sub ?? ''} ${it.group}`, q))
  // 有搜索词时把「真搜到的东西」放前面，静态入口退到后面；没词就只列入口
  const paletteItems = (q ? [...hitItems, ...filteredStatic] : filteredStatic).slice(0, 40)
  const paletteCur = Math.min(paletteSel, Math.max(0, paletteItems.length - 1))
  const unreadNotices = notifyItems.filter((n) => !isNoticeRead(n))
  if (!ready || !booted) {
    return (
      <>
        <BootSplash done={ready && booted} />
        {ready && booted && null}
      </>
    )
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img className="brand-badge" src={logoBadge} alt="WFMC" />
          <div>
            <div className="brand-mark">WFMC</div>
            <div className="brand-sub">WanFan Minecraft Launcher</div>
          </div>
        </div>

        <button className="tour-launch" onClick={() => setTourOpen(true)} title="重看一遍高亮新手引导">
          <span className="tour-launch-dot">?</span>
          新手引导
        </button>

        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{Icons[item.icon]}</span>
              <span className="nav-label">{translate(settings?.language, `nav.${item.id}`, item.label)}</span>
              <span className={`nav-dot ${item.id === 'notify' && unreadNotices.length ? 'on' : ''}`} />
            </button>
          ))}
        </nav>

        {newRelease && (
          <button className="update-banner" onClick={() => setPage('settings')} title={`新版本 ${newRelease.version}`}>
            <span className="update-banner-dot" />
            <span className="update-banner-body">
              <span className="update-banner-title">发现新版本</span>
              <span className="update-banner-sub">v{newRelease.version} · 点这里去更新</span>
            </span>
            <span className="update-banner-go">→</span>
          </button>
        )}

        <div className="sidebar-foot">
          <div className="mini-label">当前实例</div>
          <Select
            value={currentId ?? ''}
            width="100%"
            placeholder={instances.length === 0 ? '暂无实例' : '选择实例'}
            options={instances.map((i) => ({ value: i.id, label: i.name, hint: i.mcVersion }))}
            onChange={(v) => setCurrentId(v || undefined)}
          />

          <div className="mini-label" style={{ marginTop: 12 }}>
            账号
          </div>
          <div className="account-picker">
            <button
              className={`account-chip ${acctOpen ? 'open' : ''}`}
              onClick={() => setAcctOpen((v) => !v)}
              title="点一下切换账号"
            >
              <span className="ellipsis">
                {activeAccount ? `${activeAccount.name} · ${acctType(activeAccount.type)}` : '未登录'}
              </span>
              <span className="account-caret">{acctOpen ? '▴' : '▾'}</span>
            </button>
            {acctOpen && (
              <>
                <div
                  className="acct-backdrop"
                  onClick={() => setAcctOpen(false)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setAcctOpen(false)
                  }}
                />
                <div className="acct-pop">
                  <div className="mini-label">选择账号（{accounts.length}）</div>
                  {accounts.length === 0 ? (
                    <p className="muted small" style={{ margin: '2px 0 8px' }}>
                      还没有账号，下面直接加一个离线的，或者去设置里登录正版 / 外置。
                    </p>
                  ) : (
                    <div className="acct-list">
                      {accounts.map((a) => {
                        const on = (settings?.activeAccountId ?? accounts[0]?.id) === a.id
                        return (
                          <button key={a.id} className={`acct-item ${on ? 'on' : ''}`} onClick={() => pickAccount(a.id)}>
                            <span className="ellipsis">{a.name}</span>
                            <span className="muted small">{acctType(a.type)}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                  <div className="row" style={{ gap: 6, marginTop: 8 }}>
                    <input
                      className="input"
                      placeholder="离线账号名"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addOfflineQuick()
                      }}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className="btn sm" onClick={addOfflineQuick}>
                      添加
                    </button>
                  </div>
                  <button
                    className="btn ghost sm"
                    style={{ width: '100%', marginTop: 6 }}
                    onClick={() => {
                      setAcctOpen(false)
                      setPage('settings')
                    }}
                  >
                    管理 / 登录正版、外置 →
                  </button>
                </div>
              </>
            )}
          </div>
          {accountWarn && (
            <button
              className="account-warn"
              onClick={async () => {
                const res = await api.refreshExpiringAccounts().catch(() => ({ refreshed: [], failed: [] }))
                if (res.refreshed.length) toast(`已续期：${res.refreshed.join('、')}`, 'success')
                else if (res.failed.length) toast(`续期失败：${res.failed.join('、')}，请到「设置」重新登录`, 'error')
                setHealth(await api.accountHealth().catch(() => []))
              }}
            >
              {accountWarn}
            </button>
          )}

          <div className="theme-switch">
            <MusicPlayer inline />
            <button
              className={`theme-btn ${resolvedTheme === 'light' ? 'on' : ''}`}
              title="浅色主题"
              onClick={() => setTheme('light')}
            >
              {Icons.sun}
            </button>
            <button
              className={`theme-btn ${resolvedTheme === 'dark' ? 'on' : ''}`}
              title="深色主题"
              onClick={() => setTheme('dark')}
            >
              {Icons.moon}
            </button>
            <button
              className={`theme-btn text ${settings?.theme === 'system' ? 'on' : ''}`}
              title="跟随系统"
              onClick={() => setTheme('system')}
            >
              跟随系统
            </button>
          </div>
        </div>
      </aside>

      <main className={`main ${navDir === 'fwd' ? 'nav-fwd' : 'nav-back'}`}>
        {page === 'home' && <Home goto={setPage} />}
        {page === 'instances' && <Instances />}
        {page === 'download' && <Download goto={setPage} />}
        {page === 'resources' && <Resources goto={setPage} />}
        {page === 'servers' && <Servers goto={setPage} />}
        {page === 'online' && <Online goto={setPage} />}
        {page === 'hosting' && <Hosting goto={setPage} />}
        {page === 'skin' && <Skin />}
        {page === 'manage' && <Manage goto={setPage} />}
        {page === 'notify' && (
          <Notify
            items={notifyItems}
            loggedIn={notifyLoggedIn}
            isRead={isNoticeRead}
            onAck={ackNotice}
            onRefresh={() => void loadNotices(false)}
          />
        )}
        {page === 'settings' && <SettingsView />}
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>

      {settings && !settings.disclaimerAccepted && (
        <Disclaimer
          mode="consent"
          onAgree={() => saveSettings({ disclaimerAccepted: true })}
        />
      )}
      {settings && settings.disclaimerAccepted && !settings.onboarded && <Onboarding />}

      <TaskPanel />

      {whatsNew && <WhatsNew entry={whatsNew} onClose={() => setWhatsNew(undefined)} />}

      {popupQueue.length > 0 && (
        <NoticePopup
          item={popupQueue[0]}
          remaining={popupQueue.length}
          onAck={(n) => dismissPopup(n, true)}
          onLater={(n) => dismissPopup(n, false)}
        />
      )}

      {tourOpen && <Tour steps={tourSteps} goto={(p) => setPage(p as PageId)} onClose={closeTour} />}

      {dropHint && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-title">{dropKind === 'link' ? '松手就用这个验证服务器' : '松手就装'}</div>
            <div className="muted small">
              {dropKind === 'link'
                ? '识别到外置登录链接（authlib-injector），松手后自动填好 API 地址并跳到皮肤页'
                : '.mrpack / 整合包 zip / 实例包 zip → 安装整合包或导入实例；.jar → 丢进当前实例的 mods'}
            </div>
          </div>
        </div>
      )}


      {paletteOpen && (
        <div className="palette-mask" onClick={() => setPaletteOpen(false)}>
          <div className="palette" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="搜实例 / 模组 / 存档 / 服务器 / 页面 / 设置…"
              value={paletteQuery}
              onChange={(e) => {
                setPaletteQuery(e.target.value)
                setPaletteSel(0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setPaletteSel((v) => Math.min(v + 1, Math.max(0, paletteItems.length - 1)))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setPaletteSel((v) => Math.max(0, v - 1))
                } else if (e.key === 'Enter') {
                  const item = paletteItems[paletteCur]
                  if (item) {
                    item.run()
                    setPaletteOpen(false)
                  }
                }
              }}
            />
            <div className="palette-list">
              {paletteItems.map((item, i) => (
                <React.Fragment key={item.key}>
                  {(i === 0 || paletteItems[i - 1].group !== item.group) && (
                    <div className="palette-group">{item.group}</div>
                  )}
                  <div
                    className={`palette-item ${i === paletteCur ? 'active' : ''}`}
                    onMouseEnter={() => setPaletteSel(i)}
                    onClick={() => {
                      item.run()
                      setPaletteOpen(false)
                    }}
                  >
                    <span>{mark(item.label, paletteQuery)}</span>
                    {item.sub && <span className="muted small p-sub">{item.sub}</span>}
                    {i === paletteCur && <span className="badge ok">Enter</span>}
                  </div>
                </React.Fragment>
              ))}
              {paletteItems.length === 0 && (
                <div className="muted small" style={{ padding: 12 }}>
                  {paletteBusy ? '正在搜…' : q ? '没有匹配项' : '输入点什么，比如「模组名」「存档名」「java」'}
                </div>
              )}
            </div>
            <div className="palette-foot">
              <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
              <span>{paletteBusy ? '搜索中…' : `${paletteItems.length} 项`}</span>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

export default function App() {
  return (
    <LauncherProvider>
      <Shell />
    </LauncherProvider>
  )
}
