import React, { useEffect, useState } from 'react'
import { api, formatSize, friendlyError, type ModIssue, type ModUpdateItem } from '../api'
import { useLauncher, useT } from '../store'
import type { ContentItem, ContentKind, CrashDiagnosis, CrashReport } from '../../shared/types'
import type { PageId } from '../App'

type Tab = ContentKind | 'crash' | 'log' | 'updates' | 'shots' | 'datapacks'

const tabs: { id: Tab; label: string }[] = [
  { id: 'mods', label: '模组' },
  { id: 'resourcepacks', label: '资源包' },
  { id: 'shaderpacks', label: '光影' },
  { id: 'saves', label: '存档' },
  { id: 'datapacks', label: '数据包' },
  { id: 'shots', label: '截图' },
  { id: 'updates', label: 'Mod 更新' },
  { id: 'crash', label: '崩溃报告' },
  { id: 'log', label: '运行日志' }
]

export default function Manage({ goto }: { goto: (p: PageId) => void }) {
  const { current, currentId, toast, logs, clearLogs, askConfirm, instances, settings, saveSettings, refreshInstances } =
    useLauncher()
  const t = useT()
  const [tab, setTab] = useState<Tab>('mods')
  // 内容管理自己的目标实例：不用跑回首页/实例页去切
  const [targetId, setTargetId] = useState('')
  const [items, setItems] = useState<ContentItem[]>([])
  const [crashes, setCrashes] = useState<CrashReport[]>([])
  const [crashText, setCrashText] = useState('')
  const [diagnosis, setDiagnosis] = useState<CrashDiagnosis | undefined>()
  const [updates, setUpdates] = useState<ModUpdateItem[]>([])
  const [shots, setShots] = useState<{ name: string; path: string; size: number; time: number }[]>([])
  const [modIssues, setModIssues] = useState<ModIssue[]>([])
  // 体检结果 15 秒后自动收起，不占着页面
  useEffect(() => {
    if (modIssues.length === 0) return
    const timer = setTimeout(() => setModIssues([]), 15_000)
    return () => clearTimeout(timer)
  }, [modIssues])
  const [packOrder, setPackOrder] = useState<string[]>([])
  const [langCov, setLangCov] = useState<{
    packs: { name: string; count: number }[]
    coveredCount: number
    mods: { id: string; name: string; covered: boolean; selfChinese: boolean }[]
  }>()
  const [worlds, setWorlds] = useState<string[]>([])
  const [world, setWorld] = useState('')
  const [packs, setPacks] = useState<ContentItem[]>([])
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(false)

  const isContent = tab !== 'crash' && tab !== 'log' && tab !== 'updates' && tab !== 'shots' && tab !== 'datapacks'

  // 目标实例：默认跟随左侧当前实例，但可以在这里直接换
  const target = instances.find((i) => i.id === targetId) ?? current
  const activeId = target?.id ?? currentId ?? ''
  useEffect(() => {
    if (!targetId && currentId) setTargetId(currentId)
  }, [currentId, targetId])

  const refreshShots = async () => {
    if (!activeId) return
    setShots(await api.screenshots(activeId))
  }

  const refresh = async () => {
    if (!activeId) return
    setLoading(true)
    try {
      if (isContent) setItems(await api.listContent(activeId, tab as ContentKind))
      else if (tab === 'crash') setCrashes(await api.crashReports(activeId))
      else if (tab === 'shots') setShots(await api.screenshots(activeId))
    } catch (e) {
      toast(`读取失败：${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
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
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
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
              <select value={activeId} onChange={(e) => setTargetId(e.target.value)}>
                {instances.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}（{i.mcVersion}
                    {i.loader !== 'vanilla' ? ` · ${i.loader}` : ''}）
                    {i.installed ? '' : ' · 未安装'}
                  </option>
                ))}
              </select>
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
            <>
              已装汉化包：<b>{langCov.packs.map((p) => `${p.name}（${p.count} 个模组）`).join(' + ')}</b>，
              合计收录 <b>{langCov.coveredCount}</b> 个模组的中文。这里的 {langCov.mods.length} 个模组里：
              {langCov.mods.filter((m) => m.covered || m.selfChinese).length > 0 && (
                <>
                  {' '}
                  <b className="ok-text">
                    {langCov.mods
                      .filter((m) => m.covered || m.selfChinese)
                      .map((m) => m.name)
                      .join('、')}
                  </b>{' '}
                  有中文；
                </>
              )}
              {langCov.mods.filter((m) => !m.covered && !m.selfChinese).length > 0 ? (
                <>
                  {' '}
                  <b className="warn-text">
                    {langCov.mods
                      .filter((m) => !m.covered && !m.selfChinese)
                      .map((m) => m.name)
                      .join('、')}
                  </b>{' '}
                  汉化包里没有它们的语言文件，界面还是英文——这类只能等汉化组收录，或者去找作者自己发布的中文语言文件塞进 jar。
                  <span className="muted small">
                    （另外：模组里直接写死的文字，比如标题栏那种，资源包也翻不了，那是作者代码里的字符串。）
                  </span>
                </>
              ) : (
                langCov.mods.length > 0 && <> 全部有中文了。</>
              )}
            </>
          ) : (
            <>还没装汉化包。装模组后界面是英文的话，点上面的「装中文汉化包」。</>
          )}
        </div>
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
              onClick={async () => {
                try {
                  const res = await api.diagnoseMods(activeId)
                  setModIssues(res.issues)
                  toast(`体检完成：扫描 ${res.mods.length} 个 mod`, 'success')
                } catch (e) {
                  toast(`体检失败：${(e as Error).message}`, 'error')
                }
              }}
            >
              体检模组（重复 / 加载器 / 前置）
            </button>
            <span className="muted small">读每个 jar 里的元数据，离线可跑。结果 15 秒后自己收起来</span>
          </div>
          {modIssues.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="row-between" style={{ border: 'none', marginBottom: 6 }}>
                <span className="mini-label">体检结果（{modIssues.length}）</span>
                <button className="btn sm ghost" onClick={() => setModIssues([])}>
                  ✕ 收起
                </button>
              </div>
              {modIssues.map((issue, i) => (
                <div className={`diag-item lv-${issue.level}`} key={i}>
                  <div className="diag-title">
                    <span className={`badge ${issue.level === 'error' ? 'warn' : ''}`}>
                      {issue.level === 'error' ? '错误' : issue.level === 'warn' ? '警告' : '提示'}
                    </span>
                    {issue.title}
                  </div>
                  <div className="diag-advice">{issue.detail}</div>
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
              <button
                className="btn"
                onClick={async () => {
                  const p = await api.backupSaves(activeId)
                  p ? toast(`已备份到 ${p}`, 'success') : toast('存档目录是空的', 'info')
                }}
              >
                备份所有存档
              </button>
            )}
            <span className="muted small">共 {items.length} 项{loading ? ' · 读取中…' : ''}</span>
          </div>
        </div>
      )}

      {isContent && (
        <div className="card">
          {items.length === 0 && <div className="muted small">这个目录还是空的。可以点上面的「导入本地文件」。</div>}
          <div className="file-list">
            {items.map((item) => (
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
                    {item.version && <span className="badge">v{item.version}</span>}
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

      {tab === 'shots' && (
        <div className="card">
          <div className="row wrap">
            <button className="btn" onClick={refreshShots}>
              刷新
            </button>
            <button className="btn" onClick={() => api.openScreenshotsDir(activeId)}>
              打开截图目录
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
                  const p = await api.exportDiagnostics(activeId)
                  toast(`诊断包已导出：${p}`, 'success')
                } catch (e) {
                  toast(`导出失败：${(e as Error).message}`, 'error')
                }
              }}
            >
              导出诊断包（日志+崩溃+mod 清单）
            </button>
            <span className="muted small">{lines.length} 行</span>
          </div>
          <pre className="log" style={{ height: 420, marginTop: 10 }}>
            {lines.length ? lines.join('\n') : '还没有日志，去首页启动一次游戏。'}
          </pre>
        </div>
      )}
    </div>
  )
}
