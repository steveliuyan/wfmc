import React, { useEffect, useMemo, useState } from 'react'
import { api, friendlyError, formatDuration, formatSize, versionTypeLabel, type InstanceDetail } from '../api'
import { useLauncher, useT } from '../store'
import type { Instance, JavaInfo, RemoteVersion } from '../../shared/types'
import Select from '../components/Select'

type PanelKey = 'info' | 'settings' | 'loader'

/**
 * 实例封面。有封面就显示图，没有就显示名字第一个字。
 * 图片由主进程读成 data URL（渲染层直接 <img src="file://…"> 在 dev 下会被拦）。
 * 左键 = 换封面，右键 = 去掉封面（没有封面时右键不做事）。
 */
function InstanceAvatar({
  inst,
  onPick,
  onClear
}: {
  inst: Instance
  onPick: () => void
  onClear: () => void
}) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let alive = true
    if (!inst.icon) {
      setSrc(undefined)
      return
    }
    api
      .shareReadImage(inst.icon)
      .then((d) => {
        if (alive) setSrc(d)
      })
      .catch(() => {
        if (alive) setSrc(undefined)
      })
    return () => {
      alive = false
    }
  }, [inst.icon])

  const letter = (inst.name.trim()[0] ?? '?').toUpperCase()
  return (
    <button
      className={`instance-avatar ${src ? 'has-img' : ''}`}
      title={src ? '点一下换封面，右键去掉封面' : '点一下加封面'}
      onClick={onPick}
      onContextMenu={(e) => {
        if (!src) return
        e.preventDefault()
        onClear()
      }}
    >
      {src ? <img src={src} alt="" /> : <span>{letter}</span>}
    </button>
  )
}

const LOADER_LABEL: Record<string, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  legacyfabric: 'Legacy Fabric',
  cleanroom: 'Cleanroom',
  vanilla: '原版'
}

/** 这里能选/能装的加载器 */
type PickLoader = 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'legacyfabric' | 'cleanroom'

