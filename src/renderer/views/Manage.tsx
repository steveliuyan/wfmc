import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, formatSize, friendlyError, type ModIssue, type ModUpdateItem, type ModGraph as ModGraphData } from '../api'
import ModGraphView from '../components/ModGraph'
import SaveWorkshop from '../components/SaveWorkshop'
import ShareCard from '../components/ShareCard'
import Select from '../components/Select'
import { useLauncher, useT } from '../store'
import { takeDeepLink } from '../deeplink'
import type {
  CloudSaveItem,
  CloudSaveLimits,
  CloudSaveUsage,
  ContentItem,
  ContentKind,
  CrashDiagnosis,
  CrashReport,
  SaveBackup
} from '../../shared/types'
import type { PageId } from '../App'

type Tab = ContentKind | 'crash' | 'log' | 'updates' | 'shots' | 'datapacks' | 'deps' | 'workshop'

const tabs: { id: Tab; label: string }[] = [
  { id: 'mods', label: '模组' },
  { id: 'deps', label: '依赖' },
  { id: 'resourcepacks', label: '资源包' },
  { id: 'shaderpacks', label: '光影' },
  { id: 'saves', label: '存档' },
  { id: 'workshop', label: '存档工坊' },
  { id: 'datapacks', label: '数据包' },
  { id: 'shots', label: '截图' },
  { id: 'updates', label: 'Mod 更新' },
  { id: 'crash', label: '崩溃报告' },
  { id: 'log', label: '运行日志' }
]

/** 快照是哪来的：让用户一眼看出「启动前自动」「回滚前保护」和手动打的那份 */
function kindLabel(kind?: SaveBackup['kind']): string {
  switch (kind) {
    case 'launch':
      return '启动前自动'
    case 'manual':
      return '手动备份'
    case 'safety':
      return '回滚前保护'
    case 'cloud':
      return '云端下载'
    default:
      return '快照'
  }
}

function kindHint(kind?: SaveBackup['kind']): string {
  switch (kind) {
    case 'launch':
      return '每次启动游戏前自动打的一份'
    case 'manual':
      return '你手动点「立即备份 / 备份所有存档」打的'
    case 'safety':
      return '回滚之前自动给「当时的存档」留的一份，滚错了可以再滚回来'
    case 'cloud':
      return '从云端下载回来的快照'
    default:
      return '较早版本的快照，没记下是怎么来的'
  }
}

