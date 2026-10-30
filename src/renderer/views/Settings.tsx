import React, { useEffect, useState } from 'react'
import { api, formatSize, friendlyError } from '../api'
import type { UpdateInfo } from '../api'
import { useLauncher, useT } from '../store'
import type { JavaInfo, ThemeMode } from '../../shared/types'
import { CREDITS, CREDIT_KIND_LABEL, type CreditKind } from '../../shared/credits'
import Select from '../components/Select'
import Disclaimer from './Disclaimer'
import UpdateCenter from './UpdateCenter'

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

export default function SettingsView() {
  const { settings, saveSettings, dataDir, accounts, refreshAccounts, refreshInstances, toast, current, resolvedTheme, setTheme, askConfirm } = useLauncher()
  const [pinfo, setPinfo] = useState<Awaited<ReturnType<typeof api.dataSharedInfo>> | undefined>()
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

  if (!settings) return <div className="page">加载中…</div>

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('设置', 'Settings')}</h1>
          <p className="muted">数据目录：{settings.dataDir || dataDir}</p>
        </div>
      </header>

      <div className="card">
        <h3>外观</h3>
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
        <p className="muted small">当前实际生效：{resolvedTheme === 'light' ? '浅色' : '深色'}</p>

        <div className="mini-label" style={{ marginTop: 12 }}>主题自定义</div>
        <div className="row wrap">
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
              style={{ background: c }}
              onClick={() => saveSettings({ themeCustom: { ...settings.themeCustom, accent: c } })}
            />
          ))}
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            圆角 {settings.themeCustom?.radius ?? 14}px
            <input
              type="range"
              min={0}
              max={26}
              value={settings.themeCustom?.radius ?? 14}
              onChange={(e) =>
                saveSettings({ themeCustom: { ...settings.themeCustom, radius: Number(e.target.value) } })
              }
              style={{ width: 120 }}
            />
          </label>
          <button
            className="btn sm"
            onClick={async () => {
              const file = await api.pickFile()
              if (file) await saveSettings({ themeCustom: { ...settings.themeCustom, wallpaper: file } })
            }}
          >
            选背景图
          </button>
          <button
            className="btn sm ghost"
            onClick={() => saveSettings({ themeCustom: {} })}
          >
            恢复默认外观
          </button>
        </div>

        <div className="mini-label" style={{ marginTop: 12 }}>关闭窗口时</div>
        <div className="row">
          <button
            className={`chip ${(settings.closeToTray ?? true) ? 'on' : ''}`}
            onClick={() => saveSettings({ closeToTray: true })}
          >
            缩到右下角托盘（服务端继续跑）
          </button>
          <button
            className={`chip ${!(settings.closeToTray ?? true) ? 'on' : ''}`}
            onClick={() => saveSettings({ closeToTray: false })}
          >
            直接退出程序
          </button>
        </div>

        <div className="mini-label" style={{ marginTop: 12 }}>语言</div>
        <div className="row">
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
          <span className="muted small">已覆盖：导航 / 页面标题 / 主要按钮（正文文案仍在逐页补）</span>
        </div>
      </div>

      <div className="card">
        <h3>下载与性能</h3>
        <div className="form-grid">
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
            value={String(settings.downloadThreads ?? 48)}
            width="100%"
            options={[
            { value: '8', label: '8 线程（省带宽）' },
            { value: '16', label: '16 线程' },
            { value: '32', label: '32 线程' },
            { value: '48', label: '48 线程（推荐）' },
            { value: '64', label: '64 线程' },
            { value: '96', label: '96 线程（激进）' },
            { value: '128', label: '128 线程（极限）' }
            ]}
            onChange={(v) => saveSettings({ downloadThreads: Number(v) || 48 })}
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
          <label style={{ gridColumn: '1 / -1' }}>
            下载保存目录（贴链接下载用）
            <div className="row">
              <input
                style={{ flex: 1 }}
                placeholder="留空 = data/downloads"
                value={settings.downloadDir ?? ''}
                onChange={(e) => saveSettings({ downloadDir: e.target.value })}
              />
              <button className="btn sm" onClick={async () => { const dir = await api.pickFolder(); if (dir) saveSettings({ downloadDir: dir }) }}>
                选择…
              </button>
            </div>
          </label>
          <label>
            最大内存 (MB)
            <input
              type="number"
              value={settings.maxMemory}
              onChange={(e) => saveSettings({ maxMemory: Number(e.target.value) || 2048 })}
            />
          </label>
          <label>
            最小内存 (MB)
            <input
              type="number"
              value={settings.minMemory}
              onChange={(e) => saveSettings({ minMemory: Number(e.target.value) || 1024 })}
            />
          </label>
          <label>
            代理（HTTP / SOCKS5）
            <input
              value={settings.proxy}
              placeholder="http://127.0.0.1:7890（留空 = 直连）"
              onChange={(e) => saveSettings({ proxy: e.target.value })}
            />
          </label>
          <label>
            额外 JVM 参数
            <input
              value={jvmArgs}
              placeholder="-XX:+UseG1GC -Dfile.encoding=UTF-8"
              onChange={(e) => setJvmArgs(e.target.value)}
              onBlur={() => saveSettings({ extraJvmArgs: jvmArgs.split(/\s+/).filter(Boolean) })}
            />
          </label>
        </div>
        <div className="row wrap" style={{ marginBottom: 8 }}>
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
          <div className="speed-list">
            {speed.results.map((r) => (
              <div className="speed-row" key={r.name}>
                <span>{r.name}</span>
                <span className={r.ok ? 'badge ok' : 'badge warn'}>{r.ok ? `${r.ms} ms` : '超时'}</span>
              </div>
            ))}
          </div>
        )}
        <div className="row wrap" style={{ marginBottom: 8 }}>
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
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              const dir = await api.pickFolder()
              if (dir) await saveSettings({ dataDir: dir })
            }}
          >
            更换数据目录
          </button>
          <button className="btn ghost" onClick={() => api.openPath(settings.dataDir || dataDir)}>
            打开数据目录
          </button>
        </div>
        {pinfo?.portable && (
          <div className="row wrap" style={{ marginTop: 8 }}>
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
            <span className="muted small">只是换指向，不复制也不删文件。</span>
          </div>
        )}
        <p className="muted small">
          每个实例默认用全局内存值，也可以到「实例 → 设置」单独覆盖。
          {current ? ` 当前实例：${current.name}` : ''}
        </p>
      </div>

      <div className="card">
        <h3>Java 运行时</h3>
        <div className="row wrap">
          <Select
            value={settings.javaPath}
            width={420}
            placeholder="自动选择（推荐）"
            options={[{ value: '', label: '自动选择（推荐）' }, ...javas.map((j) => ({ value: j.path, label: `Java ${j.majorVersion}`, hint: j.path }))]}
            onChange={(v) => saveSettings({ javaPath: v })}
          />
          <button className="btn" onClick={scan}>
            重新扫描
          </button>
          <button
            className="btn"
            onClick={async () => {
              const p = await api.pickFile()
              if (p) await saveSettings({ javaPath: p })
            }}
          >
            手动指定 java.exe
          </button>
        </div>
        <div className="row wrap">
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
        {javaMsg && <div className="muted small" style={{ marginBottom: 6 }}>{javaMsg}</div>}
        <p className="muted small">
          1.20.5+ 要 Java 21，1.18–1.20.4 要 Java 17，1.17 要 16，更老的版本用 Java 8。留空时启动器会按版本自动挑。
        </p>
      </div>

      <div className="card">
        <h3>账号</h3>
        <div className="row wrap">
          <input value={offlineName} onChange={(e) => setOfflineName(e.target.value)} placeholder="离线用户名" />
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
            打开 <a onClick={() => api.openExternal(msInfo.verificationUri)}>{msInfo.verificationUri}</a>，输入代码：
            <b className="code">{msInfo.userCode}</b>
          </div>
        )}
        <div className="list">
          {accounts.length === 0 && <div className="muted small">还没有账号，先添加一个离线账号就能玩单机。</div>}
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
        <details className="advanced-ms" style={{ marginTop: 10 }}>
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

        <div className="row-between" style={{ marginTop: 16 }}>
          <b>外置登录（authlib-injector / 皮肤站）</b>
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
        <div className="form-grid" style={{ marginTop: 8 }}>
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
        <div className="row">
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

      <div className="card">
        <h3>CurseForge</h3>
        <label className="full">
          API Key（在线搜索 / 安装 CurseForge 整合包需要；Modrinth 不需要）
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
        <p className="muted small">
          {cfKeyState === 'saved'
            ? `已保存（尾号 ${cfKey.trim().slice(-4)}），去「模组 · 光影」页就能搜 CurseForge 了。`
            : cfKeyState === 'dirty'
              ? '改完记得点「保存」，不保存等于没填。'
              : settings.curseforgeApiKey
                ? `当前已保存（尾号 ${settings.curseforgeApiKey.slice(-4)}）`
                : '还没填。在 console.curseforge.com 免费申请，填完点「保存」。'}
          {' '}这个 key 只存在本机设置里，不会上传。
        </p>
      </div>

      <UpdateCenter />

      <div className="card">
        <h3>致谢 · 参考与依赖的开源项目</h3>
        <p className="muted small">
          这个启动器是站在这些人的肩膀上做出来的。可以直接点名字去他们的仓库。
          同类启动器只借鉴了功能设计与规则思路，代码都是自己写的；带「依赖库」标签的是直接引入的包。
        </p>
        {(
          [
            ['launcher', '同类启动器（借鉴设计）'],
            ['library', '依赖库'],
            ['data', '数据源 / 开放 API'],
            ['asset', '品牌素材']
          ] as [CreditKind, string][]
        ).map(([kind, label]) => (
          <div key={kind} style={{ marginTop: 14 }}>
            <div className="mini-label">{CREDIT_KIND_LABEL[kind] ?? label}</div>
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
      </div>

      <div className="card">
        <h3>关于</h3>
        <div className="row wrap" style={{ marginBottom: 10 }}>
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
          <span className="muted small">
            第三方启动器，与 Mojang / Microsoft 无关；使用风险自担（详见弹窗与 DISCLAIMER.md）
          </span>
        </div>
        <p className="muted small">
              WFMC {appVersion} · WanFan Minecraft Launcher · Electron + React + @xmcl 内核（MIT）
          <br />
          图标与动画来自万凡科技品牌包（靛紫电光）；感谢上面名单里的每一位作者。
        </p>
      </div>

      {showDisclaimer && <Disclaimer mode="view" onClose={() => setShowDisclaimer(false)} />}
    </div>
  )
}
