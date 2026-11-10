import React, { useEffect, useState } from 'react'
import { api, formatSize, friendlyError } from '../api'
import type { UpdateInfo } from '../api'
import McpPanel from '../components/McpPanel'
import { useLauncher, useT } from '../store'
import type { BlobStats, DiskUsage, JavaInfo, ThemeMode } from '../../shared/types'
import { CREDITS, CREDIT_KIND_LABEL, type CreditKind } from '../../shared/credits'
import Select from '../components/Select'
import Disclaimer from './Disclaimer'
import UpdateCenter from './UpdateCenter'
import CloudPanel from '../components/CloudPanel'
import WfmcAccountPanel from '../components/WfmcAccountPanel'
import { deriveAccent } from '../color'

/** Aikar 的 G1GC 参数（社区公认的 Minecraft 服务端/客户端优化组合） */
const JVM_PRESETS: { label: string; value: string }[] = [
  {
    label: '优化参数（Aikar G1GC）',
    value:
      '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1'
  },
  { label: '中文不乱码', value: '-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8' },
  { label: '清空', value: '' }
]

/** 左侧分区导航：顺序即页面从上到下的顺序 */
const RAIL: { id: string; label: string; icon: string }[] = [
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'download', label: '下载与网络', icon: '⬇' },
  { id: 'performance', label: '内存与性能', icon: '⚡' },
  { id: 'data', label: '数据目录', icon: '📁' },
  { id: 'java', label: 'Java 运行时', icon: '☕' },
  { id: 'accounts', label: '账号', icon: '👤' },
  { id: 'curseforge', label: 'CurseForge', icon: '🔑' },
  { id: 'mcp', label: 'AI 助手', icon: '🤖' },
  { id: 'cloud', label: '云同步', icon: '☁' },
  { id: 'update', label: '更新', icon: '🔄' },
  { id: 'credits', label: '致谢', icon: '💖' },
  { id: 'about', label: '关于', icon: 'ℹ' }
]

/** 卡片头：图标 + 标题 + 一句说明，替代原来干巴巴的 <h3> */
function SetHead({ icon, title, desc }: { icon: string; title: string; desc?: React.ReactNode }) {
  return (
    <div className="set-head">
      <div className="set-icon">{icon}</div>
      <div className="set-titles">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
    </div>
  )
}