export default function Manage({ goto }: { goto: (p: PageId) => void }) {  const { current, currentId, toast, logs, clearLogs, askConfirm, instances, settings, saveSettings, refreshInstances } =
    useLauncher()
  const t = useT()
  const [tab, setTab] = useState<Tab>('mods')
  // 存档工坊是灰度功能：开关关掉时把页签弹回「模组」，别停在空白页
  useEffect(() => {
    if (tab === 'workshop' && !settings?.saveWorkshop) setTab('mods')
  }, [tab, settings?.saveWorkshop])
  // 内容管理自己的目标实例：不用跑回首页/实例页去切
  const [targetId, setTargetId] = useState('')
  const [items, setItems] = useState<ContentItem[]>([])
  const [crashes, setCrashes] = useState<CrashReport[]>([])
  const [crashText, setCrashText] = useState('')
  const [diagnosis, setDiagnosis] = useState<CrashDiagnosis | undefined>()
  const [updates, setUpdates] = useState<ModUpdateItem[]>([])
  const [shots, setShots] = useState<{ name: string; path: string; size: number; time: number }[]>([])
  // 分享卡：undefined = 关着；path 有值就用那一张当底图，没有就用最新一张
  const [shareShot, setShareShot] = useState<{ path?: string } | undefined>()
  const [modIssues, setModIssues] = useState<ModIssue[]>([])
  // 依赖图（内容管理 → 依赖）
  const [modGraph, setModGraph] = useState<ModGraphData | undefined>()
  const [graphLoading, setGraphLoading] = useState(false)
  // 哪几条展开了「这是什么」的说明
  const [explainOpen, setExplainOpen] = useState<Record<number, boolean>>({})
  // 用户手动忽略了这一轮结果（mods 再变会重新弹出来）
  const [diagDismissed, setDiagDismissed] = useState(false)
  // 手动体检：只有用户点了按钮才扫（一进页面就自动扫会把界面卡住），扫描中画进度条
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagProg, setDiagProg] = useState<{ done: number; total: number } | null>(null)
  const [packOrder, setPackOrder] = useState<string[]>([])
  const [langCov, setLangCov] = useState<{
    packs: { name: string; count: number }[]
    coveredCount: number
    mods: { id: string; name: string; covered: boolean; selfChinese: boolean }[]
  }>()
  const [worlds, setWorlds] = useState<string[]>([])
  // 汉化覆盖明细（154 个模组名字太长了，默认收起）
  const [langDetailOpen, setLangDetailOpen] = useState(false)
  // 存档快照（回滚用）
  const [savesBackups, setSavesBackups] = useState<SaveBackup[]>([])
  // 默认展开：切到「存档」就该看见快照，而不是先点一下按钮才出现
  const [showBackups, setShowBackups] = useState(true)
  // 云端存档备份
  const [cloudReady, setCloudReady] = useState(false)
  const [cloudItems, setCloudItems] = useState<CloudSaveItem[]>([])
  const [cloudLimits, setCloudLimits] = useState<CloudSaveLimits | undefined>(undefined)
  const [cloudUsage, setCloudUsage] = useState<CloudSaveUsage | undefined>(undefined)
  const [cloudBusy, setCloudBusy] = useState('')
  // 一键补前置/启前置的批量处理中标记
  const [batchBusy, setBatchBusy] = useState(false)
  // 模组快照（更新/折腾前的后悔药）
  const [modsBackups, setModsBackups] = useState<
    { file: string; name: string; bytes: number; time: number; count: number; partial: boolean }[]
  >([])
  const [packView, setPackView] = useState<{
    name: string
    size: number
    isLangPack: boolean
    title?: string
    description?: string
    files: { id: string; keys: number; entry: string }[]
    others: string[]
    totalEntries: number
  }>()
  const [world, setWorld] = useState('')
  const [packs, setPacks] = useState<ContentItem[]>([])
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(false)
  // 大整合包（几百个 mod）不能一次全渲染：搜索 + 分批挂载
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(120)
  const moreRef = useRef<HTMLDivElement | null>(null)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        (i.title ?? '').toLowerCase().includes(q) ||
        i.name.toLowerCase().includes(q) ||
        (i.description ?? '').toLowerCase().includes(q)
    )
  }, [items, query])
  const visible = filtered.slice(0, shown)

  const isContent = tab !== 'crash' && tab !== 'log' && tab !== 'updates' && tab !== 'shots' && tab !== 'datapacks'

  // 目标实例：默认跟随左侧当前实例，但可以在这里直接换
  const target = instances.find((i) => i.id === targetId) ?? current
  const activeId = target?.id ?? currentId ?? ''

  const refreshModsBackups = async (id = activeId) => {
    if (!id) return
    try {
      setModsBackups(await api.modsBackups(id))
    } catch {
      setModsBackups([])
    }
  }

  // 停在「模组」页时顺手把快照列表拉一下（更新后要立刻能看到新的那份）
  useEffect(() => {
    if (tab === 'mods') void refreshModsBackups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeId])

  // 体检：**没有**「一进内容管理就自动扫」了。
  // 几百个 jar 冷缓存首扫要拆包，以前一打开页面就自动跑，用户感觉是「点进内容管理就卡」。
  // 现在只有点「体检模组」才扫，扫描时主进程把进度推过来画进度条。
  useEffect(() => {
    if (!activeId) return
    let alive = true
    const offDiag = api.onModsDiagnosis((p) => {
      if (!alive || p.instanceId !== activeId) return
      setModIssues(p.issues)
      setDiagDismissed(false)
    })
    const offProg = api.onModsDiagnoseProgress((p) => {
      if (!alive || p.instanceId !== activeId) return
      setDiagProg({ done: p.done, total: p.total })
    })
    return () => {
      alive = false
      offDiag()
      offProg()
      // 万一之前开着常驻扫描，切走时顺手关掉
      api.stopModWatch().catch(() => undefined)
    }
  }, [activeId])

  /** 手动体检：progress 回调会一直推，扫完把结果留在页面上 */
  const runDiagnose = async (): Promise<{ mods: number; bad: number } | undefined> => {
    if (!activeId || diagBusy) return undefined
    setDiagBusy(true)
    setDiagProg(null)
    try {
      const res = await api.diagnoseMods(activeId)
      setModIssues(res.issues)
      setDiagDismissed(false)
      return { mods: res.mods.length, bad: res.issues.filter((x) => x.level !== 'info').length }
    } catch (e) {
      toast(`体检失败：${friendlyError(e)}`, 'error')
      return undefined
    } finally {
      setDiagBusy(false)
      setDiagProg(null)
    }
  }
  useEffect(() => {
    if (!targetId && currentId) setTargetId(currentId)
  }, [currentId, targetId])

  // 从 Ctrl+K 全局搜索跳过来：可能要换实例 + 换 tab（比如直接看某个模组、某个存档）
  useEffect(() => {
    const d = takeDeepLink()
    if (!d) return
    if (d.instanceId) setTargetId(d.instanceId)
    if (d.tab) setTab(d.tab as Tab)
  }, [])

  const refreshShots = async () => {
    if (!activeId) return
    setShots(await api.screenshots(activeId))
  }

  // 元数据后台补：一批一批合进 items。攒 200ms 再 setItems，
  // 免得 50 批补丁各触发一次几百行重渲染。
  const metaBuf = useRef(new Map<string, Partial<ContentItem>>())
  const metaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    const off = api.onContentMeta((p) => {
      if (p.instanceId !== activeId || p.kind !== tab) return
      for (const x of p.patches) metaBuf.current.set(x.path, x.meta)
      if (metaTimer.current) return
      metaTimer.current = setTimeout(() => {
        metaTimer.current = undefined
        const buf = metaBuf.current
        metaBuf.current = new Map()
        if (buf.size === 0) return
        setItems((prev) => prev.map((it) => (buf.has(it.path) ? { ...it, ...buf.get(it.path)! } : it)))
      }, 200)
    })
    return () => {
      off()
      if (metaTimer.current) clearTimeout(metaTimer.current)
      metaTimer.current = undefined
    }
  }, [activeId, tab])

  // 换搜索词 / 换实例：显示条数重置回 120
  useEffect(() => setShown(120), [query, activeId, tab])

  // 滚到底自动再挂 120 条
  useEffect(() => {
    const el = moreRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) setShown((n) => n + 120)
      },
      { rootMargin: '400px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [visible.length, filtered.length])
  const refresh = async () => {
    if (!activeId) return
    setLoading(true)
    try {
      if (isContent) {
        const kind = tab as ContentKind
        // 第一步：只读目录（毫秒级）——几百个 mod 也不会卡住主进程
        setItems(await api.listContent(activeId, kind))
        // 第二步：元数据（名字/简介/图标）后台分批补，结果走 onContentMeta
        void api.enrichContent(activeId, kind)
      }
      else if (tab === 'crash') setCrashes(await api.crashReports(activeId))
      else if (tab === 'shots') setShots(await api.screenshots(activeId))
    } catch (e) {
      toast(`读取失败：${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  const refreshGraph = async () => {
    if (!activeId) return
    setGraphLoading(true)
    try {
      setModGraph(await api.modGraph(activeId))
    } catch (e) {
      toast(`读依赖失败：${friendlyError(e)}`, 'error')
    } finally {
      setGraphLoading(false)
    }
  }

  const refreshBackups = async () => {
    if (!activeId) return
    try {
      setSavesBackups(await api.saveBackups(activeId))
    } catch {
      setSavesBackups([])
    }
    void refreshCloud()
  }

  /** 云端存档：能不能用、有哪些、用了多少 */
  const refreshCloud = async () => {
    try {
      const ready = await api.cloudSavesReady()
      setCloudReady(ready)
      if (!ready) {
        setCloudItems([])
        return
      }
      const [list, usage] = await Promise.all([api.cloudSaveList(), api.cloudSaveUsage()])
      setCloudItems(list.items)
      setCloudLimits(list.limits)
      setCloudUsage(usage)
    } catch {
      setCloudReady(false)
      setCloudItems([])
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeId])

  useEffect(() => {
    // 进「存档」页就把快照列表拉出来（本地 + 云端一起），不用再点一次「存档快照」
    if (tab === 'saves') void refreshBackups()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeId])

  // 依赖图：切到这个 tab 才读
  useEffect(() => {
    if (tab !== 'deps') return
    void refreshGraph()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeId])

  // 模组页顺便算一下汉化包覆盖情况：装了没生效时能立刻看出来是哪个模组没收录
  useEffect(() => {
    if (tab !== 'mods' || !activeId) {
      setLangCov(undefined)
      return
    }
    let alive = true
    api
      .inspectLangPack(activeId)
      .then((c) => alive && setLangCov(c))
      .catch(() => alive && setLangCov(undefined))
    return () => {
      alive = false
    }
  }, [tab, activeId, items.length])

  if (!target) {
    return (
      <div className="page">
        <header className="page-head">
          <h1>{t('内容管理', 'Content')}</h1>
        </header>
        <div className="card empty">
          先在左侧选一个实例，或去新建一个。
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" onClick={() => goto('instances')}>
              去实例页
            </button>
          </div>
        </div>
      </div>
    )
  }

  const lines = logs[activeId] ?? []
  const modCount = target.loader === 'vanilla' ? items.filter((i) => i.name.endsWith('.jar')).length : 0

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('内容管理', 'Content')}</h1>
          <p className="muted">
            {target.name}（{target.mcVersion}
            {target.loader !== 'vanilla' ? ` · ${target.loader}` : ' · 原版'}）
          </p>
        </div>
        <div className="tabs">
          {(settings?.saveWorkshop ? tabs : tabs.filter((x) => x.id !== 'workshop')).map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} data-tour={`mg-tab-${t.id}`}>
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {instances.length > 0 && (
        <div className="card">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="field-mini" style={{ minWidth: 280 }}>
              <span className="mini-label">看哪个实例的内容</span>
              <Select
                value={activeId}
                width={360}
                options={instances.map((i) => ({
                  value: i.id,
                  label: `${i.name}（${i.mcVersion}${i.loader !== 'vanilla' ? ` · ${i.loader}` : ''}）${
                    i.installed ? '' : ' · 未安装'
                  }`
                }))}
                onChange={(v) => setTargetId(v)}
              />
            </label>
            <span className="muted small">
              直接在这切，不用回首页。下面的模组 / 存档 / 日志都跟着这个实例走。
            </span>
          </div>
        </div>
      )}

      {tab === 'mods' && modCount > 0 && (
        <div className="notice-bar warn">
          这个实例是<b>原版（vanilla）</b>，mods 里的 {modCount} 个模组游戏不会加载 —— 原版客户端根本没有模组功能。
          要给 {target.mcVersion} 装模组，先去「实例 → 装 Fabric / Forge」给这个实例换带加载器的版本，模组才会生效。
        </div>
      )}

      {tab === 'mods' && target.loader !== 'vanilla' && (
        <div className="notice-bar">
          当前实例是 <b>{target.loader}</b>，mods 里的 jar 会在启动时由加载器自动读入（前置模组也是 jar，放一起就行，不需要「从依赖启动」）。
        </div>
      )}

      {tab === 'mods' && langCov && (
        <div className="notice-bar">
          {langCov.packs.length > 0 ? (
            (() => {
              const hasCn = langCov.mods.filter((m) => m.covered || m.selfChinese)
              const noCn = langCov.mods.filter((m) => !m.covered && !m.selfChinese)
              return (
                <>
                  已装汉化包：
                  <b>{langCov.packs.map((p) => `${p.name}（${p.count} 个模组）`).join(' + ')}</b>，
                  合计收录 <b>{langCov.coveredCount}</b> 个模组的中文。这里的 {langCov.mods.length} 个模组里：
                  {hasCn.length > 0 && (
                    <>
                      {' '}
                      <b className="ok-text">{hasCn.length} 个有中文</b>
                    </>
                  )}
                  {hasCn.length > 0 && noCn.length > 0 && '，'}
                  {noCn.length > 0 && <b className="warn-text">{noCn.length} 个还没翻</b>}
                  {noCn.length === 0 && hasCn.length > 0 && '，全都有中文了'}
                  。
                  {(hasCn.length > 0 || noCn.length > 0) && (
                    <button
                      className="btn sm"
                      style={{ marginLeft: 8 }}
                      onClick={() => setLangDetailOpen((v) => !v)}
                    >
                      {langDetailOpen ? '收起明细' : '看是哪些'}
                    </button>
                  )}
                  {langDetailOpen && (
                    <div style={{ marginTop: 10 }}>
                      {hasCn.length > 0 && (
                        <div style={{ marginBottom: noCn.length ? 12 : 0 }}>
                          <div className="muted small" style={{ marginBottom: 6 }}>
                            下面这些模组的界面已经是中文：
                          </div>
                          <div className="chips">
                            {hasCn.map((m) => (
                              <span key={m.id || m.name} className="chip" style={{ padding: '2px 10px' }}>
                                {m.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {noCn.length > 0 && (
                        <div>
                          <div className="muted small" style={{ marginBottom: 6 }}>
                            汉化包里没有它们的语言文件，界面还是英文——这类只能等汉化组收录，或者去找作者自己发布的中文语言文件塞进 jar：
                          </div>
                          <div className="chips">
                            {noCn.map((m) => (
                              <span
                                key={m.id || m.name}
                                className="chip warn-text"
                                style={{ padding: '2px 10px' }}
                              >
                                {m.name}
                              </span>
                            ))}
                          </div>
                          <div className="muted small" style={{ marginTop: 8 }}>
                            另外：模组里直接写死的文字（比如标题栏那种）资源包也翻不了，那是作者代码里的字符串。
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )
            })()
          ) : (
            <>还没装汉化包。装模组后界面是英文的话，点上面的「装中文汉化包」。</>
          )}
          {langCov.packs.length > 0 && (
            <div className="row wrap" style={{ marginTop: 8 }}>
              <button
                className="btn sm"
                onClick={async () => {
                  const first = langCov.packs[0]
                  if (!first) return
                  try {
                    setPackView(await api.packContents(activeId, first.name))
                  } catch (e) {
                    toast(`打不开这个包：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                看看翻了哪些模组
              </button>
              <button
                className="btn sm danger"
                onClick={async () => {
                  if (
                    !(await askConfirm({
                      title: '卸载汉化包',
                      message: `删掉 ${langCov.packs.length} 个汉化包（${langCov.packs.map((p) => p.name).join('、')}）？模组文件不动，只是界面会变回英文。`,
                      okText: '卸载',
                      danger: true
                    }))
                  )
                    return
                  try {
                    const r = await api.removePack(activeId)
                    const n = Array.isArray(r.removed) ? r.removed.length : 1
                    toast(`已卸载 ${n} 个汉化包${r.lines ? '，options.txt 里的引用也清了' : ''}`, 'success')
                    setLangCov(await api.inspectLangPack(activeId).catch(() => undefined))
                    await refresh()
                  } catch (e) {
                    toast(`卸载失败：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                卸载汉化包
              </button>
              <span className="muted small">删之前会自动清掉 options.txt 里的引用，不留悬空条目</span>
            </div>
          )}
        </div>
      )}

      {tab === 'deps' && (
        <ModGraphView
          graph={modGraph}
          loading={graphLoading}
          onRefresh={() => void refreshGraph()}
          onFixMissing={async (ids) => {
            try {
              const r = await api.fixModDeps(activeId, ids)
              toast(
                r.failed > 0 ? `补了 ${r.installed.length} 个，${r.failed} 个没装上` : `已装 ${r.installed.length} 个前置`,
                r.failed > 0 ? 'error' : 'success'
              )
            } catch (e) {
              toast(`补前置失败：${friendlyError(e)}`, 'error')
            }
            void refreshGraph()
          }}
          onOpenDir={() => void api.openContentDir(activeId, 'mods')}
          onDisable={async (file) => {
            try {
              await api.toggleContent(activeId, file)
              toast('已停用（文件改成 .disabled，需要时再点一次恢复）', 'success')
            } catch (e) {
              toast(`停用失败：${friendlyError(e)}`, 'error')
            }
            void refreshGraph()
          }}
        />
      )}

      {tab === 'resourcepacks' && (
        <div className="card">
          <div className="row wrap">
            <button
              className="btn"
              onClick={async () => {
                const order = await api.packOrder(activeId)
                setPackOrder(order)
                toast(order.length ? `已启用 ${order.length} 个资源包（按顺序叠加）` : '当前没有启用的资源包', 'info')
              }}
            >
              读取启用顺序
            </button>
            <span className="muted small">顺序即叠加顺序：上面的覆盖下面的（写进 options.txt）</span>
          </div>
          {packOrder.length > 0 && (
            <div className="file-list" style={{ marginTop: 10 }}>
              {packOrder.map((name, i) => (
                <div className="file-row" key={name}>
                  <span className="ellipsis">
                    {i + 1}. {name.replace('file/', '')}
                  </span>
                  <span className="row">
                    <button
                      className="btn sm"
                      disabled={i === 0}
                      onClick={async () => setPackOrder(await api.movePack(activeId, name, -1))}
                    >
                      上移
                    </button>
                    <button
                      className="btn sm"
                      disabled={i === packOrder.length - 1}
                      onClick={async () => setPackOrder(await api.movePack(activeId, name, 1))}
                    >
                      下移
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => setPackOrder(await api.togglePack(activeId, name, false))}
                    >
                      停用
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'mods' && (
        <div className="card">
          <div className="row wrap">
            <button
              className="btn primary"
              disabled={diagBusy}
              onClick={async () => {
                const r = await runDiagnose()
                if (!r) return
                toast(
                  r.bad === 0 ? `体检通过：${r.mods} 个 mod 都没问题` : `体检完成：扫描 ${r.mods} 个 mod，${r.bad} 条要处理`,
                  r.bad === 0 ? 'success' : 'error'
                )
              }}
            >
              {diagBusy ? '体检中…' : modIssues.length > 0 ? '重新体检' : '体检模组（重复 / 加载器 / 前置）'}
            </button>
            <span className="muted small">
              点一下才扫（不再一进页面就自动扫，免得卡）；只读 jar 里的元数据，离线可跑
            </span>
          </div>
          {diagBusy && (
            <div style={{ marginTop: 10 }}>
              <div className="progress-label">
                <span>正在体检模组…</span>
                <span className="progress-nums">
                  <b>{diagProg ? diagProg.done : 0}</b> / {diagProg?.total ?? '?'} 个 jar
                </span>
              </div>
              <div className="bar">
                <i
                  style={{
                    width: `${diagProg && diagProg.total > 0 ? Math.min(100, Math.round((diagProg.done / diagProg.total) * 100)) : 3}%`
                  }}
                />
              </div>
            </div>
          )}
          {!diagDismissed && modIssues.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="row-between" style={{ border: 'none', marginBottom: 6 }}>
                <span className="mini-label">
                  {(() => {
                    const e = modIssues.filter((x) => x.level === 'error').length
                    const w = modIssues.filter((x) => x.level === 'warn').length
                    const i = modIssues.filter((x) => x.level === 'info').length
                    if (e > 0) return `体检结果：${e} 条会让游戏崩或模组失效，建议先处理`
                    if (w > 0) return `体检结果：${w} 条可能让部分模组不好用（不影响启动）`
                    return `体检结果：${i} 条提示，没有要处理的`
                  })()}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  {(() => {
                    const deps = [...new Set(modIssues.map((x) => x.fixDep).filter((d): d is string => !!d))]
                    const enables = [...new Set(modIssues.flatMap((x) => x.enableFiles ?? []))]
                    const total = deps.length + enables.length
                    if (total === 0) return null
                    return (
                      <button
                        className="btn sm primary"
                        disabled={batchBusy}
                        title="把体检里所有缺的前置一次性装好（本机就有、只是被禁用的会先启用）"
                        onClick={async () => {
                          setBatchBusy(true)
                          try {
                            if (enables.length > 0) {
                              await api.enableContent(activeId, 'mods', enables)
                              toast(`已启用 ${enables.length} 个本机就有的前置`, 'success')
                            }
                            if (deps.length > 0) {
                              toast(`正在从 Modrinth 找 ${deps.length} 个前置并安装…`, 'info')
                              const r = await api.fixModDeps(activeId, deps)
                              const ok = r.items.filter((x) => x.status === 'installed')
                              const bad = r.items.filter((x) => x.status !== 'installed')
                              if (ok.length > 0)
                                toast(`装好了 ${ok.length} 个：${ok.map((x) => x.title ?? x.modid).join('、')}`, 'success')
                              if (bad.length > 0) {
                                const why = bad.slice(0, 3).map((x) => `${x.modid}（${x.detail ?? '原因不明'}）`)
                                toast(
                                  `${bad.length} 个没自动装上：${why.join('、')}${bad.length > 3 ? ' 等' : ''}。这类前置多半只在 CurseForge 上——设置里填了 CF Key 会自动去那边补；没填就只能到「模组」页按名字手搜`,
                                  'error'
                                )
                              }
                            }
                            await runDiagnose()
                            await refresh()
                          } catch (e) {
                            toast(`批量处理失败：${friendlyError(e)}`, 'error')
                          } finally {
                            setBatchBusy(false)
                          }
                        }}
                      >
                        {batchBusy ? '处理中…' : `一键处理 ${total} 项`}
                      </button>
                    )
                  })()}
                  <button className="btn sm ghost" onClick={() => setDiagDismissed(true)}>
                    ✕ 忽略
                  </button>
                </span>
              </div>
              {modIssues.map((issue, i) => (
                <div className={`diag-item lv-${issue.level}`} key={i}>
                  <div className="diag-title">
                    <span className={`badge ${issue.level === 'error' ? 'warn' : ''}`}>
                      {issue.level === 'error' ? '错误' : issue.level === 'warn' ? '警告' : '提示'}
                    </span>
                    {issue.title}
                    {issue.explain && (
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setExplainOpen((s) => ({ ...s, [i]: !s[i] }))}
                      >
                        {explainOpen[i] ? '收起说明' : '这是什么？'}
                      </button>
                    )}
                  </div>
                  <div className="diag-advice">{issue.detail}</div>
                  {issue.explain && explainOpen[i] && (
                    <div className="diag-advice" style={{ opacity: 0.85, borderLeft: '2px solid currentColor', paddingLeft: 8, marginTop: 6 }}>
                      {issue.explain}
                    </div>
                  )}
                  {issue.fixDep && (
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <button
                        className="btn sm primary"
                        onClick={async () => {
                          const dep = issue.fixDep!
                          try {
                            toast(`正在从 Modrinth 找 ${dep}…`, 'info')
                            const r = await api.fixModDeps(activeId, [dep])
                            const ok = r.items.filter((x) => x.status === 'installed')
                            if (ok.length > 0) {
                              toast(`装好了：${ok.map((x) => x.title ?? x.modid).join('、')}（连带它自己的前置）`, 'success')
                            } else {
                              toast(
                                `没能自动装 ${dep}：${r.items[0]?.detail ?? 'Modrinth 上没找到对应项目'}。可以到「模组」页搜名字手动装`,
                                'error'
                              )
                            }
                            setModIssues([])
                            await refresh()
                          } catch (e) {
                            toast(`补前置失败：${friendlyError(e)}`, 'error')
                          }
                        }}
                      >
                        装上 {issue.fixDep}
                      </button>
                      <span className="muted small">自动从 Modrinth 找同名项目，连带它自己的前置一起装</span>
                    </div>
                  )}
                  {issue.enableFiles && issue.enableFiles.length > 0 && (
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <button
                        className="btn sm primary"
                        onClick={async () => {
                          try {
                            await api.enableContent(activeId, 'mods', issue.enableFiles!)
                            toast(`已启用：${issue.enableFiles!.map((f) => f.replace(/\.disabled$/, '')).join('、')}`, 'success')
                            setModIssues([])
                            await refresh()
                          } catch (e) {
                            toast(`启用失败：${friendlyError(e)}`, 'error')
                          }
                        }}
                      >
                        启用这个前置
                      </button>
                      <span className="muted small">文件已经在本机，只是名字带 .disabled，改回来就行，不用重新下载</span>
                    </div>
                  )}
                  {issue.fixLoader && (
                    <div className="row wrap" style={{ marginTop: 8 }}>
                      <button
                        className="btn sm primary"
                        onClick={async () => {
                          const ld = issue.fixLoader!
                          const label = ld === 'fabric' ? 'Fabric' : ld === 'forge' ? 'Forge' : ld === 'neoforge' ? 'NeoForge' : 'Quilt'
                          try {
                            toast(`正在拉 ${label} 版本…`, 'info')
                            const list = await api.loaderVersions(ld, target?.mcVersion ?? '')
                            const ver = list[0]?.value
                            if (!ver) return toast(`没找到 ${label} 给 ${target?.mcVersion} 用的版本`, 'error')
                            toast(`开始装 ${label} ${ver}，进度看右下角`, 'info')
                            await api.installLoader(activeId, ld, ver)
                            toast(`装好了：${label} ${ver}，模组下次启动就会加载`, 'success')
                            await refreshInstances()
                            setModIssues([])
                          } catch (e) {
                            toast(`装加载器失败：${friendlyError(e)}`, 'error')
                          }
                        }}
                      >
                        换成 {issue.fixLoader === 'neoforge' ? 'NeoForge' : issue.fixLoader === 'fabric' ? 'Fabric' : issue.fixLoader === 'forge' ? 'Forge' : 'Quilt'} 加载器
                      </button>
                      <span className="muted small">装完自动切过去，存档 / mods 都不动</span>
                    </div>
                  )}
                  {issue.files && issue.files.length > 0 && (
                    <code className="diag-evidence">{issue.files.slice(0, 8).join('\n')}</code>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'mods' && (
        <div className="card">
          <div className="toolbar">
            <b>模组快照</b>
            <span className="muted small">
              「Mod 更新」每次替换旧 jar 前会自动存一份；手动备份会把整个 mods 目录打包（大整合包可能要等十几秒）。回滚前也会先把当前状态备份一次。
            </span>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              onClick={async () => {
                try {
                  toast('正在备份整个 mods 目录…', 'info')
                  const file = await api.backupMods(activeId)
                  if (!file) return toast('mods 目录是空的，没什么可备份', 'info')
                  toast('已备份：' + file.split(/[\\/]/).pop(), 'success')
                  await refreshModsBackups()
                } catch (e) {
                  toast('备份失败：' + friendlyError(e), 'error')
                }
              }}
            >
              备份当前 mods
            </button>
            <button className="btn sm ghost" onClick={() => refreshModsBackups()}>
              刷新
            </button>
          </div>
          {modsBackups.length === 0 ? (
            <div className="muted small">还没有快照。更新模组时会自动生成，或者点「备份当前 mods」。</div>
          ) : (
            <div className="file-list">
              {modsBackups.map((b) => (
                <div className="file-row content-row" key={b.file}>
                  <div className="content-icon dir">🧩</div>
                  <div className="content-main">
                    <div className="content-name">
                      {new Date(b.time).toLocaleString('zh-CN', { hour12: false })}
                      {b.partial && <span className="badge warn">更新前备份</span>}
                    </div>
                    <div className="content-desc" title={b.file}>
                      {b.name} · {b.count} 个文件
                    </div>
                  </div>
                  <span className="muted small">{formatSize(b.bytes)}</span>
                  <span className="row">
                    <button
                      className="btn sm"
                      onClick={async () => {
                        if (
                          !(await askConfirm({
                            title: '回滚模组',
                            message: '把 mods 目录回滚到这份快照？回滚前会先自动备份当前 mods，后悔了还能退回来。',
                            okText: '回滚'
                          }))
                        ) {
                          return
                        }
                        try {
                          toast('正在回滚…', 'info')
                          const r = await api.restoreModsBackup(activeId, b.file)
                          toast(`已回滚 ${r.restored} 个文件${r.removed ? `，清掉 ${r.removed} 个新版本` : ''}`, 'success')
                          await refresh()
                          await refreshModsBackups()
                        } catch (e) {
                          toast('回滚失败：' + friendlyError(e), 'error')
                        }
                      }}
                    >
                      回滚
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isContent && (
        <div className="card">
          <div className="row wrap">
            <button
              className="btn primary"
              onClick={async () => {
                const res = await api.importContent(activeId, tab as ContentKind)
                if (res) {
                  setItems(res)
                  toast(`已导入 ${res.length} 项`, 'success')
                }
              }}
            >
              导入本地文件
            </button>
            <button className="btn" onClick={() => api.openContentDir(activeId, tab as ContentKind)}>
              打开文件夹
            </button>
            <button className="btn" onClick={refresh}>
              刷新
            </button>
            {(tab === 'mods' || tab === 'resourcepacks') && (
              <button
                className="btn ghost"
                title="模组的中文是作者写在 jar 里的，没写就是英文。装这个汉化资源包后模组界面会变中文（VM 汉化组维护，覆盖 1.12 ~ 最新版）"
                onClick={async () => {
                  try {
                    toast('正在装汉化包，进度看右下角', 'info')
                    const res = await api.installLangPack(activeId)
                    const names = res.packs.map((p) => `${p.source === 'vm' ? 'VM' : 'CFPA'} ${Math.round(p.size / 1024)} KB`)
                    toast(`已装好并启用 ${res.packs.length} 个汉化包：${names.join(' + ')}`, 'success')
                    if (res.skipped.length) {
                      toast(`没装上的：${res.skipped.map((s) => `${s.source}（${s.reason}）`).join('；')}`, 'info')
                    }
                    await refresh()
                    api.inspectLangPack(activeId).then(setLangCov).catch(() => undefined)
                  } catch (e) {
                    toast(`装汉化包失败：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                装中文汉化包
              </button>
            )}
            {tab === 'saves' && (
              <>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      const r = await api.restoreWorld(activeId)
                      if (!r) return
                      const mb = (r.bytes / 1024 / 1024).toFixed(1)
                      toast(`已恢复「${r.name}」：${r.fileCount} 个文件 / ${mb} MB`, 'success')
                      if (r.renamed) toast('已存在同名存档，新的这份自动改了名', 'info')
                      const pk = r.check.info?.mcVersion
                      if (pk && pk !== target.mcVersion) {
                        toast(`这个存档是在 ${pk} 里存的，当前实例是 ${target.mcVersion}`, 'info')
                      }
                      await refresh()
                      setWorlds(await api.worlds(activeId))
                    } catch (e) {
                      toast(`恢复失败：${friendlyError(e)}`, 'error')
                    }
                  }}
                >
                  导入存档包
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    try {
                      const c = await api.inspectWorldPack()
                      if (!c) return
                      if (!c.signed) {
                        toast('这个 zip 里没有 WFMC 校验清单，只能当普通压缩包恢复', 'info')
                        return
                      }
                      if (c.ok) {
                        toast(`校验通过：${c.checked} 个文件全部对上，可以放心恢复`, 'success')
                      } else {
                        toast(`校验没通过：${c.problems.length} 个文件有问题，第一个是 ${c.problems[0].path}（${c.problems[0].kind}）`, 'error')
                      }
                    } catch (e) {
                      toast(`校验失败：${friendlyError(e)}`, 'error')
                    }
                  }}
                >
                  校验存档包
                </button>
                <button
                  className="btn ghost"
                  onClick={async () => {
                    if (
                      !(await askConfirm({
                        title: '备份所有存档',
                        message: `把 ${target.name}（${target.mcVersion}）的存档目录整个打成一个 zip 快照？`,
                        okText: '开始备份'
                      }))
                    )
                      return
                    try {
                      const r = await api.backupSaves(activeId)
                      if (!r) return toast('存档目录是空的，没什么可备份', 'info')
                      toast(`已备份 ${r.worlds.length} 个存档：${r.files} 个文件（${formatSize(r.bytes)}）`, 'success')
                      setShowBackups(true)
                      await refreshBackups()
                    } catch (e) {
                      toast('备份失败：' + friendlyError(e), 'error')
                    }
                  }}
                >
                  备份所有存档
                </button>
                {/* 备份完想马上看看 zip 落在哪：不用先展开「存档快照」 */}
                <button className="btn ghost" onClick={() => void api.openBackupsDir()}>
                  打开备份所在文件夹
                </button>
                <button
                  className={showBackups ? 'btn' : 'btn ghost'}
                  onClick={async () => {
                    const next = !showBackups
                    setShowBackups(next)
                    if (next) await refreshBackups()
                  }}
                >
                  存档快照
                </button>
              </>
            )}
            <span className="muted small">共 {items.length} 项{loading ? ' · 读取中…' : ''}</span>
          </div>
        </div>
      )}

      {tab === 'saves' && showBackups && (
        <div className="card">
          <div className={'toolbar'}>
            <b>存档快照</b>
            <span className="muted small">
              启动游戏前自动打一份，最多留 12 份；回滚时会先把当前存档再备份一次，不会把新世界弄丢。
            </span>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              onClick={async () => {
                try {
                  const r = await api.backupSaves(activeId)
                  if (!r) return toast('存档目录是空的，没什么可备份', 'info')
                  toast(`已备份 ${r.worlds.length} 个存档（${r.files} 个文件，${formatSize(r.bytes)}）`, 'success')
                  await refreshBackups()
                } catch (e) {
                  toast('备份失败：' + friendlyError(e), 'error')
                }
              }}
            >
              立即备份
            </button>
            <button className="btn sm ghost" onClick={() => void api.openBackupsDir()}>
              打开备份文件夹
            </button>
            <button className="btn sm" onClick={() => setShowBackups(false)}>收起</button>
          </div>
          {savesBackups.length === 0 ? (
            <div className="muted small">还没有快照。启动一次游戏就会自动生成，或者点「立即备份」。</div>
          ) : (
            <div className="file-list">
              {savesBackups.map((b) => (
                <div className="file-row content-row" key={b.file}>
                  <div className="content-icon dir">🗂</div>
                  <div className="content-main">
                    <div className="content-name">
                      {new Date(b.time).toLocaleString('zh-CN', { hour12: false })}
                      <span className={'badge' + (b.kind === 'safety' ? ' ok' : '')} title={kindHint(b.kind)}>
                        {kindLabel(b.kind)}
                      </span>
                      {b.cloudId && (
                        <span className="badge ok" title="这份已经同步到云端">
                          已同步云端
                        </span>
                      )}
                    </div>
                    <div className="content-desc" title={b.name}>
                      {b.name}
                    </div>
                    <div className="muted small" style={{ marginTop: 2 }}>
                      {[
                        b.worlds?.length ? `${b.worlds.length} 个存档` : '',
                        b.files ? `${b.files} 个文件` : '',
                        formatSize(b.bytes)
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  <span className="muted small">{b.kind === 'safety' ? '回滚保护' : ''}</span>
                  <span className="row">
                    {cloudReady && !b.cloudId && (
                      <button
                        className="btn sm ghost"
                        disabled={!!cloudBusy}
                        onClick={async () => {
                          setCloudBusy(b.file)
                          try {
                            const r = await api.uploadCloudSave(activeId, b.file)
                            toast(r.message, r.ok ? 'success' : 'error')
                            if (r.ok) await refreshBackups()
                          } catch (e) {
                            toast('上传失败：' + friendlyError(e), 'error')
                          } finally {
                            setCloudBusy('')
                          }
                        }}
                      >
                        {cloudBusy === b.file ? '上传中…' : '传这份到云端'}
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => void api.revealBackup(b.file)}>
                      打开所在文件夹
                    </button>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const when = new Date(b.time).toLocaleString('zh-CN', { hour12: false })
                        if (
                          !(await askConfirm({
                            title: '回滚存档',
                            message: `把存档回滚到「${when}」这份快照？\n回滚前会先把当前存档另存一份（列表里会多出一条标着「回滚前保护」的快照），回滚后后悔了还能再滚回来。`,
                            okText: '回滚'
                          }))
                        )
                          return
                        try {
                          const r = await api.restoreSaveBackup(activeId, b.file)
                          toast(`已回滚 ${r.restored} 个文件（${r.worlds.join('、') || '存档'}）`, 'success')
                          if (r.safetyBackup)
                            toast(`当前存档已另存为「${r.safetyBackup.split(/[\\/]/).pop()}」，需要时回滚它就行`, 'info')
                          await refresh()
                          await refreshBackups()
                          setWorlds(await api.worlds(activeId))
                        } catch (e) {
                          toast('回滚失败：' + friendlyError(e), 'error')
                        }
                      }}
                    >
                      回滚
                    </button>
                    <button
                      className="btn sm danger ghost"
                      onClick={async () => {
                        const when = new Date(b.time).toLocaleString('zh-CN', { hour12: false })
                        if (
                          !(await askConfirm({
                            title: '删除快照',
                            message: `删掉「${when}」这份快照（${formatSize(b.bytes)}）？\n只删这个 zip，当前存档不受影响。删了就不能回滚到这一份了。`,
                            okText: '删除',
                            danger: true
                          }))
                        )
                          return
                        try {
                          await api.deleteSaveBackup(b.file)
                          toast('已删除这份快照', 'success')
                          await refreshBackups()
                        } catch (e) {
                          toast('删除失败：' + friendlyError(e), 'error')
                        }
                      }}
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'saves' && showBackups && cloudReady && (
        <div className="card">
          <div className="toolbar">
            <b>云端存档</b>
            <span className="muted small">
              {cloudUsage
                ? `已用 ${formatSize(cloudUsage.usedBytes)} / ${formatSize(cloudUsage.quotaBytes)}，共 ${cloudUsage.count} 份 · 每个实例云端最多留 ${cloudLimits?.savesKeep ?? 10} 份`
                : '读云端清单中…'}
            </span>
            <span className="spacer" />
            <button
              className="btn sm ghost"
              disabled={!!cloudBusy}
              onClick={async () => {
                setCloudBusy('new')
                try {
                  const r = await api.uploadCloudSave(activeId)
                  toast(r.message, r.ok ? 'success' : 'error')
                  if (r.ok) await refreshBackups()
                } catch (e) {
                  toast('上传失败：' + friendlyError(e), 'error')
                } finally {
                  setCloudBusy('')
                }
              }}
            >
              {cloudBusy === 'new' ? '上传中…' : '打一份新的传上云'}
            </button>
            <button className="btn sm ghost" onClick={() => void refreshCloud()}>
              刷新云端清单
            </button>
          </div>
          {cloudItems.length === 0 ? (
            <div className="muted small">
              云端还没有存档。点上面「打一份新的传上云」，或者本地备份好之后点快照行里的「传这份到云端」。
            </div>
          ) : (
            groupCloudBackups(cloudItems).map((g) => (
              <div key={g.key} style={{ marginBottom: 12 }}>
                <div className="row wrap" style={{ gap: 8, marginBottom: 4 }}>
                  <b>{g.instanceName || g.instance}</b>
                  {g.instance !== activeId && (
                    <span
                      className="badge"
                      title={
                        instances.some((i) => i.id === g.instance)
                          ? '这份存档是别的实例打的，回滚时会恢复到当前实例'
                          : '本机没有这个实例（换电脑/换整合包了），只能恢复到当前实例'
                      }
                    >
                      {instances.some((i) => i.id === g.instance) ? '别的整合包' : '本机没有这个包'}
                    </span>
                  )}
                  <span className="badge">{g.mcVersion || '未知版本'}</span>
                  {g.loader && (
                    <span className="badge">
                      {g.loader}
                      {g.loaderVersion ? ` ${g.loaderVersion}` : ''}
                    </span>
                  )}
                  <span className="muted small">{g.items.length} 份</span>
                </div>
                <div className="file-list">
                  {g.items.map((it) => (
                    <div className="file-row content-row" key={it.id}>
                      <div className="content-icon dir">☁️</div>
                      <div className="content-main">
                        <div className="content-name">
                          {new Date(it.createdAt * 1000).toLocaleString('zh-CN', { hour12: false })}
                        </div>
                        <div className="content-desc">
                          {it.worlds?.length ? it.worlds.slice(0, 3).join('、') : '存档'}
                          {it.worlds?.length > 3 ? ` 等 ${it.worlds.length} 个` : ''}
                          {it.files ? ` · ${it.files} 个文件` : ''}
                        </div>
                      </div>
                      <span className="muted small">{formatSize(it.bytes)}</span>
                      <span className="row">
                        <button
                          className="btn sm"
                          disabled={!!cloudBusy}
                          onClick={async () => {
                            if (
                              !(await askConfirm({
                                title: '从云端回滚',
                                message: [
                                  `把这份云端存档下载下来，恢复到当前实例「${current?.name ?? '当前实例'}」的 saves 里？`,
                                  g.instance !== activeId
                                    ? `\n注意：这份是「${g.instanceName || g.instance}」（${g.mcVersion || '未知版本'}${g.loader ? ' · ' + g.loader : ''}）打的，不是当前实例。存档里的方块/物品是按那个整合包的模组记的 —— 当前实例的 MC 版本和模组不一样的话，进游戏会缺方块、缺物品，严重的会崩。想正常玩就把那个整合包也装上，再在这里选它作当前实例回滚。`
                                    : '',
                                  '\n下载后会校验完整性，回滚前也会先本地备份一份当前存档（多出一条「回滚前保护」）。'
                                ].join('')
                              }))
                            )
                              return
                            setCloudBusy(it.id)
                            try {
                              const r = await api.restoreCloudSave(activeId, it.id)
                              toast(`已回滚 ${r.restored} 个文件（${r.worlds.join('、') || '存档'}）`, 'success')
                              if (r.safetyBackup) toast('回滚前的存档也留了一份', 'info')
                              await refresh()
                              await refreshBackups()
                              setWorlds(await api.worlds(activeId))
                            } catch (e) {
                              toast('回滚失败：' + friendlyError(e), 'error')
                            } finally {
                              setCloudBusy('')
                            }
                          }}
                        >
                          {cloudBusy === it.id ? '处理中…' : '下载并回滚'}
                        </button>
                        <button
                          className="btn sm ghost"
                          disabled={!!cloudBusy}
                          onClick={async () => {
                            if (
                              !(await askConfirm({
                                title: '删除云端存档',
                                message: '从云端删掉这份存档？本地的那份不受影响。',
                                okText: '删除'
                              }))
                            )
                              return
                            try {
                              await api.deleteCloudSave(it.id)
                              toast('已从云端删掉', 'success')
                              await refreshCloud()
                            } catch (e) {
                              toast('删除失败：' + friendlyError(e), 'error')
                            }
                          }}
                        >
                          删除
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {isContent && (
        <div className="card">
          {items.length > 0 && (
            <div className="row wrap" style={{ marginBottom: 8 }}>
              <input
                type="search"
                value={query}
                placeholder={t('搜索名字或简介…', 'Search name or description…')}
                onChange={(e) => setQuery(e.target.value)}
                style={{ flex: 1, minWidth: 180 }}
              />
              <span className="muted small">
                {`${filtered.length} / ${items.length}`}
                {shown < filtered.length ? `（已显示 ${shown}）` : ''}
              </span>
            </div>
          )}
          {items.length === 0 && <div className="muted small">这个目录还是空的。可以点上面的「导入本地文件」。</div>}
          {items.length > 0 && filtered.length === 0 && (
            <div className="muted small">没有匹配「{query}」的内容。</div>
          )}
          <div className="file-list">
            {visible.map((item) => (
              <div className="file-row content-row" key={item.path}>
                {item.isDir ? (
                  <div className="content-icon dir">📁</div>
                ) : item.iconPath ? (
                  <img className="content-icon" src={`file://${item.iconPath.replace(/\\/g, '/')}`} alt="" loading="lazy" />
                ) : (
                  <div className="content-icon ph">{(item.title ?? item.name).slice(0, 1).toUpperCase()}</div>
                )}
                <div className="content-main">
                  <div className="content-name" title={item.name}>
                    {item.title ?? item.name.replace(/\.disabled$/, '')}
                    {item.version && (
                      <span className="badge">{/^\d/.test(item.version) ? `v${item.version}` : item.version}</span>
                    )}
                    {item.loader && <span className="badge">{item.loader}</span>}
                    {item.disabled && <span className="badge warn">已禁用</span>}
                    {item.isDir && <span className="badge">目录</span>}
                  </div>
                  <div className="content-desc" title={item.description ?? item.name}>
                    {item.description ? item.description : item.name.replace(/\.disabled$/, '')}
                  </div>
                </div>
                <span className="muted small">{item.isDir ? '—' : formatSize(item.size)}</span>
                <span className="row">
                  {tab === 'saves' && item.isDir && (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          const r = await api.packWorld(activeId, item.name)
                          if (!r) return
                          const mb = (r.zipBytes / 1024 / 1024).toFixed(1)
                          toast(`已打包：${r.info.fileCount} 个文件 → ${mb} MB（含 sha1 校验清单）`, 'success')
                          toast(`存到了 ${r.path}`, 'info')
                        } catch (e) {
                          toast(`打包失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      打包
                    </button>
                  )}
                  {tab === 'resourcepacks' && !item.isDir && /\.zip$/i.test(item.name.replace(/\.disabled$/, '')) && (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          setPackView(await api.packContents(activeId, item.name.replace(/\.disabled$/, '')))
                        } catch (e) {
                          toast(`读不了这个包：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      内容
                    </button>
                  )}
                  {!item.isDir && (
                    <button
                      className="btn sm"
                      onClick={async () => setItems(await api.toggleContent(activeId, item.path))}
                    >
                      {item.disabled ? '启用' : '禁用'}
                    </button>
                  )}
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!(await askConfirm({ title: '删除文件', message: `删掉 ${item.name}？`, okText: '删除', danger: true }))) return
                      await api.deleteContent(activeId, item.path)
                      await refresh()
                    }}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
            {visible.length < filtered.length && (
              <div ref={moreRef} className="muted small" style={{ padding: '10px 0', textAlign: 'center' }}>
                {`往下滚继续加载（还剩 ${filtered.length - visible.length} 个）`}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'datapacks' && (
        <div className="card">
          <div className="row wrap">
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              存档
              <select
                value={world}
                onChange={async (e) => {
                  setWorld(e.target.value)
                  if (e.target.value) setPacks(await api.datapacks(activeId, e.target.value))
                }}
              >
                <option value="">选择存档…</option>
                {worlds.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              onClick={async () => {
                const list = await api.worlds(activeId)
                setWorlds(list)
                if (list[0] && !world) {
                  setWorld(list[0])
                  setPacks(await api.datapacks(activeId, list[0]))
                }
              }}
            >
              刷新存档列表
            </button>
            <button
              className="btn primary"
              disabled={!world}
              onClick={async () => setPacks(await api.importDatapack(activeId, world))}
            >
              导入数据包
            </button>
          </div>
          {!world && <div className="muted small" style={{ marginTop: 10 }}>先选一个存档（数据包是存档级的）。</div>}
          {world && (
            <div className="file-list" style={{ marginTop: 10 }}>
              {packs.length === 0 && <div className="muted small">这个存档还没有数据包。</div>}
              {packs.map((p) => (
                <div className="file-row" key={p.path}>
                  <span className="ellipsis">
                    {p.name} {p.disabled && <span className="badge">已停用</span>}
                  </span>
                  <span className="muted small">{formatSize(p.size)}</span>
                  <span className="row">
                    <button
                      className="btn sm"
                      onClick={async () => setPacks(await api.toggleDatapack(activeId, world, p.name))}
                    >
                      {p.disabled ? '启用' : '停用'}
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => setPacks(await api.deleteDatapack(activeId, world, p.name))}
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'workshop' && settings?.saveWorkshop && <SaveWorkshop instanceId={activeId} />}

      {tab === 'shots' && (
        <div className="card">
          <div className="row wrap">
            <button className="btn" onClick={refreshShots}>
              刷新
            </button>
            <button className="btn" onClick={() => api.openScreenshotsDir(activeId)}>
              打开截图目录
            </button>
            <button className="btn" onClick={() => setShareShot({})} disabled={!target}>
              做分享卡
            </button>
            <span className="muted small">
              共 {shots.length} 张（游戏里 F2 截的图会出现在这里）
            </span>
          </div>
          {shots.length === 0 && <div className="muted small" style={{ marginTop: 10 }}>还没有截图。</div>}
          <div className="shot-grid">
            {shots.map((s) => (
              <div className="shot-item" key={s.path}>
                <img src={`file://${s.path.replace(/\\/g, '/')}`} alt={s.name} loading="lazy" />
                <div className="shot-meta">
                  <span className="ellipsis" title={s.name}>
                    {s.name}
                  </span>
                  <span className="row">
                    <button className="btn sm" onClick={() => api.openPath(s.path)}>
                      打开
                    </button>
                    <button className="btn sm" onClick={() => setShareShot({ path: s.path })}>
                      分享卡
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        await api.deleteScreenshot(activeId, s.path)
                        await refreshShots()
                      }}
                    >
                      删除
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'updates' && (
        <div className="card">
          <div className="row wrap">
            <button
              className="btn primary"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                try {
                  const list = await api.checkModUpdates(activeId)
                  setUpdates(list)
                  const n = list.filter((u) => u.updateAvailable).length
                  toast(n > 0 ? `发现 ${n} 个可更新模组` : '所有能查到的模组都是最新版', n > 0 ? 'success' : 'info')
                } catch (e) {
                  toast(`检查失败：${(e as Error).message}`, 'error')
                } finally {
                  setChecking(false)
                }
              }}
            >
              {checking ? '按文件指纹比对中…' : '检查 Mod 更新'}
            </button>
            <span className="muted small">
              用 mods 里每个 jar 的 SHA1 去 Modrinth 反查最新版本，不靠猜文件名。
            </span>
          </div>

          {updates.length > 0 && (
            <div className="file-list" style={{ marginTop: 12 }}>
              {updates.map((u) => (
                <div className="file-row" key={u.path}>
                  <span className="ellipsis" title={u.file}>
                    {u.file}
                    {u.updateAvailable && <span className="badge ok">有新版本</span>}
                  </span>
                  <span className="muted small">
                    {u.updateAvailable
                      ? `→ ${u.latestVersionNumber ?? ''} ${u.latestFileName ?? ''}`
                      : u.note ?? '已是最新'}
                  </span>
                  <button
                    className="btn sm primary"
                    disabled={!u.updateAvailable || !u.downloadUrl}
                    onClick={async () => {
                      try {
                        await api.applyModUpdate(activeId, {
                          path: u.path,
                          url: u.downloadUrl!,
                          filename: u.latestFileName ?? u.file
                        })
                        toast(`${u.file} 已更新（旧文件保留为 .old）`, 'success')
                        const list = await api.checkModUpdates(activeId)
                        setUpdates(list)
                      } catch (e) {
                        toast(`更新失败：${(e as Error).message}`, 'error')
                      }
                    }}
                  >
                    更新
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'crash' && (
        <div className="card">
          <div className="row wrap">
            <button className="btn" onClick={refresh}>
              刷新
            </button>
            <button
              className="btn primary"
              data-tour="mg-diagnose"
              onClick={async () => {
                const d = await api.diagnose(activeId)
                setDiagnosis(d)
                if (!d) toast('没找到崩溃报告或日志', 'info')
              }}
            >
              一键诊断崩溃原因
            </button>
            <span className="muted small">{crashes.length} 个崩溃报告</span>
          </div>

          {diagnosis && (
            <div style={{ marginTop: 14 }}>
              <div className="mini-label">
                诊断结果 · {diagnosis.file.split(/[\\/]/).pop()}（{diagnosis.lines} 行）
              </div>
              {diagnosis.issues.length === 0 ? (
                <div className="muted small">没命中已知问题，往下看原始内容，或去「运行日志」翻更早的记录。</div>
              ) : (
                diagnosis.issues.map((issue, i) => (
                  <div className="diag-item" key={i}>
                    <div className="diag-title">
                      <span className="badge warn">{i + 1}</span> {issue.title}
                    </div>
                    <div className="diag-advice">{issue.advice}</div>
                    <code className="diag-evidence">{issue.evidence}</code>
                  </div>
                ))
              )}
              <details style={{ marginTop: 10 }}>
                <summary className="muted small" style={{ cursor: 'pointer' }}>
                  查看报告开头
                </summary>
                <pre className="log" style={{ height: 180, marginTop: 8 }}>
                  {diagnosis.summary}
                </pre>
              </details>
            </div>
          )}

          {crashes.length === 0 && <div className="muted small" style={{ marginTop: 10 }}>没有崩溃报告，挺稳。</div>}
          <div className="file-list" style={{ marginTop: 10 }}>
            {crashes.map((c) => (
              <div className="file-row" key={c.path}>
                <span className="ellipsis">{c.name}</span>
                <span className="muted small">{new Date(c.time).toLocaleString()}</span>
                <button
                  className="btn sm"
                  onClick={async () => setCrashText(await api.readCrashReport(activeId, c.path))}
                >
                  查看
                </button>
              </div>
            ))}
          </div>
          {crashText && (
            <>
              <div className="row-between" style={{ marginTop: 12 }}>
                <span className="mini-label">崩溃报告内容</span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const p = await api.saveText('crash-report.txt', crashText)
                    if (p) toast(`已保存到 ${p}`, 'success')
                  }}
                >
                  导出
                </button>
              </div>
              <pre className="log">{crashText}</pre>
            </>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="card">
          <div className="row wrap">
            <button
              className="btn"
              onClick={async () => {
                const p = await api.saveText(`wfmc-${activeId}.log`, lines.join('\n'))
                if (p) toast(`已导出到 ${p}`, 'success')
              }}
            >
              导出日志
            </button>
            <button className="btn" onClick={() => clearLogs(activeId)}>
              清空
            </button>
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  toast('正在打包日志 / 崩溃报告 / 体检结果 / 系统信息…', 'info')
                  const p = await api.exportDiagnostics(activeId)
                  toast(`诊断包已导出（路径和账号名已脱敏）：${p}`, 'success')
                } catch (e) {
                  toast(`导出失败：${(e as Error).message}`, 'error')
                }
              }}
            >
              导出诊断包（日志+崩溃+体检+系统信息）
            </button>
            <span className="muted small">{lines.length} 行</span>
          </div>
          <pre className="log" style={{ height: 420, marginTop: 10 }}>
            {lines.length ? lines.join('\n') : '还没有日志，去首页启动一次游戏。'}
          </pre>
        </div>
      )}

      {shareShot && target && (
        <ShareCard instance={target} shotPath={shareShot.path} onClose={() => setShareShot(undefined)} />
      )}

      {packView && (
        <div className="dialog-mask" onClick={() => setPackView(undefined)}>
          <div className="dialog pack-view" onClick={(e) => e.stopPropagation()}>
            <div className="pack-head">
              <div>
                <div className="pack-title">{packView.title ?? packView.name}</div>
                <div className="muted small">
                  {formatSize(packView.size)} · 共 {packView.totalEntries} 个文件
                  {packView.isLangPack
                    ? ` · 里面有 ${packView.files.length} 个模组的中文`
                    : ' · 没检测到中文语言文件（不是汉化包，或者是纯贴图/音效的资源包）'}
                </div>
                {packView.description && <div className="muted small">{packView.description}</div>}
              </div>
              <button className="btn sm" onClick={() => setPackView(undefined)}>
                关闭
              </button>
            </div>
            {packView.isLangPack ? (
              <>
                <div className="pack-sub">
                  以下是这个包里翻了中文的模组（<b>{packView.files.length}</b> 个）。游戏里按 modid 匹配，装了对应的模组就会自动套用：
                </div>
                <div className="pack-list">
                  {packView.files.map((f) => (
                    <div className="pack-item" key={f.id}>
                      <code>{f.id}</code>
                      <span className="muted small">{f.keys} 条</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="pack-sub">这个包里的其它文件（最多列 60 条）：</div>
                <div className="pack-list">
                  {packView.others.map((f) => (
                    <div className="pack-item" key={f}>
                      <code>{f}</code>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="row wrap pack-foot">
              <button
                className="btn danger"
                onClick={async () => {
                  if (
                    !(await askConfirm({
                      title: '删除资源包',
                      message: `删掉 ${packView.name}？存档和模组不受影响，只是界面/贴图会回到原版。`,
                      okText: '删除',
                      danger: true
                    }))
                  )
                    return
                  try {
                    const r = await api.removePack(activeId, packView.name)
                    toast(`已删除${r.lines ? '，options.txt 里的引用也清了' : ''}`, 'success')
                    setPackView(undefined)
                    setLangCov(await api.inspectLangPack(activeId).catch(() => undefined))
                    await refresh()
                  } catch (e) {
                    toast(`删除失败：${friendlyError(e)}`, 'error')
                  }
                }}
              >
                删除这个包
              </button>
              <span className="muted small">删之前会先从 options.txt 的启用列表里摘掉，不留悬空条目</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
/** 云端存档按「实例 → 版本/加载器」分组，组内按时间倒序（服务端本来就倒序，这里只保证） */
function groupCloudBackups(items: CloudSaveItem[]): {
  key: string
  instance: string
  instanceName?: string
  mcVersion?: string
  loader?: string
  loaderVersion?: string
  items: CloudSaveItem[]
}[] {
  const map = new Map<string, { key: string; instance: string; instanceName?: string; mcVersion?: string; loader?: string; loaderVersion?: string; items: CloudSaveItem[] }>()
  for (const it of items) {
    const key = [it.instance, it.mcVersion ?? '', it.loader ?? '', it.loaderVersion ?? ''].join('|')
    let g = map.get(key)
    if (!g) {
      g = {
        key,
        instance: it.instance,
        instanceName: it.instanceName,
        mcVersion: it.mcVersion,
        loader: it.loader,
        loaderVersion: it.loaderVersion,
        items: []
      }
      map.set(key, g)
    }
    g.items.push(it)
  }
  const groups = [...map.values()]
  for (const g of groups) g.items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  groups.sort((a, b) => (b.items[0]?.createdAt || 0) - (a.items[0]?.createdAt || 0))
  return groups
}