/** 给已有实例补装 / 换加载器（原版实例塞模组用不了，就是从这里装） */
function LoaderPanel({ instance, onDone }: { instance: Instance; onDone: () => Promise<void> }) {
  const { toast, askConfirm } = useLauncher()
  const [loader, setLoader] = useState<PickLoader>('fabric')
  const [versions, setVersions] = useState<{ value: string; label: string }[]>([])
  const [ver, setVer] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  const [installed, setInstalled] = useState<string[]>([])

  // 本地已经装好的版本：用来告诉用户「这个已经装过了，切过去就行，不用重下」
  useEffect(() => {
    let alive = true
    api
      .localVersions(instance.id)
      .then((list) => alive && setInstalled(list))
      .catch(() => alive && setInstalled([]))
    return () => {
      alive = false
    }
  }, [instance.id, instance.versionId])

  useEffect(() => {
    let alive = true
    setVersions([])
    setVer('')
    setErr('')
    setLoading(true)
    api
      .loaderVersions(loader, instance.mcVersion)
      .then((list) => {
        if (!alive) return
        setVersions(list)
        setVer(list[0]?.value ?? '')
        if (list.length === 0) setErr(`没有找到 ${LOADER_LABEL[loader]} 给 ${instance.mcVersion} 用的版本`)
      })
      .catch((e) => {
        if (!alive) return
        setErr(friendlyError(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loader, instance.mcVersion, tick])

  const install = async () => {
    if (!ver) return toast('没选到加载器版本，稍等一下或换个加载器试试', 'info')
    setBusy(true)
    try {
      await api.installLoader(instance.id, loader, ver)
      toast(`装好了：${LOADER_LABEL[loader]} ${ver}，以后启动就走这个版本`, 'success')
      await onDone()
      setInstalled(await api.localVersions(instance.id).catch(() => installed))
    } catch (e) {
      toast(`安装失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const current =
    instance.loader === 'vanilla'
      ? '原版（没装加载器）'
      : `${LOADER_LABEL[instance.loader] ?? instance.loader} ${instance.loaderVersion ?? ''}`

  // 这个「加载器 + 版本」如果在本地已经装过，按钮就只是切过去，不会重下
  const targetId = ver
    ? loader === 'fabric'
      ? `fabric-loader-${ver}-${instance.mcVersion}`
      : loader === 'quilt'
        ? `quilt-loader-${ver}-${instance.mcVersion}`
        : loader === 'legacyfabric'
          ? `legacyfabric-loader-${ver}-${instance.mcVersion}`
          : loader === 'cleanroom'
            ? `cleanroom-${ver}`
            : loader === 'neoforge'
              ? `neoforge-${ver}`
              : `${instance.mcVersion}-forge-${ver}`
    : ''
  const alreadyHave = !!targetId && installed.includes(targetId)

  return (
    <div className="detail loader-panel" data-tour="inst-loader-panel">
      <div className="row wrap loader-now">
        <span className={`badge ${instance.loader}`}>{LOADER_LABEL[instance.loader] ?? instance.loader}</span>
        <span className="muted small">当前：{current}</span>
        {instance.loader === 'vanilla' && (
          <span className="muted small">· 原版一个模组都不加载，要玩模组先在这里装一个</span>
        )}
      </div>

      <div className="form-grid two" style={{ marginTop: 12 }}>
        <label>
          加载器
          <Select
            value={loader}
            width="100%"
            options={[
              { value: 'fabric', label: 'Fabric（轻量、更新快）' },
              { value: 'neoforge', label: 'NeoForge（1.20.2+ 主流）' },
              { value: 'forge', label: 'Forge（老整合包常用）' },
              { value: 'quilt', label: 'Quilt' },
              { value: 'legacyfabric', label: 'Legacy Fabric（1.12.2 及更早）' },
              { value: 'cleanroom', label: 'Cleanroom（1.12.2，要 Java 25）' }
            ]}
            onChange={(v) => setLoader(v as PickLoader)}
          />
        </label>
        <label>
          版本
          <Select
            value={ver}
            width="100%"
            options={versions}
            loading={loading}
            loadingText={`正在拉 ${LOADER_LABEL[loader]} 版本…`}
            onChange={setVer}
            placeholder="先选加载器"
            emptyText={err || '暂无版本'}
            onRetry={() => setTick((v) => v + 1)}
          />
        </label>
      </div>

      {!loading && err && (
        <div className="notice-bar warn" style={{ marginTop: 10 }}>
          {err}
          <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setTick((v) => v + 1)}>
            重新拉取
          </button>
        </div>
      )}
      {!loading && !err && versions.length > 0 && (
        <div className="muted small" style={{ marginTop: 8 }}>
          共 {versions.length} 个 {LOADER_LABEL[loader]} 版本，默认选最新的一个。
        </div>
      )}

      <div className="row wrap" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={busy || loading || !ver} onClick={install}>
          {busy
            ? '安装中…（看右下角任务）'
            : alreadyHave
              ? `切换到这个版本（${LOADER_LABEL[loader]} ${ver} 已装过）`
              : `给这个实例装 ${LOADER_LABEL[loader]}`}
        </button>
        {instance.loader !== 'vanilla' && (
          <button
            className="btn sm ghost"
            disabled={busy}
            title="切回原版后，mods 里的模组不会被加载（文件不会删）"
            onClick={async () => {
              if (
                !(await askConfirm({
                  title: '切回原版',
                  message: `把启动版本切回原版 ${instance.mcVersion}？已装好的 ${LOADER_LABEL[instance.loader]} 版本文件会留着，mods 里的模组不会被加载，想用随时再切回来。`,
                  okText: '切回原版'
                }))
              )
                return
              setBusy(true)
              try {
                await api.updateInstance(instance.id, {
                  loader: 'vanilla',
                  loaderVersion: undefined,
                  versionId: instance.mcVersion
                })
                toast(`已切回原版 ${instance.mcVersion}（存档、mods 都在）`, 'success')
                await onDone()
              } catch (e) {
                toast(`切换失败：${friendlyError(e)}`, 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            切回原版
          </button>
        )}
        <span className="muted small">
          {alreadyHave
            ? '这个版本本地已经有了，点一下只是把启动版本切过去，不会重新下载任何文件。'
            : `装完会新建 ${instance.mcVersion} 的 ${LOADER_LABEL[loader]} 版本并自动切过去，原来的存档 / mods 都不动。`}
        </span>
      </div>
    </div>
  )
}

export default function Instances() {
  const t = useT()
  const { instances, refreshInstances, currentId, setCurrentId, toast , askConfirm, askPrompt } = useLauncher()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState('vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [remote, setRemote] = useState<RemoteVersion[]>([])
  const [loaders, setLoaders] = useState<{ value: string; label: string }[]>([])
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [loaderErr, setLoaderErr] = useState('')
  const [verTick, setVerTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Record<string, InstanceDetail>>({})
  const [javas, setJavas] = useState<JavaInfo[]>([])
  const [presets, setPresets] = useState<{ id: string; name: string; desc: string; memoryMb: number }[]>([])
  const [packInfo, setPackInfo] = useState('')
  // 有没有可升级的整合包新版本（决定要不要显示「就地升级」按钮）
  const [packUpdatable, setPackUpdatable] = useState(false)
  // 卡片里的折叠面板：一次只开一个，收起/展开都有动画
  const [openPanel, setOpenPanel] = useState<{ id: string; key: PanelKey }>()
  const [visiblePanel, setVisiblePanel] = useState<{ id: string; key: PanelKey }>()
  // 正在删的实例（按钮显示「删除中…」；真正的进度条在右下角任务面板）
  const [deleting, setDeleting] = useState('')
  // 卡片标题就地改名：editingName = 正在改的那个实例 id，nameDraft 是输入框里的字
  const [editingName, setEditingName] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  // 列表排序：置顶永远在最前，其余按这个模式排（存本地，重开软件还是上次选的）
  const [sortMode, setSortMode] = useState<'recent' | 'name' | 'group'>(
    () => (localStorage.getItem('instSort') as 'recent' | 'name' | 'group') || 'recent'
  )
  const changeSort = (mode: 'recent' | 'name' | 'group') => {
    setSortMode(mode)
    localStorage.setItem('instSort', mode)
  }
  // 排好的列表：先按置顶，再按选定的模式（分组模式下同一组的挨在一起，组名按拼音排）
  const shown = useMemo(() => {
    const arr = [...instances]
    arr.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
      if (sortMode === 'name') return a.name.localeCompare(b.name, 'zh')
      if (sortMode === 'group') {
        const g = (a.group ?? '').localeCompare(b.group ?? '', 'zh')
        if (g) return g
        return (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)
      }
      return (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0)
    })
    return arr
  }, [instances, sortMode])

  /** 换封面：系统选图框选一张，主进程拷进实例目录；选了就刷新卡片 */
  const pickIcon = async (i: Instance) => {
    try {
      const next = await api.pickInstanceIcon(i.id)
      if (!next) return
      await refreshInstances()
      toast('封面换好了', 'success')
    } catch (e) {
      toast(`换封面失败：${friendlyError(e)}`, 'error')
    }
  }

  /** 分组：输入框留空 = 不分组 */
  const editGroup = async (i: Instance) => {
    const g = await askPrompt({
      title: '给这个实例分组',
      message: '同一个分组的实例会排在一起。留空就是不分组。',
      defaultValue: i.group ?? '',
      placeholder: '例如：整合包 / 原版生存 / 和朋友联机',
      maxLength: 20
    })
    if (g === undefined) return
    try {
      await api.setInstanceMeta(i.id, { group: g })
      await refreshInstances()
      toast(g ? `已分到「${g}」` : '已取消分组', 'success')
    } catch (e) {
      toast(`分组失败：${friendlyError(e)}`, 'error')
    }
  }

  const togglePin = async (i: Instance) => {
    try {
      await api.setInstanceMeta(i.id, { pinned: !i.pinned })
      await refreshInstances()
    } catch (e) {
      toast(`置顶失败：${friendlyError(e)}`, 'error')
    }
  }

  const togglePanel = (id: string, key: PanelKey) => {
    const isOpen = openPanel?.id === id && openPanel.key === key
    if (isOpen) {
      setOpenPanel(undefined)
      // 等收起动画跑完再卸载内容，否则会「啪」一下消失
      window.setTimeout(() => setVisiblePanel((v) => (v && v.id === id && v.key === key ? undefined : v)), 360)
      return
    }
    setOpenPanel({ id, key })
    setVisiblePanel({ id, key })
    if (key === 'info') void fetchDetail(id)
  }

  useEffect(() => {
    api.perfPresets().then(setPresets)
  }, [])

  useEffect(() => {
    api.remoteVersions().then((list) => {
      setRemote(list)
      if (!mcVersion && list.length) setMcVersion(list.find((v) => v.type === 'release')?.id ?? list[0].id)
    })
    api.scanJava().then(setJavas)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (loader === 'vanilla' || !mcVersion) {
      setLoaders([])
      setLoaderVersion('')
      setLoaderErr('')
      setLoaderLoading(false)
      return
    }
    let alive = true
    setLoaderLoading(true)
    setLoaderErr('')
    api
      .loaderVersions(loader, mcVersion)
      .then((list) => {
        if (!alive) return
        setLoaders(list)
        setLoaderVersion(list[0]?.value ?? '')
        if (!list.length) setLoaderErr(`没有找到 ${LOADER_LABEL[loader]} 给 ${mcVersion} 用的版本`)
      })
      .catch((e) => {
        if (!alive) return
        setLoaderErr(friendlyError(e))
      })
      .finally(() => {
        if (alive) setLoaderLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, mcVersion, verTick])

  const create = async (installNow: boolean) => {
    if (!mcVersion) return toast('先选游戏版本', 'error')
    setBusy(true)
    try {
      const instance = await api.createInstance({
        name: name || `${mcVersion}${loader !== 'vanilla' ? `-${loader}` : ''}`,
        mcVersion,
        loader,
        loaderVersion: loader === 'vanilla' ? undefined : loaderVersion
      })
      await refreshInstances()
      setCurrentId(instance.id)
      setCreating(false)
      setName('')
      if (installNow) {
        toast('开始安装…')
        await api.installGame(instance.id)
        await refreshInstances()
        toast('安装完成', 'success')
      } else {
        toast('实例已创建，点首页启动会自动补全文件', 'success')
      }
    } catch (e) {
      toast(`创建失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const fetchDetail = async (id: string) => {
    const d = await api.instanceDetail(id)
    setDetail((prev) => ({ ...prev, [id]: d }))
  }

  const patch = async (id: string, p: Parameters<typeof api.updateInstance>[1]) => {
    await api.updateInstance(id, p)
    await refreshInstances()
    if (detail[id]) setDetail((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }))
  }

  /**
   * 就地改名：Enter 保存 / Esc 取消 / 点别处（失焦）保存。
   * 只改显示名，游戏目录和云端备份的键都不动，所以改名是「瞬间完成」的，
   * 不用等任何文件操作；之后云端备份会自动带上新名字。
   */
  const commitRename = async (i: Instance) => {
    const name = nameDraft.trim()
    setEditingName('')
    setNameDraft('')
    if (!name || name === i.name) return
    try {
      const r = await api.renameInstance(i.id, name)
      await refreshInstances()
      toast(
        r.cloudSync === 'queued'
          ? `已改名为「${r.instance.name}」，云端备份会自动跟着更新`
          : r.cloudSync === 'not-logged-in'
            ? `已改名为「${r.instance.name}」（还没登录统一账号，只改了本机）`
            : `已改名为「${r.instance.name}」（自动备份是关的，只改了本机）`,
        'success'
      )
    } catch (e) {
      toast(`改名失败：${friendlyError(e)}`, 'error')
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('实例', 'Instances')}</h1>
          <p className="muted">每个实例是一套独立的 .minecraft，模组/光影/存档互不干扰。</p>
        </div>
        <div className="row">
          {instances.length > 1 && (
            <label className="sort-pick" title="排序方式（置顶的永远在最前面）">
              <span className="muted">排序</span>
              <select
                value={sortMode}
                onChange={(e) => changeSort(e.target.value as 'recent' | 'name' | 'group')}
              >
                <option value="recent">最近玩过</option>
                <option value="name">按名字</option>
                <option value="group">按分组</option>
              </select>
            </label>
          )}
          <button
            className="btn"
            onClick={async () => {
              try {
                const instance = await api.pickImportInstance()
                if (!instance) return
                await refreshInstances()
                setCurrentId(instance.id)
                toast(`已导入实例：${instance.name}`, 'success')
              } catch (e) {
                toast(`导入失败：${friendlyError(e)}`, 'error')
              }
            }}
          >
            导入实例包
          </button>
          <button className="btn primary" onClick={() => setCreating((v) => !v)}>
            {creating ? '取消' : '新建实例'}
          </button>
        </div>
      </header>

      {creating && (
        <div className="card">
          <h3>新建实例</h3>
          <div className="form-grid">
            <label>
              名称
              <input value={name} placeholder="例如 1.20.1 生存" onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              游戏版本
              <Select
                value={mcVersion}
                width="100%"
                options={remote.map((v) => ({ value: v.id, label: `${v.id}（${versionTypeLabel(v)}）` }))}
                onChange={setMcVersion}
                placeholder="选游戏版本"
              />
            </label>
            <label>
              加载器
              <Select
                value={loader}
                width="100%"
                options={[
                  { value: 'vanilla', label: '原版（不加载任何模组）' },
                  { value: 'fabric', label: 'Fabric' },
                  { value: 'quilt', label: 'Quilt' },
                  { value: 'forge', label: 'Forge' },
                  { value: 'neoforge', label: 'NeoForge' },
                  { value: 'legacyfabric', label: 'Legacy Fabric（1.12.2 及更早）' },
                  { value: 'cleanroom', label: 'Cleanroom（1.12.2，要 Java 25）' }
                ]}
                onChange={setLoader}
              />
            </label>
            {loader !== 'vanilla' && (
              <label>
                加载器版本
                <Select
                  value={loaderVersion}
                  width="100%"
                  options={loaders}
                  loading={loaderLoading}
                  loadingText={`正在拉 ${LOADER_LABEL[loader] ?? loader} 版本…`}
                  onChange={setLoaderVersion}
                  emptyText={loaderErr || '暂无版本'}
                  onRetry={() => setVerTick((v) => v + 1)}
                />
              </label>
            )}
          </div>
          {loaderErr && !loaderLoading && (
            <div className="notice-bar warn" style={{ marginTop: 10 }}>
              {loaderErr}
              <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setVerTick((v) => v + 1)}>
                重新拉取
              </button>
            </div>
          )}
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => create(true)}>
              {busy ? '安装中…' : '创建并立即安装'}
            </button>
            <button className="btn" disabled={busy} onClick={() => create(false)}>
              仅创建
            </button>
          </div>
        </div>
      )}

      <div className="cards">
        {instances.length === 0 && <div className="card empty">没有实例。点右上角新建，或去「下载游戏」装整合包。</div>}
        {shown.map((i) => {
          const d = detail[i.id]
          const openKey = openPanel?.id === i.id ? openPanel.key : undefined
          const mountedKey = visiblePanel?.id === i.id ? visiblePanel.key : undefined
          return (
            <div
              className={`card instance ${i.id === currentId ? 'current' : ''}`}
              key={i.id}
              data-tour={i === instances[0] ? 'inst-card' : undefined}
            >
              <div className="instance-head">
                <InstanceAvatar
                  inst={i}
                  onPick={() => void pickIcon(i)}
                  onClear={async () => {
                    if (
                      !(await askConfirm({
                        title: '去掉封面',
                        message: '只是把卡片上这张图去掉，游戏文件一点不动。',
                        okText: '去掉'
                      }))
                    )
                      return
                    try {
                      await api.clearInstanceIcon(i.id)
                      await refreshInstances()
                    } catch (e) {
                      toast(`去掉封面失败：${friendlyError(e)}`, 'error')
                    }
                  }}
                />
                {editingName === i.id ? (
                  <input
                    className="rename-input"
                    autoFocus
                    maxLength={40}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void commitRename(i)
                      else if (e.key === 'Escape') {
                        setEditingName('')
                        setNameDraft('')
                      }
                    }}
                    onBlur={() => void commitRename(i)}
                  />
                ) : (
                  <h3
                    title="双击改名"
                    onDoubleClick={() => {
                      setEditingName(i.id)
                      setNameDraft(i.name)
                    }}
                  >
                    {i.name}
                  </h3>
                )}
                <span className="head-right">
                  {i.group && (
                    <span className="badge group" title="分组（点下面的「分组」改）">
                      {i.group}
                    </span>
                  )}
                  <span className={`badge ${i.loader}`}>{i.loader}</span>
                  <button
                    className={`pin-btn ${i.pinned ? 'on' : ''}`}
                    title={i.pinned ? '取消置顶' : '置顶'}
                    aria-label={i.pinned ? '取消置顶' : '置顶'}
                    onClick={() => void togglePin(i)}
                  >
                    {i.pinned ? '★' : '☆'}
                  </button>
                </span>
              </div>
              <div className="muted small">
                {i.mcVersion}
                {i.loaderVersion ? ` · ${i.loaderVersion}` : ''} {i.installed ? '· 已安装' : '· 未安装'}
              </div>
              <div className="muted small">游玩 {formatDuration(i.playTimeMs)}</div>

              <div className="row wrap">
                <button className="btn sm" onClick={() => setCurrentId(i.id)}>
                  {i.id === currentId ? '当前实例' : '设为当前'}
                </button>
                {(
                  [
                    ['info', '概况'],
                    ['settings', '设置'],
                    ['loader', '加载器']
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    className={`btn sm seg ${openKey === key ? 'on' : ''}`}
                    onClick={() => togglePanel(i.id, key)}
                    aria-expanded={openKey === key}
                    data-tour={i === instances[0] ? `inst-seg-${key}` : undefined}
                  >
                    {label}
                    <i className={`chev ${openKey === key ? 'up' : ''}`}>▾</i>
                  </button>
                ))}
                <button
                  className="btn sm"
                  onClick={() => {
                    setEditingName(i.id)
                    setNameDraft(i.name)
                  }}
                >
                  {t('改名', 'Rename')}
                </button>
                <button className="btn sm" onClick={() => void editGroup(i)}>
                  {t('分组', 'Group')}
                </button>
                <button className="btn sm" onClick={() => api.openInstanceFolder(i.id)}>
                  目录
                </button>
                <button
                  className="btn sm danger"
                  disabled={deleting === i.id}
                  onClick={async () => {
                    if (deleting === i.id) return
                    // 先量一下：告诉用户到底要删多少，别只丢一句「确定？」
                    const size = await api.instanceDeleteSize(i.id).catch(() => ({ files: 0, bytes: 0 }))
                    const what =
                      size.files > 0
                        ? `${size.files.toLocaleString('zh-CN')} 个文件、约 ${formatSize(size.bytes)}`
                        : '游戏文件'
                    if (
                      !(await askConfirm({
                        title: '删除实例',
                        message: `「${i.name}」会连同游戏文件一起删除（${what}），删掉就找不回来了，确定？`,
                        okText: '删除',
                        danger: true
                      }))
                    )
                      return
                    setDeleting(i.id)
                    try {
                      await api.deleteInstance(i.id, true)
                      await refreshInstances()
                      toast('实例已删除', 'success')
                    } catch (e) {
                      toast(`删除失败：${friendlyError(e)}`, 'error')
                    } finally {
                      setDeleting('')
                    }
                  }}
                >
                  {deleting === i.id ? '删除中…' : '删除'}
                </button>
              </div>

              <div className={`acc ${openKey ? 'open' : ''}`}>
                <div className="acc-inner">
                  {mountedKey === 'loader' && (
                    <LoaderPanel
                      instance={i}
                      onDone={async () => {
                        await refreshInstances()
                        await fetchDetail(i.id)
                      }}
                    />
                  )}

                  {mountedKey === 'settings' && (
                    <div className="detail">
                      <div className="form-grid two">
                    <label>
                      最大内存 (MB)
                      <input
                        type="number"
                        defaultValue={i.maxMemory ?? 4096}
                        onBlur={(e) => patch(i.id, { maxMemory: Number(e.target.value) || 4096 })}
                      />
                    </label>
                    <label>
                      最小内存 (MB)
                      <input
                        type="number"
                        defaultValue={i.minMemory ?? 1024}
                        onBlur={(e) => patch(i.id, { minMemory: Number(e.target.value) || 1024 })}
                      />
                    </label>
                    <label>
                      指定 Java
                      <Select
                        value={i.javaPath ?? ''}
                        width="100%"
                        options={[{ value: '', label: '跟随全局设置' }, ...javas.map((j) => ({ value: j.path, label: `Java ${j.majorVersion}` }))]}
                        onChange={(v) => patch(i.id, { javaPath: v || undefined })}
                      />
                    </label>
                    <label>
                      窗口大小
                      <div className="row">
                        <input
                          type="number"
                          placeholder="854"
                          defaultValue={i.resolution?.width ?? 854}
                          onBlur={(e) =>
                            patch(i.id, {
                              resolution: {
                                width: Number(e.target.value) || 854,
                                height: i.resolution?.height ?? 480,
                                fullscreen: i.resolution?.fullscreen
                              }
                            })
                          }
                        />
                        <span className="muted">×</span>
                        <input
                          type="number"
                          placeholder="480"
                          defaultValue={i.resolution?.height ?? 480}
                          onBlur={(e) =>
                            patch(i.id, {
                              resolution: {
                                width: i.resolution?.width ?? 854,
                                height: Number(e.target.value) || 480,
                                fullscreen: i.resolution?.fullscreen
                              }
                            })
                          }
                        />
                      </div>
                    </label>
                    <label>
                      额外 JVM 参数
                      <input
                        placeholder="-XX:+UseG1GC"
                        defaultValue={(i.extraJvmArgs ?? []).join(' ')}
                        onBlur={(e) => patch(i.id, { extraJvmArgs: e.target.value.split(/\s+/).filter(Boolean) })}
                      />
                    </label>
                    <label>
                      启动直连服务器
                      <input
                        placeholder="mc.example.com:25565"
                        defaultValue={i.server?.ip ? `${i.server.ip}${i.server.port ? ':' + i.server.port : ''}` : ''}
                        onBlur={(e) => {
                          const [ip, port] = e.target.value.split(':')
                          patch(i.id, { server: ip ? { ip, port: port ? Number(port) : undefined } : undefined })
                        }}
                      />
                    </label>
                  </div>
                  <div className="mini-label" style={{ marginTop: 10 }}>性能预设（一键套 JVM 参数 + options.txt）</div>
                  <div className="row wrap">
                    {presets.map((preset) => (
                      <button
                        key={preset.id}
                        className={`chip ${i.perfPreset === preset.id ? 'on' : ''}`}
                        title={preset.desc}
                        onClick={async () => {
                          try {
                            await api.applyPerfPreset(i.id, preset.id)
                            await refreshInstances()
                            await fetchDetail(i.id)
                            toast(`已套用「${preset.name}」：${preset.memoryMb}MB`, 'success')
                          } catch (e) {
                            toast(`套用失败：${friendlyError(e)}`, 'error')
                          }
                        }}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                  <div className="switch-list">
                    <label className="switch-row">
                      <span className="switch-text">
                        <span className="switch-title">版本数据隔离</span>
                        <span className="switch-desc">
                          每个版本独立的存档 / mods / config，libraries 和 assets 仍共享
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        className="switch"
                        checked={!!i.isolate}
                        onChange={(e) => patch(i.id, { isolate: e.target.checked })}
                      />
                    </label>
                    <label className="switch-row">
                      <span className="switch-text">
                        <span className="switch-title">全屏启动</span>
                        <span className="switch-desc">进游戏直接全屏，不想全屏就关掉</span>
                      </span>
                      <input
                        type="checkbox"
                        className="switch"
                        checked={!!i.resolution?.fullscreen}
                        onChange={(e) =>
                          patch(i.id, {
                            resolution: {
                              width: i.resolution?.width ?? 854,
                              height: i.resolution?.height ?? 480,
                              fullscreen: e.target.checked
                            }
                          })
                        }
                      />
                    </label>
                  </div>
                    </div>
                  )}

                  {mountedKey === 'info' && d && (
                    <div className="detail">
                      <div className="muted small">目录：{d.gameDir}</div>
                  <div className="muted small">
                    体积 {formatSize(d.diskUsage)} · 模组 {d.counts.mods} · 资源包 {d.counts.resourcepacks} · 光影{' '}
                    {d.counts.shaderpacks} · 存档 {d.counts.saves}
                  </div>
                  <div className="version-list" data-tour="inst-versions">
                    <div className="mini-label">已装版本</div>
                    {d.versions.length === 0 && <div className="muted small">还没装</div>}
                    {d.versions.map((v) => (
                      <div className="version-row" key={v}>
                        <span>
                          {v}
                          {v === d.versionId ? <span className="badge ok">启动用</span> : null}
                        </span>
                        <span className="row">
                          {v !== d.versionId && (
                            <button
                              className="btn sm"
                              onClick={async () => {
                                await patch(i.id, { versionId: v })
                                toast(`启动版本切换为 ${v}`, 'success')
                              }}
                            >
                              用这个启动
                            </button>
                          )}
                          <button
                            className="btn sm danger"
                            onClick={async () => {
                              if (!(await askConfirm({ title: '删除版本', message: `删掉版本 ${v} 的文件？`, okText: '删除', danger: true }))) return
                              await api.deleteVersion(i.id, v)
                              await fetchDetail(i.id)
                              await fetchDetail(i.id)
                            }}
                          >
                            删除
                          </button>
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="row wrap">
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          const res = await api.checkPackUpdate(i.id)
                          setPackInfo(`${res.note}${res.latestVersion ? `（本地 ${res.currentVersion ?? '?'} → 最新 ${res.latestVersion}）` : ''}`)
                          setPackUpdatable(!!res.hasUpdate && !!res.downloadUrl)
                          toast(res.note, res.hasUpdate ? 'success' : 'info')
                        } catch (e) {
                          toast(`检查失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      检查整合包更新
                    </button>
                    {packUpdatable && (
                      <button
                        className="btn sm primary"
                        title="只更新整合包内容，你改过的配置 / 键位 / 存档都会保留"
                        onClick={async () => {
                          if (
                            !(await askConfirm({
                              title: '升级整合包',
                              message:
                                '就地升级到新版本？\n\n· 你改过的配置会保留，新版文件放在同目录的 .packnew 里可以对比\n· 被你删掉、但你动过的文件不会被删\n· 存档不会动，但为防万一建议先备份',
                              okText: '升级'
                            }))
                          ) {
                            return
                          }
                          try {
                            const r = await api.upgradePack(i.id)
                            if (!r.hasUpdate) return toast(r.note, 'info')
                            setPackInfo(r.note)
                            setPackUpdatable(false)
                            toast(r.note, 'success')
                            if (r.keptModified.length > 0) {
                              toast(
                                `这些文件你改过，已保留本地版本：${r.keptModified.slice(0, 3).join('、')}${
                                  r.keptModified.length > 3 ? ` 等 ${r.keptModified.length} 个` : ''
                                }`,
                                'info'
                              )
                            }
                            await fetchDetail(i.id)
                          } catch (e) {
                            toast(`升级失败：${friendlyError(e)}`, 'error')
                          }
                        }}
                      >
                        就地升级（保留你的配置）
                      </button>
                    )}
                    {packInfo && <span className="muted small">{packInfo}</span>}
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const p = await api.exportInstance(i.id)
                        toast(`已导出：${p}`, 'success')
                      }}
                    >
                      导出实例(zip)
                    </button>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          toast('正在识别 mod 来源并打包…')
                          const p = await api.exportMrpack(i.id)
                          toast(`已导出整合包：${p}`, 'success')
                        } catch (e) {
                          toast(`导出失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      导出为整合包(.mrpack)
                    </button>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          const ready = await api.cfExportReady(i.id)
                          if (!ready.hasKey) {
                            toast('没配 CurseForge API key：导出仍可用，但所有 mod 会整包塞进 overrides（包体会大很多）', 'info')
                          } else if (ready.mods > 0) {
                            toast(`正在向 CurseForge 认领 ${ready.mods} 个 mod…`)
                          }
                          const r = await api.exportCfZip(i.id)
                          toast(
                            r.usedKey
                              ? `已导出：${r.path}（${r.matched} 个对上 CurseForge，${r.unmatched} 个进 overrides）`
                              : `已导出：${r.path}（${r.unmatched} 个 mod 全在 overrides 里）`,
                            'success'
                          )
                        } catch (e) {
                          toast(`导出失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      导出为 CurseForge 包(.zip)
                    </button>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          const pv = await api.serverPackPreview(i.id)
                          const names = pv.clientOnly
                            .slice(0, 6)
                            .map((x) => x.file)
                            .join('、')
                          const tail = pv.clientOnly.length > 6 ? '…' : ''
                          const ok = await askConfirm({
                            title: '导出服务端整合包',
                            message:
                              pv.clientOnly.length === 0
                                ? `没有需要剔除的纯客户端 mod，会带上 ${pv.loader} 服务端和启动脚本。`
                                : `会剔除 ${pv.clientOnly.length} 个纯客户端 mod（保留 ${pv.keep} 个），并带上 ${pv.loader} 服务端和启动脚本。剔除的是：${names}${tail}`
                          })
                          if (!ok) return
                          toast('正在生成服务端包…')
                          const r = await api.exportServerPack(i.id)
                          toast(`已导出服务端包：保留 ${r.keep} 个 mod，剔除 ${r.removed.length} 个`, 'success')
                        } catch (e) {
                          toast(`导出失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      导出为服务端包(.zip)
                    </button>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const copy = await api.duplicateInstance(i.id)
                        await refreshInstances()
                        toast(`已复制为 ${copy.name}`, 'success')
                      }}
                    >
                      复制实例
                    </button>
                  </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