export default function SettingsView() {
  const { settings, saveSettings, dataDir, accounts, refreshAccounts, refreshInstances, toast, current, resolvedTheme, setTheme, askConfirm } = useLauncher()
  // 圆角滑块的草稿值：拖动时只改它（即时预览），松手才写盘。
  // 以前 onChange 直接 saveSettings → IPC 写 settings.json + 整个 Settings 回灌全树重渲染，拖起来又卡又抖。
  const [radiusDraft, setRadiusDraft] = useState<number | null>(null)
  const themeCustom = settings?.themeCustom
  const radius = radiusDraft ?? themeCustom?.radius ?? 14
  const commitRadius = (v: number) => {
    setRadiusDraft(null)
    if ((themeCustom?.radius ?? 14) !== v) {
      void saveSettings({ themeCustom: { ...themeCustom, radius: v } })
    }
  }
  const [pinfo, setPinfo] = useState<Awaited<ReturnType<typeof api.dataSharedInfo>> | undefined>()
  // 找回旧数据：机器上所有存过数据的目录（老名字的、便携版的、安装版的）
  const [foundData, setFoundData] = useState<Awaited<ReturnType<typeof api.dataDiscover>>>([])
  // 全盘扫描（只扫到第二层：F:\data 这种放在别的盘的也能捞出来）
  const [scanning, setScanning] = useState(false)
  /** 扫到 / 手动挑到的目录并进列表（按路径去重，分数高的排前面） */
  const mergeFound = (hits: Awaited<ReturnType<typeof api.dataDiscover>>) =>
    setFoundData((prev) => {
      const merged = [...prev]
      for (const h of hits) {
        if (!merged.some((m) => m.dir.toLowerCase() === h.dir.toLowerCase())) merged.push(h)
      }
      return merged.sort((a, b) => b.score - a.score)
    })
  // 数据目录占用（主进程有缓存，点了才统计）
  const [dataSize, setDataSize] = useState<{ bytes: number; partial: boolean } | null>(null)
  // 占用明细（实例 / 下载 / 缓存 / 快照 / 日志），点按钮才走盘
  const [usage, setUsage] = useState<DiskUsage | null>(null)
  const [usageBusy, setUsageBusy] = useState(false)
  // 硬链接去重（同一个 jar 在多个实例里只占一份）
  const [blobs, setBlobs] = useState<BlobStats | null>(null)
  const [dedupeBusy, setDedupeBusy] = useState(false)
  const refreshBlobs = async () => {
    setDedupeBusy(true)
    try {
      setBlobs(await api.blobStats())
    } catch (e) {
      toast(`统计失败：${(e as Error).message}`, 'error')
    } finally {
      setDedupeBusy(false)
    }
  }
  const runDedupe = async () => {
    setDedupeBusy(true)
    try {
      const r = await api.dedupeBlobs()
      toast(`去重完成：新共享 ${r.linked} 个文件，省下 ${formatSize(r.bytes)}`, 'success')
      setBlobs(await api.blobStats())
    } catch (e) {
      toast(`去重失败：${(e as Error).message}`, 'error')
    } finally {
      setDedupeBusy(false)
    }
  }
  const runGcBlobs = async () => {
    setDedupeBusy(true)
    try {
      const r = await api.gcBlobs()
      toast(`清掉 ${r.files} 个孤立文件，腾出 ${formatSize(r.bytes)}`, 'success')
      setBlobs(await api.blobStats())
    } catch (e) {
      toast(`清理失败：${(e as Error).message}`, 'error')
    } finally {
      setDedupeBusy(false)
    }
  }
  // 一键删除全部数据正在跑（按钮变灰，防止连点）
  const [wiping, setWiping] = useState(false)
  // 数据目录体检：放在安装目录里的话，更新安装包会把整份数据清掉（踩过：D:\WFMC\data 每次更新都没）
  const [health, setHealth] = useState<{ installDir: string; insideInstall: boolean } | null>(null)
  useEffect(() => {
    api
      .dataHealth()
      .then((h) => setHealth({ installDir: h.installDir, insideInstall: h.insideInstall }))
      .catch(() => setHealth(null))
  }, [settings?.dataDir])
  const refreshFound = () =>
    api
      .dataDiscover()
      .then(setFoundData)
      .catch(() => undefined)
  useEffect(() => {
    refreshFound()
  }, [])
  useEffect(() => {
    api
      .dataSharedInfo()
      .then(setPinfo)
      .catch(() => undefined)
  }, [])
  const t = useT()
  const [javas, setJavas] = useState<JavaInfo[]>([])
  const [offlineName, setOfflineName] = useState('Steve')
  const [msInfo, setMsInfo] = useState<{ deviceCode: string; userCode: string; verificationUri: string; expiresIn: number }>()
  const [msLoading, setMsLoading] = useState(false)
  const [jvmArgs, setJvmArgs] = useState('')
  const [yggApi, setYggApi] = useState('https://littleskin.cn/api/yggdrasil')
  const [yggUser, setYggUser] = useState('')
  const [yggPass, setYggPass] = useState('')
  const [appVersion, setAppVersion] = useState('')
  const [update, setUpdate] = useState<UpdateInfo | undefined>()
  const [showDisclaimer, setShowDisclaimer] = useState(false)
  const [uninstaller, setUninstaller] = useState<string>()
  // CurseForge API Key：默认遮住，点眼睛才显示；改完必须显式「保存」才落盘
  const [cfKey, setCfKey] = useState('')
  const [cfKeyShown, setCfKeyShown] = useState(false)
  const [cfKeyState, setCfKeyState] = useState<'idle' | 'dirty' | 'saving' | 'saved'>('idle')
  const [cfTesting, setCfTesting] = useState(false)
  const [javaMsg, setJavaMsg] = useState('')
  const [javaBusy, setJavaBusy] = useState(false)
  // 左侧导航高亮：页面滚动到哪一块就点亮哪一项
  const [activeSec, setActiveSec] = useState('appearance')
  const ready = !!settings

  const saveCfKey = async () => {
    setCfKeyState('saving')
    await saveSettings({ curseforgeApiKey: cfKey.trim() })
    setCfKeyState('saved')
    toast('CurseForge API Key 已保存', 'success')
  }

  const testCfKey = async () => {
    setCfTesting(true)
    try {
      const r = await api.cfTestKey(cfKey.trim())
      toast(r, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    } finally {
      setCfTesting(false)
    }
  }

  // 只有安装版才有卸载器；便携版这里为空，按钮不显示
  useEffect(() => {
    api
      .uninstallerPath()
      .then((p) => setUninstaller(p))
      .catch(() => setUninstaller(undefined))
    api
      .appVersion()
      .then((v) => setAppVersion(v))
      .catch(() => setAppVersion(''))
  }, [])
  const [speed, setSpeed] = useState<
    { results: { name: string; ok: boolean; ms: number }[]; recommend: 'mirror' | 'official' } | undefined
  >()

  useEffect(() => {
    api.appVersion().then(setAppVersion)
  }, [])

  useEffect(() => {
    if (settings) setJvmArgs((settings.extraJvmArgs ?? []).join(' '))
  }, [settings?.extraJvmArgs.join(' ')])

  const scan = async () => {
    const list = await api.scanJava()
    setJavas(list)
    if (list.length === 0) toast('没扫到 Java，可以点「下载官方运行时」', 'info')
  }

  useEffect(() => {
    scan()
  }, [])

  // 设置首次加载 / 变化时把已存的 key 灌进输入框（用户正在改就别覆盖）
  useEffect(() => {
    if (cfKeyState === 'idle' && settings?.curseforgeApiKey) setCfKey(settings.curseforgeApiKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.curseforgeApiKey])

  // 左侧导航跟着滚动高亮（.main 才是滚动容器，用 root=null 也能正确按可视区裁切）
  useEffect(() => {
    if (!ready) return
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible[0]) setActiveSec(visible[0].target.id.replace(/^set-/, ''))
      },
      { rootMargin: '-10% 0px -72% 0px', threshold: 0 }
    )
    RAIL.forEach((r) => {
      const el = document.getElementById(`set-${r.id}`)
      if (el) obs.observe(el)
    })
    return () => obs.disconnect()
  }, [ready])

  const jumpTo = (id: string) => {
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  // 别的面板让我跳到某个分区（比如备份面板的「去「账号」里登录」）
  useEffect(() => {
    const onJump = (e: Event) => {
      const id = String((e as CustomEvent).detail || '')
      if (id) jumpTo(id)
    }
    window.addEventListener('wfmc:goto-section', onJump)
    return () => window.removeEventListener('wfmc:goto-section', onJump)
  }, [])

  if (!settings) return <div className="page">加载中…</div>

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            {t('设置', 'Settings')} <span className="badge">v{appVersion || '—'}</span>
          </h1>
          <p className="muted small">
            数据目录：<code>{settings.dataDir || dataDir}</code>
          </p>
        </div>
        <div className="set-actions">
          <button className="btn sm ghost" onClick={() => api.openPath(settings.dataDir || dataDir)}>
            打开数据目录
          </button>
          <button className="btn sm ghost" onClick={() => setShowDisclaimer(true)}>
            免责声明
          </button>
        </div>
      </header>

      <div className="settings-shell">
        {/* 图标条：只留图标，鼠标停一下才浮出分区名（data-label 给 CSS ::after 用） */}
        <nav className="settings-rail" aria-label="设置分区">
          {RAIL.map((item) => (
            <button
              key={item.id}
              className={activeSec === item.id ? 'on' : ''}
              onClick={() => jumpTo(item.id)}
              data-label={item.label}
              aria-label={item.label}
            >
              <span className="rail-dot">{item.icon}</span>
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {/* ── 外观 ────────────────────────────────── */}
          <section id="set-appearance" className="card set-card">
            <SetHead icon="🎨" title="外观与主题" desc="配色、圆角、背景图和语言都在这里；改完立即生效，不用重启。" />

            <div className="set-block">
              <div className="set-block-title">
                <span>主题</span>
                <span className="muted small">当前生效：{resolvedTheme === 'light' ? '浅色' : '深色'}</span>
              </div>
              <div className="theme-cards">
                {(
                  [
                    { id: 'light', label: '浅色', desc: '白底，适合白天' },
                    { id: 'dark', label: '深色', desc: '深底，适合夜里' },
                    { id: 'system', label: '跟随系统', desc: '跟 Windows 主题走' }
                  ] as { id: ThemeMode; label: string; desc: string }[]
                ).map((opt) => (
                  <button
                    key={opt.id}
                    className={`theme-card ${settings.theme === opt.id ? 'on' : ''}`}
                    onClick={() => setTheme(opt.id)}
                  >
                    <div className={`theme-preview ${opt.id}`}>
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="theme-card-title">{opt.label}</div>
                    <div className="muted small">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="set-block">
              <div className="set-block-title">主题自定义</div>
              <div className="set-actions">
                <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  主色
                  <input
                    type="color"
                    value={settings.themeCustom?.accent ?? '#5b3fd6'}
                    onChange={(e) => saveSettings({ themeCustom: { ...settings.themeCustom, accent: e.target.value } })}
                    style={{ width: 44, height: 30, padding: 2 }}
                  />
                </label>
                {['#5b3fd6', '#372fa2', '#06b6d3', '#2f9e44', '#e8590c', '#c2255c'].map((c) => (
                  <button
                    key={c}
                    className="swatch"
                    title={c}
                    style={{ background: c }}
                    onClick={() => saveSettings({ themeCustom: { ...settings.themeCustom, accent: c } })}
                  />
                ))}
                {(() => {
                  const p = deriveAccent(settings.themeCustom?.accent ?? '#5b3fd6', resolvedTheme)
                  const chips: { c: string; t: string }[] = [
                    { c: p.accent, t: '主色' },
                    { c: p.accent2, t: '亮调' },
                    { c: p.soft, t: '柔光' },
                    { c: p.ring, t: '焦点环' }
                  ]
                  return (
                    <span
                      className="accent-derived"
                      title="按 LAB 感知亮度从主色派生：深色模式自动提亮、浅色模式自动压暗，主色为灰时按原样保留"
                    >
                      派生
                      {chips.map((k) => (
                        <span key={k.t} className="accent-chip" style={{ background: k.c }} title={k.t} />
                      ))}
                    </span>
                  )
                })()}
                <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  圆角 {radius}px
                  <input
                    type="range"
                    min={0}
                    max={26}
                    value={radius}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      setRadiusDraft(v)
                      document.documentElement.style.setProperty('--radius', `${v}px`)
                    }}
                    onPointerUp={() => commitRadius(radius)}
                    onKeyUp={() => commitRadius(radius)}
                    onBlur={() => commitRadius(radius)}
                    style={{ width: 120 }}
                  />
                </label>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const file = await api.pickImage()
                    if (file) await saveSettings({ themeCustom: { ...settings.themeCustom, wallpaper: file } })
                  }}
                >
                  选背景图
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    setRadiusDraft(null)
                    document.documentElement.style.removeProperty('--radius')
                    void saveSettings({ themeCustom: {} })
                  }}
                >
                  恢复默认外观
                </button>
              </div>
            </div>

            <div className="set-block">
              <div className="set-block-title">界面与行为</div>
              <div className="set-grid two">
                <div>
                  <div className="set-block-title" style={{ fontWeight: 400, marginBottom: 6, fontSize: 12 }}>
                    关闭窗口时
                  </div>
                  <div className="chips">
                    <button
                      className={`chip ${(settings.closeToTray ?? true) ? 'on' : ''}`}
                      onClick={() => saveSettings({ closeToTray: true })}
                    >
                      缩到托盘（服务端继续跑）
                    </button>
                    <button
                      className={`chip ${!(settings.closeToTray ?? true) ? 'on' : ''}`}
                      onClick={() => saveSettings({ closeToTray: false })}
                    >
                      直接退出程序
                    </button>
                  </div>
                </div>
                <div>
                  <div className="set-block-title" style={{ fontWeight: 400, marginBottom: 6, fontSize: 12 }}>
                    启动前自动备份存档
                  </div>
                  <div className="chips">
                    <button
                      className={`chip ${settings.autoBackupSaves !== false ? 'on' : ''}`}
                      onClick={() => saveSettings({ autoBackupSaves: true })}
                    >
                      开着（崩了能回滚）
                    </button>
                    <button
                      className={`chip ${settings.autoBackupSaves === false ? 'on' : ''}`}
                      onClick={() => saveSettings({ autoBackupSaves: false })}
                    >
                      关掉
                    </button>
                  </div>
                </div>
                <div>
                  <div className="set-block-title" style={{ fontWeight: 400, marginBottom: 6, fontSize: 12 }}>
                    存档工坊（实验功能）
                  </div>
                  <div className="chips">
                    <button
                      className={`chip ${settings.saveWorkshop === true ? 'on' : ''}`}
                      onClick={() => saveSettings({ saveWorkshop: true })}
                    >
                      开着（能改 level.dat）
                    </button>
                    <button
                      className={`chip ${settings.saveWorkshop !== true ? 'on' : ''}`}
                      onClick={() => saveSettings({ saveWorkshop: false })}
                    >
                      关掉（只读查看）
                    </button>
                  </div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    改存档会写 level.dat，写坏不可逆；每次写入前都会自动打一份快照。不开这项时，内容管理里不显示「存档工坊」，存档列表和体检照常可看。
                  </div>
                </div>
                <div>
                  <div className="set-block-title" style={{ fontWeight: 400, marginBottom: 6, fontSize: 12 }}>
                    启动前跑一遍模组体检
                  </div>
                  <div className="chips">
                    <button
                      className={`chip ${settings.launchCheckMods !== false ? 'on' : ''}`}
                      onClick={() => saveSettings({ launchCheckMods: true })}
                    >
                      开着（重复 mod / 加载器不对先拦一下）
                    </button>
                    <button
                      className={`chip ${settings.launchCheckMods === false ? 'on' : ''}`}
                      onClick={() => saveSettings({ launchCheckMods: false })}
                    >
                      关掉（直接启动）
                    </button>
                  </div>
                </div>
                <div>
                  <div className="set-block-title" style={{ fontWeight: 400, marginBottom: 6, fontSize: 12 }}>
                    语言
                  </div>
                  <div className="chips">
                    {(
                      [
                        ['zh', '中文'],
                        ['en', 'English']
                      ] as [string, string][]
                    ).map(([code, label]) => (
                      <button
                        key={code}
                        className={`chip ${(settings.language ?? 'zh') === code ? 'on' : ''}`}
                        onClick={() => saveSettings({ language: code as 'zh' | 'en' })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <p className="set-note">语言目前覆盖导航 / 页面标题 / 主要按钮，正文文案仍在逐页补。</p>
            </div>

            <div className="set-block">
              <div className="set-block-title">
                <span>游玩总结分享卡</span>
                <span className="muted small">退出游戏时弹一张 1080×1440 的战绩图</span>
              </div>
              <div className="chips">
                <button
                  className={`chip ${settings.shareSummary !== false ? 'on' : ''}`}
                  onClick={() => saveSettings({ shareSummary: true })}
                >
                  弹出来（玩了 2 分钟以上才弹）
                </button>
                <button
                  className={`chip ${settings.shareSummary === false ? 'on' : ''}`}
                  onClick={() => saveSettings({ shareSummary: false })}
                >
                  不自动弹（还能去截图页手动做）
                </button>
              </div>
              <p className="set-note">
                卡片上的「以后不自动弹」也会记在这里，想再打开就选左边那个。
              </p>
            </div>
          </section>

          {/* ── 下载与网络 ──────────────────────────── */}
          <section id="set-download" className="card set-card">
            <SetHead icon="⬇" title="下载与网络" desc="游戏版本、模组、整合包的下载方式；国内建议用镜像源。" />

            <div className="set-block">
              <div className="set-block-title">下载设置</div>
              <div className="set-grid">
                <label>
                  下载源
                  <Select
                    value={settings.downloadSource}
                    width="100%"
                    options={[
                      { value: 'mirror', label: '国内镜像 BMCLAPI（推荐）' },
                      { value: 'official', label: 'Mojang 官方（国内常被墙）' },
                      { value: 'auto', label: '自动测速' }
                    ]}
                    onChange={(v) => saveSettings({ downloadSource: v as 'official' | 'mirror' | 'auto' })}
                  />
                </label>
                <label>
                  下载线程数
                  <Select
                    value={String(settings.downloadThreads ?? 16)}
                    width="100%"
                    options={[
                      { value: '4', label: '4 线程（省带宽）' },
                      { value: '8', label: '8 线程' },
                      { value: '16', label: '16 线程（推荐）' },
                      { value: '32', label: '32 线程（激进）' }
                    ]}
                    onChange={(v) => saveSettings({ downloadThreads: Number(v) || 16 })}
                  />
                </label>
                <label>
                  限速（KB/s，0 = 不限）
                  <input
                    type="number"
                    min={0}
                    step={128}
                    value={settings.downloadLimitKbps ?? 0}
                    onChange={(e) => saveSettings({ downloadLimitKbps: Math.max(0, Number(e.target.value) || 0) })}
                  />
                </label>
                <label>
                  代理（HTTP / SOCKS5）
                  <input
                    value={settings.proxy}
                    placeholder="http://127.0.0.1:7890（留空 = 跟随系统代理）"
                    onChange={(e) => saveSettings({ proxy: e.target.value })}
                  />
                  <span className="hint">
                    开加速器 / VPN 的话一般留空就行（会跟随系统代理）。文件本体始终直连多线程下载，只
                    有接口和元数据走代理，这样最快。
                  </span>
                </label>
              </div>
            </div>

            <div className="set-block">
              <div className="set-block-title">保存位置</div>
              <label className="full">
                贴链接下载用的目录
                <div className="row">
                  <input
                    style={{ flex: 1 }}
                    placeholder="留空 = data/downloads"
                    value={settings.downloadDir ?? ''}
                    onChange={(e) => saveSettings({ downloadDir: e.target.value })}
                  />
                  <button
                    className="btn sm"
                    onClick={async () => {
                      const dir = await api.pickFolder()
                      if (dir) saveSettings({ downloadDir: dir })
                    }}
                  >
                    选择…
                  </button>
                </div>
              </label>
            </div>

            <div className="set-block">
              <div className="set-block-title">
                <span>测速与清理</span>
                <span className="muted small">临时文件只有下载中的半成品，删了不影响已装好的版本</span>
              </div>
              <div className="set-actions">
                <button
                  className="btn"
                  onClick={async () => {
                    setSpeed(undefined)
                    const res = await api.speedTest()
                    setSpeed(res)
                    toast(`建议使用${res.recommend === 'mirror' ? '镜像源' : '官方源'}`, 'success')
                  }}
                >
                  测一下哪个源快
                </button>
                {speed && (
                  <>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        await saveSettings({ downloadSource: speed.recommend })
                        toast(`已切换为${speed.recommend === 'mirror' ? '镜像源' : '官方源'}`, 'success')
                      }}
                    >
                      用最快的（{speed.recommend === 'mirror' ? 'BMCLAPI' : '官方'}）
                    </button>
                    <button className="btn sm ghost" onClick={() => setSpeed(undefined)}>
                      清除测速结果
                    </button>
                  </>
                )}
                <button
                  className="btn"
                  onClick={async () => {
                    const res = await api.cleanTemp()
                    toast(`清理了 ${res.removed} 个临时文件，释放 ${formatSize(res.freed)}`, 'success')
                  }}
                >
                  清理临时文件
                </button>
              </div>
              {speed && (
                <div className="speed-list" style={{ marginTop: 10 }}>
                  {speed.results.map((r) => (
                    <div className="speed-row" key={r.name}>
                      <span>{r.name}</span>
                      <span className={r.ok ? 'badge ok' : 'badge warn'}>{r.ok ? `${r.ms} ms` : '超时'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* ── 内存与性能 ──────────────────────────── */}
          <section id="set-performance" className="card set-card">
            <SetHead
              icon="⚡"
              title="内存与性能"
              desc="每个实例默认用这里的全局内存值，也可以在「实例 → 设置」里单独覆盖。"
            />

            <div className="set-block">
              <div className="set-block-title">内存分配（MB）</div>
              <div className="set-grid two">
                <label>
                  最大内存
                  <input
                    type="number"
                    value={settings.maxMemory}
                    onChange={(e) => saveSettings({ maxMemory: Number(e.target.value) || 2048 })}
                  />
                </label>
                <label>
                  最小内存
                  <input
                    type="number"
                    value={settings.minMemory}
                    onChange={(e) => saveSettings({ minMemory: Number(e.target.value) || 1024 })}
                  />
                </label>
              </div>
              <p className="set-note">
                原版 1–4G 够用，装大型整合包再往上加；最小内存一般给最大的一半就行。
                {current ? ` 当前实例：${current.name}` : ''}
              </p>
            </div>

            <div className="set-block">
              <div className="set-block-title">额外 JVM 参数</div>
              <label className="full">
                <input
                  value={jvmArgs}
                  placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8"
                  onChange={(e) => setJvmArgs(e.target.value)}
                  onBlur={() => saveSettings({ extraJvmArgs: jvmArgs.split(/\s+/).filter(Boolean) })}
                />
              </label>
              <div className="set-actions" style={{ marginTop: 10 }}>
                {JVM_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    className="btn sm"
                    onClick={() => {
                      setJvmArgs(preset.value)
                      saveSettings({ extraJvmArgs: preset.value.split(/\s+/).filter(Boolean) })
                    }}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <p className="set-note">留空就是启动器的默认参数；不确定就别动，改错了可以用「清空」.</p>
            </div>
          </section>

          {/* ── 数据目录 ────────────────────────────── */}
          <section id="set-data" className="card set-card">
            <SetHead
              icon="📁"
              title="数据目录"
              desc="实例、存档、账号、下载缓存全在这个目录里。换目录只是换指向，不复制也不删文件。"
            />

            <div className="set-block">
              <div className="set-block-title">当前位置</div>
              <div className="set-path">
                <code title={settings.dataDir || dataDir}>{settings.dataDir || dataDir}</code>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const dir = await api.pickFolder()
                    if (!dir) return
                    const oldDir = settings.dataDir || dataDir
                    const norm = (s: string) => s.replace(/[\\/]+$/, '').toLowerCase()
                    if (oldDir && norm(dir) === norm(oldDir)) {
                      toast('选的还是当前目录，没换', 'info')
                      return
                    }
                    // 旧目录里还有东西的话，问一句要不要一起搬过去（只复制，旧目录原样留着）
                    let migrate = false
                    try {
                      const list = await api.dataDiscover()
                      const old = list.find((d) => d.active)
                      if (old && (old.instances > 0 || old.accounts > 0)) {
                        if (norm(dir).startsWith(norm(old.dir) + '\\')) {
                          toast('新目录在旧目录里面，不搬（会自己复制自己）', 'info')
                        } else {
                          migrate = await askConfirm({
                            title: '把旧目录的数据搬过去？',
                            message:
                              `旧目录 ${old.dir} 里还有 ${old.instances} 个实例、${old.accounts} 个账号。` +
                              `要复制到新目录 ${dir} 吗？只复制不删旧目录，确认新目录没问题后旧目录你自己清理。`,
                            okText: '复制过去',
                            cancelText: '不搬，只要空目录'
                          })
                        }
                      }
                    } catch {
                      /* 查不到旧数据就算了，直接换 */
                    }
                    try {
                      const r = await api.setDataDir(dir)
                      await saveSettings({})
                      await Promise.all([refreshInstances(), refreshAccounts()])
                      setPinfo(await api.dataSharedInfo())
                      refreshFound()
                      toast(`数据目录已改成 ${r.dir}（那边有 ${r.instances} 个实例，重启后也是这个）`, 'success')
                      if (migrate && oldDir) {
                        toast('开始把旧目录的数据复制过来，进度看任务列表', 'info')
                        try {
                          const m = await api.migrateData(oldDir)
                          await Promise.all([refreshInstances(), refreshAccounts()])
                          setPinfo(await api.dataSharedInfo())
                          refreshFound()
                          toast(
                            `迁移完成：复制 ${m.copied} 个文件（${formatSize(m.bytes)}）` +
                              `${m.skipped ? `，跳过 ${m.skipped} 个同名的` : ''}` +
                              `${m.accounts ? `，并入 ${m.accounts} 个账号` : ''}`,
                            'success'
                          )
                        } catch (e) {
                          toast(
                            `迁移失败：${(e as Error).message}。数据目录已经换过去了，旧目录还在，可以手动复制`,
                            'error'
                          )
                        }
                      }
                    } catch (e) {
                      toast(`换目录失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  更换数据目录
                </button>
                <button className="btn sm ghost" onClick={() => api.openPath(settings.dataDir || dataDir)}>
                  打开
                </button>
              </div>
              {health?.insideInstall && (
                <p className="small warn-text">
                  ⚠ 这个目录在安装目录（{health.installDir}）里面：更新 / 卸载安装包时会被整个清掉，
                  游戏版本、存档、账号都会没。请点「更换数据目录」选一个安装目录外面的文件夹（例如 <code>D:\WFMC-Data</code>）。
                </p>
              )}
              {pinfo?.portable && (
                <div className="set-actions" style={{ marginTop: 10 }}>
                  <span className="muted small">便携版数据来源：</span>
                  <button
                    className={`btn sm ${pinfo.usingShared ? 'primary' : ''}`}
                    onClick={async () => {
                      const r = await api.useSharedData(true)
                      await saveSettings({ dataDir: r.dir, useSharedData: true })
                      await Promise.all([refreshInstances(), refreshAccounts()])
                      setPinfo(await api.dataSharedInfo())
                      toast(`已切到本机数据：${r.instances} 个实例`, 'success')
                    }}
                  >
                    用本机的（{pinfo.sharedInstances} 个实例）
                  </button>
                  <button
                    className={`btn sm ${!pinfo.usingShared ? 'primary' : ''}`}
                    onClick={async () => {
                      const r = await api.useSharedData(false)
                      await saveSettings({ dataDir: r.dir, useSharedData: false })
                      await Promise.all([refreshInstances(), refreshAccounts()])
                      setPinfo(await api.dataSharedInfo())
                      toast('已切回便携版自己的目录', 'success')
                    }}
                  >
                    用便携版自己的（{pinfo.ownInstances} 个实例）
                  </button>
                </div>
              )}
            </div>

            <div className="set-block">
              <div className="set-block-title">
                <span>找回旧数据</span>
                <span className="set-actions">
                  <button
                    className="btn sm ghost"
                    disabled={scanning}
                    title="只往每个盘的子目录里找两层，跳过系统目录"
                    onClick={async () => {
                      setScanning(true)
                      try {
                        const hits = await api.dataScanDrives()
                        if (!hits.length) {
                          toast('所有盘都扫过了，没找到别的数据目录', 'info')
                          return
                        }
                        mergeFound(hits)
                        toast(`扫到 ${hits.length} 个数据目录`, 'success')
                      } catch (e) {
                        toast(`扫描失败：${friendlyError(e)}`, 'error')
                      } finally {
                        setScanning(false)
                      }
                    }}
                  >
                    {scanning ? '扫描中…' : '扫描所有磁盘'}
                  </button>
                  <button
                    className="btn sm ghost"
                    title="知道目录在哪就直接挑，不用全盘扫"
                    onClick={async () => {
                      const dir = await api.pickFolder()
                      if (!dir) return
                      try {
                        const d = await api.dataInspectDir(dir)
                        if (!d.instances && !d.accounts) {
                          toast('这个目录里没有实例也没有账号，可能不是数据目录', 'info')
                          return
                        }
                        mergeFound([d])
                        toast(`已加入：${d.instances} 个实例 · ${d.accounts} 个账号`, 'success')
                      } catch (e) {
                        toast(`读不了这个目录：${friendlyError(e)}`, 'error')
                      }
                    }}
                  >
                    选择目录…
                  </button>
                </span>
              </div>
              {foundData.length === 0 ? (
                <p className="muted small">没找到别的数据目录。</p>
              ) : (
                <div className="stat-bars">
                  {foundData.map((d) => (
                    <div className="stat-row" key={d.dir}>
                      <span className="ellipsis" title={d.dir}>
                        {d.name}
                        {d.active && (
                          <span className="badge ok" style={{ marginLeft: 6 }}>
                            在用
                          </span>
                        )}
                      </span>
                      <span className="muted small">
                        {d.instances} 个实例 · {d.accounts} 个账号
                      </span>
                      <button
                        className="btn sm"
                        disabled={d.active}
                        onClick={async () => {
                          try {
                            const r = await api.dataAdopt(d.dir)
                            await saveSettings({})
                            await Promise.all([refreshInstances(), refreshAccounts()])
                            setPinfo(await api.dataSharedInfo())
                            refreshFound()
                            toast(`已切到 ${r.dir}：${r.instances} 个实例、${r.accounts} 个账号`, 'success')
                          } catch (e) {
                            toast(`切换失败：${(e as Error).message}`, 'error')
                          }
                        }}
                      >
                        {d.active ? '在用' : '用这份'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <p className="set-note">
                装新版本、便携版和安装版换来换去，数据不会真的没掉 —— 只是「指向的目录」变了。
                这里列出机器上所有存过数据的目录；账号每次启动都会自动并到一起，不用重新添加。
                固定位置里没有的话，点「扫描所有磁盘」往别的盘里找（每个盘只看两层，F:\data 这种能扫到）。
              </p>
            </div>

            <div className="set-block">
              <div className="set-block-title">
                <span>清理与占用</span>
                <span className="muted small">只清记录，游戏文件一个不动</span>
              </div>
              <div className="set-actions">
                <button
                  className="btn ghost sm"
                  disabled={dataSize === null}
                  onClick={async () => {
                    setDataSize(null)
                    const r = await api.dataSize().catch(() => null)
                    setDataSize(r ? { bytes: r.bytes, partial: r.partial } : null)
                    if (r) toast(`数据目录占 ${formatSize(r.bytes)}${r.partial ? ' 以上（超时没走完）' : ''}`, 'success')
                  }}
                >
                  {dataSize ? `占用 ${formatSize(dataSize.bytes)}${dataSize.partial ? ' +' : ''} · 重新统计` : '算一下占用…'}
                </button>
                <button
                  className="btn danger sm"
                  disabled={accounts.length === 0}
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: '清空账号',
                      message: `当前数据目录里的 ${accounts.length} 个账号（离线 / 正版 / 外置）会被全部删掉，实例和存档不动。`,
                      okText: '清空账号',
                      danger: true
                    })
                    if (!ok) return
                    try {
                      const r = await api.clearData('accounts')
                      await Promise.all([refreshAccounts(), saveSettings({})])
                      toast(`已清空 ${r.cleared} 个账号（备份 accounts.json.bak）`, 'success')
                    } catch (e) {
                      toast(`清空失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  清空账号（{accounts.length}）
                </button>
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: '清空游玩记录',
                      message: '把所有实例的「累计游玩时长 / 最近启动时间」归零，存档和游戏本体不动。',
                      okText: '清空记录',
                      danger: true
                    })
                    if (!ok) return
                    try {
                      const r = await api.clearData('playtime')
                      await refreshInstances()
                      toast(`已清空 ${r.cleared} 个实例的游玩记录`, 'success')
                    } catch (e) {
                      toast(`清空失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  清空游玩记录
                </button>
              </div>
              <p className="set-note">
                删之前会把旧的 accounts.json 留成 <code>.bak</code>，反悔了还能捞回来。
              </p>
            </div>
            <div className="set-block">
              <div className="set-block-title">
                <span>危险操作</span>
                <span className="muted small">删了就没了，删前请看清</span>
              </div>
              <div className="set-actions">
                <button
                  className="btn danger sm"
                  disabled={wiping}
                  onClick={async () => {
                    const dir = settings.dataDir || dataDir
                    const ok1 = await askConfirm({
                      title: '一键删除全部数据',
                      message:
                        `即将清空 ${dir} 里的全部内容：所有实例、游戏版本、mods、资源包、存档、截图、账号、日志。` +
                        '这不是「清空记录」，是真的把文件删掉，删完没法恢复。账号会先留一份 accounts.json.bak。',
                      okText: '我明白，继续',
                      danger: true
                    })
                    if (!ok1) return
                    const ok2 = await askConfirm({
                      title: '最后一次确认',
                      message: '真的要删吗？想留存档的话先取消，点上面「打开」把 saves 复制出去，或者用「更换数据目录」换个地方再删。',
                      okText: '删除全部数据',
                      cancelText: '不了',
                      danger: true
                    })
                    if (!ok2) return
                    setWiping(true)
                    try {
                      const r = await api.wipeData()
                      await Promise.all([refreshInstances(), refreshAccounts(), saveSettings({})])
                      refreshFound()
                      setDataSize(null)
                      toast(
                        `已清空数据目录（${r.removed} 项）` +
                          `${r.failed ? `，${r.failed} 项没删掉（可能被游戏/程序占用，关掉再试）` : ''}` +
                          `${r.accountBackup ? '，账号已备份成 .bak' : ''}`,
                        r.failed ? 'error' : 'success'
                      )
                    } catch (e) {
                      toast(`删除失败：${(e as Error).message}`, 'error')
                    } finally {
                      setWiping(false)
                    }
                  }}
                >
                  {wiping ? '正在删除…' : '一键删除全部数据（含账号）'}
                </button>
              </div>
              <p className="set-note">
                等于把启动器恢复到刚装好的样子：实例列表、游戏版本、mods、存档、账号全部清掉，程序本身不动。
                旧目录不会自动删，删完目录还在，可以直接用。
              </p>
            </div>
{/* 占用明细：哪块占地方、哪块能一键清 */}
            <div className="set-block">
              <div className="set-block-title">
                <span>占用明细</span>
                <span className="muted small">清缓存 / 下载 / 日志，游戏文件不动</span>
              </div>
              <div className="set-actions">
                <button
                  className="btn ghost sm"
                  disabled={usageBusy}
                  onClick={async () => {
                    setUsageBusy(true)
                    try {
                      setUsage(await api.dataUsage())
                    } catch (e) {
                      toast(`统计失败：${(e as Error).message}`, 'error')
                    } finally {
                      setUsageBusy(false)
                    }
                  }}
                >
                  {usageBusy ? '正在统计…' : usage ? '重新统计' : '算一下各块占多少'}
                </button>
                {usage && (
                  <span className="muted small">
                    合计 {formatSize(usage.total.bytes)}
                    {usage.partial ? ' +' : ''} · {usage.total.files} 个文件
                  </span>
                )}
              </div>
              {usage && (
                <div className="usage-list">
                  {usage.items.map((it) => (
                    <div className="usage-row" key={it.key}>
                      <div className="usage-head">
                        <span className="usage-label">{it.label}</span>
                        <b className="usage-size">{formatSize(it.bytes)}</b>
                        <span className="muted small">{it.files} 个文件</span>
                        {it.cleanable && (
                          <button
                            className="btn sm ghost"
                            disabled={it.bytes === 0}
                            onClick={async () => {
                              const ok = await askConfirm({
                                title: `清理${it.label}`,
                                message: `${it.hint ?? ''}\n\n会删掉 ${it.files} 个文件，空出 ${formatSize(it.bytes)}。这一步没法撤销。`,
                                okText: '清理',
                                danger: true
                              })
                              if (!ok) return
                              try {
                                const r = await api.cleanUsage(it.key as 'downloads' | 'cache' | 'logs')
                                toast(`已清理 ${r.files} 个文件，空出 ${formatSize(r.bytes)}`, 'success')
                                setUsage(await api.dataUsage())
                                setDataSize(null)
                              } catch (e) {
                                toast(`清理失败：${(e as Error).message}`, 'error')
                              }
                            }}
                          >
                            清理
                          </button>
                        )}
                      </div>
                      <div className="muted small usage-hint">{it.hint ?? it.path}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
{/* 硬链接去重：模组 / 资源包按内容共享一份，多个实例不再各存一遍 */}
            <div className="set-block">
              <div className="set-block-title">
                <span>重复文件去重</span>
                <span className="muted small">模组、资源包、光影按内容共享一份，多个实例不再各存一遍</span>
              </div>
              <div className="set-actions">
                <button className="btn ghost sm" disabled={dedupeBusy} onClick={refreshBlobs}>
                  {dedupeBusy ? '正在统计…' : blobs ? '重新统计' : '算一下省了多少'}
                </button>
                <button className="btn ghost sm" disabled={dedupeBusy} onClick={runDedupe}>
                  立即去重
                </button>
                <button
                  className="btn ghost sm"
                  disabled={dedupeBusy || !blobs || blobs.orphans === 0}
                  onClick={runGcBlobs}
                >
                  清理孤立文件
                </button>
              </div>
              {blobs && !blobs.partial && (
                <div className="muted small usage-hint">
                  {`共 ${formatSize(blobs.bytes)} 内容，省下 ${formatSize(blobs.savedBytes)}；${blobs.links} 处引用复用，${blobs.orphans} 个孤立文件（${formatSize(blobs.orphanBytes)}）`}
                </div>
              )}
            </div>
          </section>
          <section id="set-java" className="card set-card">
            <SetHead
              icon="☕"
              title="Java 运行时"
              desc="1.20.5+ 要 Java 21，1.18–1.20.4 要 Java 17，1.17 要 16，更老的版本用 Java 8。留空时启动器会按版本自动挑。"
            />

            <div className="set-block">
              <div className="set-block-title">已检测到的 Java</div>
              <div className="set-actions">
                <Select
                  value={settings.javaPath}
                  width={420}
                  placeholder="自动选择（推荐）"
                  options={[
                    { value: '', label: '自动选择（推荐）' },
                    ...javas.map((j) => ({ value: j.path, label: `Java ${j.majorVersion}`, hint: j.path }))
                  ]}
                  onChange={(v) => saveSettings({ javaPath: v })}
                />
                <button className="btn" onClick={scan}>
                  重新扫描
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await api.pickFile([{ name: 'Java 可执行文件', extensions: ['exe'] }, { name: '所有文件', extensions: ['*'] }])
                    if (p) await saveSettings({ javaPath: p })
                  }}
                >
                  手动指定 java.exe
                </button>
              </div>
            </div>

            <div className="set-block">
              <div className="set-block-title">下载官方运行时</div>
              <div className="set-actions">
                {[
                  { id: 'java-runtime-delta', label: '下载 Java 21 运行时' },
                  { id: 'java-runtime-gamma', label: '下载 Java 17 运行时' },
                  { id: 'jre-legacy', label: '下载 Java 8 运行时' }
                ].map((item) => (
                  <button
                    key={item.id}
                    className="btn"
                    disabled={javaBusy}
                    onClick={async () => {
                      setJavaBusy(true)
                      setJavaMsg('正在读取文件清单…')
                      try {
                        const p = await api.installJava(item.id)
                        await saveSettings({ javaPath: p })
                        await scan()
                        toast(`已安装：${p}`, 'success')
                        setJavaMsg(`已装好：${p}`)
                      } catch (e) {
                        toast(`安装失败：${(e as Error).message}`, 'error')
                        setJavaMsg(`安装失败：${(e as Error).message}`)
                      } finally {
                        setJavaBusy(false)
                      }
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {javaMsg && <p className="set-note">{javaMsg}</p>}
            </div>
          </section>

          {/* ── 账号 ────────────────────────────────── */}
          <section id="set-accounts" className="card set-card">
            <SetHead
              icon="👤"
              title="账号"
              desc="离线账号就能玩单机；正版 / 外置登录在联机和皮肤站才用得上。账号列表跟着数据目录走。"
            />

            <div className="set-block">
              <div className="set-block-title">
                <span>已有账号</span>
                <span className="muted small">共 {accounts.length} 个</span>
              </div>
              <div className="list">
                {accounts.length === 0 && (
                  <div className="muted small">还没有账号，先添加一个离线账号就能玩单机。</div>
                )}
                {accounts.map((a) => (
                  <div className="row-between" key={a.id}>
                    <span>
                      {a.name}{' '}
                      <span className="muted small">
                        ({a.type === 'microsoft' ? '微软正版' : a.type === 'yggdrasil' ? `外置登录 ${a.server ?? ''}` : '离线'})
                      </span>
                      {settings.activeAccountId === a.id && <span className="badge ok">使用中</span>}
                    </span>
                    <span className="row">
                      <button
                        className="btn sm"
                        onClick={async () => {
                          await api.setActiveAccount(a.id)
                          await saveSettings({ activeAccountId: a.id })
                          toast(`已切换到 ${a.name}`, 'success')
                        }}
                      >
                        设为当前
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={async () => {
                          await api.removeAccount(a.id)
                          await refreshAccounts()
                        }}
                      >
                        移除
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="set-block">
              <div className="set-block-title">添加账号</div>
              <div className="set-actions">
                <input
                  value={offlineName}
                  onChange={(e) => setOfflineName(e.target.value)}
                  placeholder="离线用户名"
                  style={{ width: 180 }}
                />
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      await api.addOffline(offlineName.trim() || 'Steve')
                      await refreshAccounts()
                      toast('离线账号已添加', 'success')
                    } catch (e) {
                      toast(`添加失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  添加离线账号
                </button>
                <button
                  className="btn"
                  disabled={msLoading}
                  onClick={async () => {
                    setMsLoading(true)
                    try {
                      const info = await api.msStart()
                      setMsInfo(info)
                      await api.openExternal(info.verificationUri)
                      const account = await api.msComplete(info.deviceCode, 5, info.expiresIn)
                      await refreshAccounts()
                      setMsInfo(undefined)
                      toast(`正版登录成功：${account.name}`, 'success')
                    } catch (e) {
                      toast(`正版登录失败：${(e as Error).message}`, 'error')
                    } finally {
                      setMsLoading(false)
                    }
                  }}
                >
                  {msLoading ? '等待微软授权…' : '微软正版登录'}
                </button>
              </div>
              {msInfo && (
                <div className="card inner">
                  <div>
                    打开 <a onClick={() => api.openExternal(msInfo.verificationUri)}>{msInfo.verificationUri}</a>
                    ，输入代码：<b className="code">{msInfo.userCode}</b>
                  </div>
                  <div className="muted small" style={{ marginTop: 6 }}>
                    提示：接下来是微软官方页面，标题可能写着「Minecraft」——内置的是微软给 Minecraft 的公共应用 ID，不是我们自己的。
                  </div>
                  <div className="muted small">
                    想让它显示成 WFMC 的名字和图标，见下面「高级」里注册自己的 Azure 应用。
                  </div>
                </div>
              )}
            </div>

            <details className="advanced-ms">
              <summary className="muted small">
                高级：用自己的 Azure 应用 ID（默认已内置公共 ID，一般不用管）
              </summary>
              <label className="full" style={{ marginTop: 8 }}>
                Microsoft 客户端 ID（留空 = 用内置公共 ID）
                <input
                  value={settings.microsoftClientId}
                  placeholder="留空即可；登录报 client id 错误时再填自己的"
                  onChange={(e) => saveSettings({ microsoftClientId: e.target.value })}
                />
              </label>
              <p className="muted small">
                拿自己的 ID：Azure 门户 → 应用注册 → 新注册 → 账户类型选「仅个人 Microsoft 账户」→
                身份验证里开启「允许公共客户端流」→ 复制「应用程序(客户端) ID」。
              </p>
            </details>

            <div className="set-block">
              <div className="set-block-title">
                <span>外置登录（authlib-injector / 皮肤站）</span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    try {
                      const info = await api.ensureInjector()
                      toast(`authlib-injector 就绪：${info.version ?? ''}`, 'success')
                    } catch (e) {
                      toast(`下载失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  下载 authlib-injector
                </button>
              </div>
              <div className="set-grid">
                <label>
                  Yggdrasil API 根地址
                  <input
                    value={yggApi}
                    placeholder="https://littleskin.cn/api/yggdrasil"
                    onChange={(e) => setYggApi(e.target.value)}
                  />
                </label>
                <label>
                  邮箱 / 用户名
                  <input value={yggUser} onChange={(e) => setYggUser(e.target.value)} />
                </label>
                <label>
                  密码
                  <input type="password" value={yggPass} onChange={(e) => setYggPass(e.target.value)} />
                </label>
              </div>
              <div className="set-actions" style={{ marginTop: 10 }}>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      const res = await api.loginYggdrasil({ apiRoot: yggApi, username: yggUser, password: yggPass })
                      await api.setActiveAccount(res.account.id)
                      await refreshAccounts()
                      await saveSettings({ activeAccountId: res.account.id })
                      toast(`外置登录成功：${res.account.name}（去「皮肤 · 外置登录」页管皮肤）`, 'success')
                    } catch (e) {
                      toast(`外置登录失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  登录外置账号
                </button>
                <span className="muted small">登录后启动游戏会自动注入 javaagent，连上该皮肤站的验证。</span>
              </div>
            </div>
          </section>

          {/* ── CurseForge ──────────────────────────── */}
          <section id="set-curseforge" className="card set-card">
            <SetHead
              icon="🔑"
              title="CurseForge"
              desc="在线搜索和安装 CurseForge 整合包要 API Key；Modrinth 不需要。Key 只存在本机设置里，不会上传。"
            />
            <label className="full">
              API Key
              <div className="key-row">
                <input
                  type={cfKeyShown ? 'text' : 'password'}
                  value={cfKey}
                  placeholder="$2a$10$…"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    setCfKey(e.target.value)
                    setCfKeyState('dirty')
                  }}
                />
                <button
                  type="button"
                  className="btn sm ghost key-eye"
                  title={cfKeyShown ? '隐藏' : '显示'}
                  onClick={() => setCfKeyShown((v) => !v)}
                >
                  {cfKeyShown ? '🙈' : '👁'}
                </button>
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={!cfKeyState || cfKeyState === 'saving'}
                  onClick={saveCfKey}
                >
                  {cfKeyState === 'saving' ? '保存中…' : '保存'}
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={!cfKey.trim() || cfTesting}
                  onClick={testCfKey}
                >
                  {cfTesting ? '测试中…' : '测试'}
                </button>
              </div>
            </label>
            <p className="set-note">
              {cfKeyState === 'saved'
                ? `已保存（尾号 ${cfKey.trim().slice(-4)}），去「模组 · 光影」页就能搜 CurseForge 了。`
                : cfKeyState === 'dirty'
                  ? '改完记得点「保存」，不保存等于没填。'
                  : settings.curseforgeApiKey
                    ? `当前已保存（尾号 ${settings.curseforgeApiKey.slice(-4)}）`
                    : '还没填。在 console.curseforge.com 免费申请，填完点「保存」。'}
            </p>
          </section>

          {/* ── AI 助手（MCP）：让外部 AI 客户端直连启动器 ── */}
          <section id="set-mcp" className="card set-card">
            <McpPanel />
          </section>

          {/* ── 云同步（自建服务端）：账号 + 备份在同一个分区里 ── */}
          <section id="set-cloud" className="card set-card">
            <div id="set-wfmc">
              <WfmcAccountPanel variant="cloud" />
            </div>
            <CloudPanel />
          </section>

          {/* ── 更新 ────────────────────────────────── */}
          <section id="set-update" className="set-card">
            <UpdateCenter />
          </section>

          {/* ── 致谢 ────────────────────────────────── */}
          <section id="set-credits" className="card set-card">
            <SetHead
              icon="💖"
              title="致谢 · 参考与依赖的开源项目"
              desc="这个启动器是站在这些人的肩膀上做出来的，可以直接点名字去他们的仓库。同类启动器只借鉴了功能设计与规则思路，代码都是自己写的；带「依赖库」标签的是直接引入的包。"
            />
            {(
              [
                ['launcher', '同类启动器（借鉴设计）'],
                ['library', '依赖库'],
                ['data', '数据源 / 开放 API'],
                ['asset', '品牌素材']
              ] as [CreditKind, string][]
            ).map(([kind, label]) => (
              <div className="set-block" key={kind}>
                <div className="set-block-title">{CREDIT_KIND_LABEL[kind] ?? label}</div>
                <div className="credit-list">
                  {CREDITS.filter((c) => c.kind === kind).map((c) => (
                    <div className="credit-item" key={c.name}>
                      <div className="credit-head">
                        <a
                          onClick={() => {
                            if (/^https?:/i.test(c.url)) api.openExternal(c.url)
                            else api.openPath(c.url)
                          }}
                        >
                          {c.name}
                        </a>
                        <span className="badge">{c.license}</span>
                      </div>
                      <div className="muted small">
                        <b>{c.author}</b> — {c.borrowed}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>

          {/* ── 关于 ────────────────────────────────── */}
          <section id="set-about" className="card set-card">
            <SetHead icon="ℹ" title="关于" desc={`WFMC ${appVersion} · WanFan Minecraft Launcher · Electron + React + @xmcl 内核（MIT）`} />
            <div className="set-actions">
              <button className="btn" onClick={() => setShowDisclaimer(true)}>
                查看免责声明
              </button>
              {uninstaller && (
                <button
                  className="btn danger"
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: '卸载 WFMC',
                      message: '将启动卸载程序并退出。你的游戏实例、存档在 data 目录，默认不会被删除（卸载器会问一次）。',
                      okText: '启动卸载',
                      danger: true
                    })
                    if (!ok) return
                    try {
                      await api.runUninstaller()
                    } catch (e) {
                      toast(friendlyError(e), 'error')
                    }
                  }}
                >
                  卸载 WFMC
                </button>
              )}
            </div>
            <p className="set-note">
              第三方启动器，与 Mojang / Microsoft 无关；使用风险自担（详见弹窗与 DISCLAIMER.md）。
              <br />
              图标与动画来自万凡科技品牌包（靛紫电光）；感谢上面名单里的每一位作者。
              <br />
              内置的 4 首背景音乐是程序合成的原创曲（生成脚本 scripts/gen-music.py 随源码公开），
              <b>不含 Minecraft 原版配乐</b> —— 原版音乐版权归 C418 / Mojang，不能随安装包分发；
              想听原版请把音频文件放进 data/music，或用播放器里的「导入音乐」。
            </p>
          </section>
        </div>
      </div>

      {showDisclaimer && <Disclaimer mode="view" onClose={() => setShowDisclaimer(false)} />}
    </div>
  )
}
