import React, { useEffect, useMemo, useState } from 'react'
import { api, formatSize } from '../api'
import { useLauncher, useT } from '../store'
import SourcePicker from '../components/SourcePicker'
import Select from '../components/Select'
import { SkeletonCards } from '../components/Skeleton'
import type { ContentItem, DepItem, FavResource, InstallPlan, ResourceHit, ResourceVersion } from '../../shared/types'

type Kind = 'mod' | 'shader' | 'resourcepack'

const kindLabel: Record<Kind, string> = { mod: '模组', shader: '光影', resourcepack: '资源包' }

/** 中文资源站：Modrinth/CurseForge 搜不到中文时，这几家是中文玩家真正在用的地方 */
const SITES: { name: string; url: string; note: string }[] = [
  { name: 'MC 百科', url: 'https://www.mcmod.cn/', note: '中文模组 / 整合包百科，最全的中文名索引' },
  { name: '中文 Minecraft Wiki', url: 'https://zh.minecraft.wiki/', note: '官方中文百科，机制 / 物品 / 版本' },
  { name: '光影大全', url: 'https://www.minecraftzw.com/tag/shader', note: '中文光影整合站' },
  { name: '服务器列表', url: 'https://www.mcshuo.com/', note: '中文服务器列表' },
  { name: 'MCBBS', url: 'https://www.mcbbs.co/forum.php', note: '中文论坛，模组 / 整合包讨论区' }
]


// 上次的结果缓存：再进这个页面先秒显，网络回来再覆盖
const hitCache: Record<string, ResourceHit[]> = {}

function DepLine({ d }: { d: DepItem }) {
  return (
    <div className="dep-row">
      <span className={`dep-badge ${d.dependencyType === 'required' ? 'req' : d.dependencyType === 'incompatible' ? 'bad' : 'opt'}`}>
        {d.dependencyType === 'required' ? '必需' : d.dependencyType === 'incompatible' ? '冲突' : '可选'}
      </span>
      <span className="ellipsis">{d.title}</span>
      {d.versionName && <span className="muted small">{d.versionName}</span>}
      {d.alreadyInstalled && <span className="dep-badge ok">已有</span>}
      {d.error && <span className="dep-warn">{d.error}</span>}
    </div>
  )
}
export default function Resources({ goto }: { goto?: (p: 'settings') => void }) {
  const t = useT()
  const { current, currentId, instances, toast, progress, settings, saveSettings } = useLauncher()
  const [kind, setKind] = useState<Kind>('mod')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ResourceHit[]>([])
  const [searching, setSearching] = useState(false)
  const [mcVersion, setMcVersion] = useState('')
  const [loaderFilter, setLoaderFilter] = useState('')
  const [versions, setVersions] = useState<Record<string, ResourceVersion[]>>({})
  const [busy, setBusy] = useState('')
  const [sort, setSort] = useState<'downloads' | 'follows' | 'newest' | 'relevance'>('downloads')
  const [netError, setNetError] = useState(false)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(0)
  const [cfQuery, setCfQuery] = useState('')
  const [cfHits, setCfHits] = useState<{ id: number; name: string; summary: string; downloadCount: number; logoUrl?: string }[]>([])
  const [cfBusy, setCfBusy] = useState(false)
  const [cfCn, setCfCn] = useState<{ matched: boolean; used: string[] } | undefined>()
  const cfKey = (settings?.curseforgeApiKey ?? '').trim()
  // 安装目标：默认跟左侧「当前实例」走，但这里可以单独改（下两个版本时就能各装各的）
  const [targetId, setTargetId] = useState('')
  const [plan, setPlan] = useState<{ hit: ResourceHit; versionId?: string; data: InstallPlan } | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  // 收藏 + 中文名提示
  const [favOnly, setFavOnly] = useState(false)
  const [mcmodQuery, setMcmodQuery] = useState('')
  const openMcmod = () => {
    const q = mcmodQuery.trim()
    if (!q) return
    api.openExternal(`https://search.mcmod.cn/s?key=${encodeURIComponent(q)}`)
  }
  const [cnInfo, setCnInfo] = useState<{ matched: boolean; used: string[] } | undefined>()
  const [files, setFiles] = useState<{ mods: ContentItem[]; shaderpacks: ContentItem[]; resourcepacks: ContentItem[] }>({
    mods: [],
    shaderpacks: [],
    resourcepacks: []
  })

  const favs = settings?.favResources ?? []
  const favOf = (id: string) => favs.some((f) => f.projectId === id)
  const toggleFav = async (h: ResourceHit) => {
    const existed = favs.find((f) => f.projectId === h.projectId)
    const next: FavResource[] = existed
      ? favs.filter((f) => f.projectId !== h.projectId)
      : [
          ...favs,
          {
            projectId: h.projectId,
            kind,
            title: h.title,
            iconUrl: h.iconUrl,
            pageUrl: h.pageUrl,
            author: h.author,
            downloads: h.downloads,
            description: h.description
          }
        ]
    await saveSettings({ favResources: next })
    toast(existed ? `已取消收藏 ${h.title}` : `已收藏 ${h.title}`, existed ? 'info' : 'success')
  }
  const favAsHit = (f: FavResource): ResourceHit => ({
    projectId: f.projectId,
    slug: f.projectId,
    title: f.title,
    description: f.description ?? '',
    author: f.author ?? '',
    downloads: f.downloads ?? 0,
    follows: 0,
    iconUrl: f.iconUrl ?? '',
    categories: [],
    versions: [],
    projectType: f.kind,
    pageUrl: f.pageUrl ?? `https://modrinth.com/project/${f.projectId}`
  })
  const shown = favOnly ? favs.filter((f) => f.kind === kind).map(favAsHit) : hits

  const target = useMemo(() => instances.find((i) => i.id === targetId) ?? current, [instances, targetId, current])

  useEffect(() => {
    if (!targetId && currentId) setTargetId(currentId)
  }, [currentId, targetId])

  useEffect(() => {
    if (target) {
      setMcVersion(target.mcVersion)
      setLoaderFilter(target.loader === 'vanilla' ? '' : target.loader)
    }
  }, [target?.id])

  const refreshFiles = async () => {
    if (!targetId) return
    const content = await api.instanceContent(targetId)
    setFiles({ mods: content.mods, shaderpacks: content.shaderpacks, resourcepacks: content.resourcepacks })
  }

  useEffect(() => {
    refreshFiles()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId])

  // 首屏骨架占位 → 数据回来直接覆盖；有旧结果就保留不闪白；失败自动重试一次
  const doSearch = async (sortOverride?: string, attempt = 0, offsetOverride?: number, queryOverride?: string) => {
    setSearching(true)
    const nextOffset = offsetOverride ?? offset
    try {
      const res = await api.searchResources({
        type: kind,
        query: queryOverride ?? query,
        mcVersion: mcVersion || undefined,
        loader: kind === 'mod' ? loaderFilter || undefined : undefined,
        index: (sortOverride ?? sort) as 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated',
        offset: nextOffset,
        limit: 24
      })
      setHits(res.hits)
      setTotal(res.total)
      setCnInfo(res.cn)
      setOffset(nextOffset)
      hitCache[`${kind}|${sortOverride ?? sort}`] = res.hits
      setNetError(false)
    } catch {
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1200))
        return doSearch(sortOverride, attempt + 1, offsetOverride, queryOverride)
      }
      setNetError(true)
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    const cached = hitCache[`${kind}|${sort}`]
    if (cached?.length) setHits(cached)
    doSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

  const openVersions = async (hit: ResourceHit) => {
    if (versions[hit.projectId]) {
      setVersions((prev) => {
        const next = { ...prev }
        delete next[hit.projectId]
        return next
      })
      return
    }
    const list = await api.resourceVersions(hit.projectId, {
      mcVersion: mcVersion || undefined,
      loader: kind === 'mod' ? loaderFilter || undefined : undefined
    })
    setVersions((prev) => ({ ...prev, [hit.projectId]: list }))
  }

  /** 点「安装」不直接下，先算清单：主文件 + 必需前置 + 可选 + 冲突，让用户看清再决定 */
  const openPlan = async (hit: ResourceHit, versionId?: string) => {
    if (!targetId) return toast('先在左上角选一个实例', 'error')
    if (target && !target.installed) toast(`${target.name} 还没装好游戏本体，装完模组也起不来`, 'info')
    setBusy(hit.projectId)
    try {
      const data = await api.planResource(targetId, kind, hit.projectId, versionId)
      setPlan({ hit, versionId, data })
      setPicked({})
    } catch (e) {
      toast(`读取依赖失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const runInstall = async () => {
    if (!plan || !targetId) return
    const includeOptional = Object.keys(picked).filter((k) => picked[k])
    const rootTitle = plan.data.root.title
    // 点了就关弹窗：安装放到后台任务里跑，用户可以接着逛、接着装别的
    setPlan(null)
    setPlanBusy(false)
    setPicked({})
    toast(`开始安装「${rootTitle}」，进度看右下角`, 'info')
    try {
      const res = await api.installResource(targetId, kind, plan.hit.projectId, plan.versionId, includeOptional)
      const parts: string[] = []
      if (res.installed.length) parts.push(`装了 ${res.installed.length} 个`)
      if (res.skipped.length) parts.push(`已有 ${res.skipped.length} 个`)
      if (res.failed.length) parts.push(`失败 ${res.failed.length} 个`)
      toast(`「${rootTitle}」${parts.join('，') || '没东西可装'}`, res.failed.length ? 'info' : 'success')
      res.failed.forEach((f) => toast(`${f.title}：${f.error}`, 'error'))
      await refreshFiles()
    } catch (e) {
      toast(`「${rootTitle}」安装失败：${(e as Error).message}`, 'error')
    }
  }

  const installedList = useMemo(() => {
    if (kind === 'mod') return files.mods
    if (kind === 'shader') return files.shaderpacks
    return files.resourcepacks
  }, [kind, files])

  // 已经收尾的进度不再挂着（done 的交给 store 定时清，这里立刻就不显示）
  const activeProgress = Object.values(progress).filter((p) => p.total && !p.done)

  const doCfSearch = async () => {
    if (!cfQuery.trim()) return toast('先输入关键词', 'error')
    if (!cfKey) return toast('CurseForge 要 API Key，点右上角去设置填一下', 'info')
    setCfBusy(true)
    try {
      const res = await api.cfSearch({
        query: cfQuery,
        mcVersion: mcVersion || current?.mcVersion,
        loader: kind === 'mod' ? loaderFilter || undefined : undefined
      })
      setCfHits(res.hits)
      setCfCn(res.cn)
    } catch (e) {
      toast(`CF 搜索失败：${(e as Error).message}`, 'error')
    } finally {
      setCfBusy(false)
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('模组 · 光影 · 资源包', 'Mods · Shaders · Packs')}</h1>
          <p className="muted">
            {target
              ? `安装到：${target.name}（${target.mcVersion}${target.loader !== 'vanilla' ? ' · ' + target.loader : ''}）${target.installed ? '' : ' · 本体未安装'}`
              : '先在上面选一个实例'}
          </p>
        </div>
        <div className="tabs">
          {(Object.keys(kindLabel) as Kind[]).map((k) => (
            <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {kindLabel[k]}
            </button>
          ))}
        </div>
      </header>

      <div className="card">
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <div>
            <div className="mini-label">安装到哪个实例</div>
            <Select
              className="w260"
              value={targetId}
              options={
                instances.length
                  ? instances.map((i) => ({
                      value: i.id,
                      label: `${i.name}（${i.mcVersion}${i.loader !== 'vanilla' ? ' · ' + i.loader : ''}）${i.installed ? '' : ' · 未安装'}`
                    }))
                  : [{ value: '', label: '还没有实例' }]
              }
              onChange={(v) => setTargetId(v)}
              width={260}
            />
          </div>
          <span className="muted small" style={{ paddingBottom: 10 }}>
            下载了两个版本就在这切换，模组只进选中的那个实例
          </span>
        </div>
      </div>

      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>模组 / 光影 / 资源包</h3>
          <SourcePicker compact />
        </div>
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <span className="muted small">榜单排序：</span>
          {(
            [
              ['downloads', '下载最多'],
              ['follows', '关注最多'],
              ['newest', '最新发布'],
              ['relevance', '相关度']
            ] as [typeof sort, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              className={`chip ${!favOnly && sort === key ? 'on' : ''}`}
              onClick={() => {
                setFavOnly(false)
                setSort(key)
                doSearch(key)
              }}
            >
              {label}
            </button>
          ))}
          <button className={`chip ${favOnly ? 'on' : ''}`} onClick={() => setFavOnly((v) => !v)}>
            ★ 收藏 {favs.filter((f) => f.kind === kind).length}
          </button>
        </div>
        <div className="row wrap">
          <div className="search-wrap">
            <input
              placeholder={`搜索${kindLabel[kind]}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            {query && (
              <button
                className="search-clear"
                title="清除搜索"
                onClick={() => {
                  setQuery('')
                  setOffset(0)
                  setTimeout(() => doSearch(undefined, 0, 0, ''), 0)
                }}
              >
                ✕
              </button>
            )}
          </div>
          <div className="field-mini">
            <div className="mini-label">MC 版本</div>
            <input
              className="w120"
              value={mcVersion}
              placeholder="全部"
              title="只搜适配这个 MC 版本的项目。默认跟着上面的实例走，清空就是全部版本"
              onChange={(e) => setMcVersion(e.target.value)}
            />
          </div>
          {kind === 'mod' && (
            <div className="field-mini">
              <div className="mini-label">加载器</div>
              <Select
                className="w140"
                value={loaderFilter}
                options={[
                  { value: '', label: '全部加载器' },
                  { value: 'fabric', label: 'Fabric' },
                  { value: 'quilt', label: 'Quilt' },
                  { value: 'forge', label: 'Forge' },
                  { value: 'neoforge', label: 'NeoForge' }
                ]}
                onChange={setLoaderFilter}
                width={150}
              />
            </div>
          )}
          <button className="btn primary" disabled={searching} onClick={() => doSearch()}>
            {searching ? '搜索中…' : '搜索'}
          </button>
        </div>
        {cnInfo?.used.length ? (
          <p className="muted small">
            中文名「{query}」自动翻成了 {cnInfo.used.map((u) => `「${u}」`).join(' / ')} 再搜（Modrinth 只认英文原名）。
          </p>
        ) : null}
        {cnInfo && !cnInfo.matched && (
          <div className="inline-notice" style={{ marginTop: 4 }}>
            <span className="muted small">
              「{query}」这个词表里没有，Modrinth 也认不了中文。换个英文名（比如 幸运方块 → Lucky Block），
              或者去中文站找：
            </span>
            <button
              className="btn sm"
              onClick={() => api.openExternal(`https://search.mcmod.cn/s?key=${encodeURIComponent(query)}`)}
            >
              在 MC 百科搜
            </button>
            <button
              className="btn sm"
              onClick={() => {
                setCfQuery(query)
                void doCfSearch()
              }}
            >
              去 CurseForge 搜
            </button>
          </div>
        )}
        <p className="muted small">
          数据源 Modrinth。点安装会先列出依赖清单：必需前置一起装、可选前置你勾、冲突项只提示。加载器和 MC 版本对不上的直接拦下来。
        </p>
      </div>

      <div className="cards">
        {favOnly && shown.length === 0 && (
          <div className="card inline-notice">
            <span className="muted">这个分类还没收藏。搜到喜欢的点右上角 ☆ 就进收藏夹了。</span>
          </div>
        )}
        {!favOnly && searching && hits.length === 0 && <SkeletonCards count={6} />}
        {!favOnly && !searching && netError && hits.length === 0 && (
          <div className="card inline-notice">
            <span className="muted">没连上 Modrinth（网络可能被墙或超时）</span>
            <button className="btn sm primary" onClick={() => doSearch()}>
              重试
            </button>
          </div>
        )}
        {shown.map((h) => (
          <div className="card resource" key={h.projectId}>
            <div className="resource-head">
              {h.iconUrl ? <img src={h.iconUrl} alt="" /> : <div className="ph" />}
              <div>
                <h3>{h.title}</h3>
                <div className="muted small">
                  {h.author} · {h.downloads.toLocaleString()} 下载
                </div>
              </div>
              <button
                className={`fav-star ${favOf(h.projectId) ? 'on' : ''}`}
                title={favOf(h.projectId) ? '取消收藏' : '收藏'}
                onClick={() => toggleFav(h)}
              >
                {favOf(h.projectId) ? '★' : '☆'}
              </button>
            </div>
            <p className="desc">{h.description}</p>
            <div className="row wrap">
              <button className="btn primary sm" disabled={busy === h.projectId} onClick={() => openPlan(h)}>
                {busy === h.projectId ? '读取依赖…' : '安装最新版'}
              </button>
              <button className="btn sm" onClick={() => openVersions(h)}>
                {versions[h.projectId] ? '收起版本' : '选版本'}
              </button>
              <button className="btn ghost sm" onClick={() => api.openExternal(h.pageUrl)}>
                页面
              </button>
            </div>
            {versions[h.projectId] && (
              <div className="version-list">
                {versions[h.projectId].length === 0 && <div className="muted small">没有匹配当前实例的版本</div>}
                {versions[h.projectId].slice(0, 12).map((v) => (
                  <div className="version-row" key={v.id}>
                    <span>
                      {v.name} <span className="muted small">({v.versionNumber} · {v.loaders.join('/')})</span>
                    </span>
                    <button className="btn sm" onClick={() => openPlan(h, v.id)}>
                      装这个
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {!favOnly && hits.length > 0 && (
          <div className="load-more">
            <button
              className="btn primary"
              disabled={searching}
              onClick={() => {
                const page = 24
                const next = offset + page >= Math.max(total, page) ? 0 : offset + page
                doSearch(undefined, 0, next)
              }}
            >
              {searching ? '加载中…' : '换一批'}
            </button>
            <span className="muted small">
              已看 {Math.min(offset + hits.length, total || offset + hits.length)}
              {total ? ' / 共 ' + total + ' 个' : ''}
              {total > 24 && offset + 24 >= total ? '（到底了，再点回到开头）' : ''}
            </span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>
            已装{kindLabel[kind]}（{installedList.length}）
            {target && <span className="muted small"> · {target.name}</span>}
          </h3>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm ghost" onClick={() => void refreshFiles()}>
              刷新
            </button>
            <button
              className="btn sm ghost"
              onClick={() => void api.openInstanceFolder(targetId)}
            >
              打开文件夹
            </button>
          </div>
        </div>
        {installedList.length === 0 && (
          <div className="muted small">
            这个实例还没有{kindLabel[kind]}。装完没看到就先点上面的「刷新」——
            也可能你刚换过「安装到哪个实例」，看的是另一个实例的目录。
          </div>
        )}
        <div className="file-list">
          {installedList.map((f) => (
            <div className="file-row" key={f.path}>
              <span className="ellipsis">{f.name}</span>
              <span className="muted small">{formatSize(f.size)}</span>
              <button
                className="btn sm danger"
                onClick={async () => {
                  try {
                    await api.deleteContent(targetId, f.path)
                    toast(`已删除 ${f.name}`, 'success')
                    await refreshFiles()
                  } catch (e) {
                    toast(`删除失败：${(e as Error).message}`, 'error')
                  }
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>中文资源站</h3>
          <span className="muted small">Modrinth / CurseForge 都是英文站，中文模组名去这些地方找</span>
        </div>
        <div className="site-grid">
          {SITES.map((s) => (
            <button className="site-card" key={s.name} onClick={() => api.openExternal(s.url)}>
              <div className="site-name">{s.name}</div>
              <div className="muted small">{s.note}</div>
            </button>
          ))}
        </div>
        <div className="row wrap" style={{ marginTop: 10 }}>
          <input className="grow" placeholder="在 MC 百科搜中文名（幸运方块 / 等价交换…）" value={mcmodQuery} onChange={(e) => setMcmodQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openMcmod()} />
          <button className="btn" disabled={!mcmodQuery.trim()} onClick={openMcmod}>
            在 MC 百科搜
          </button>
        </div>
      </div>

      {activeProgress.length > 0 && (
        <div className="card">
          {activeProgress.map((p, i) => {
            const pct = p.total ? Math.min(100, Math.round(((p.current ?? 0) / p.total) * 100)) : 0
            return (
              <div className="progress-row" key={i}>
                <div className="progress-label">
                  <span>{p.phase}</span>
                  <span className="muted">{pct}%</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
      )}
      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>CurseForge 搜索</h3>
          {cfKey ? (
            <span className="badge ok">已填 Key</span>
          ) : (
            <button className="btn sm" onClick={() => goto?.('settings')}>
              去设置填 Key →
            </button>
          )}
        </div>
        {!cfKey && (
          <p className="muted small">
            CurseForge 要自己的 API Key（console.curseforge.com 免费申请，填一次就长期有效）。Modrinth 上面那栏不用 Key，先用那个也行。
          </p>
        )}
        <div className="row wrap" style={{ marginTop: 8 }}>
          <input
            className="grow"
            placeholder="搜 CurseForge 模组…"
            value={cfQuery}
            onChange={(e) => setCfQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doCfSearch()}
          />
          <button className="btn" disabled={cfBusy} onClick={doCfSearch}>
            {cfBusy ? '搜索中…' : '搜索 CF'}
          </button>
          {cfHits.length > 0 && (
            <button
              className="btn primary"
              onClick={async () => {
                if (!targetId) return toast('先选实例', 'error')
                for (const hit of cfHits.slice(0, 3)) {
                  try {
                    await api.cfInstall(targetId, hit.id)
                    toast(`已安装 ${hit.name}`, 'success')
                  } catch (e) {
                    toast(`${hit.name} 安装失败：${(e as Error).message}`, 'error')
                  }
                }
              }}
            >
              一键装前 3 个
            </button>
          )}
        </div>
        {cfCn?.matched && cfCn.used.length > 0 && (
          <div className="notice-bar" style={{ marginTop: 8 }}>
            中文名「{cfQuery.trim()}」自动翻成了「{cfCn.used[0]}」再搜（CurseForge 也只认英文原名）
          </div>
        )}
        {cfHits.length > 0 && (
          <div className="file-list cf-list" style={{ marginTop: 10 }}>
            {cfHits.map((hit) => (
              <div className="file-row cf-row" key={hit.id}>
                {hit.logoUrl ? (
                  <img src={hit.logoUrl} alt="" className="cf-icon" loading="lazy" />
                ) : (
                  <div className="cf-icon ph">?</div>
                )}
                <div className="cf-main">
                  <div className="cf-name" title={hit.name}>
                    {hit.name}
                  </div>
                  <div className="cf-desc" title={hit.summary}>
                    {hit.summary}
                  </div>
                </div>
                <div className="cf-side">
                  <span className="muted small">{hit.downloadCount.toLocaleString()} 下载</span>
                  <button
                    className="btn sm primary"
                    onClick={async () => {
                      if (!targetId) return toast('先选实例', 'error')
                      try {
                        await api.cfInstall(targetId, hit.id)
                        toast(`已安装 ${hit.name}`, 'success')
                      } catch (e) {
                        toast(`安装失败：${(e as Error).message}`, 'error')
                      }
                    }}
                  >
                    安装
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {plan && (
        <div className="dialog-mask" onClick={() => !planBusy && setPlan(null)}>
          <div className="dialog plan-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-title">装之前先看一眼 · {plan.data.root.title}</div>
            <div className="dialog-body">
              <div className="dep-root">
                <div className="dep-title">
                  {plan.data.root.title}
                  <span className="muted small"> · {plan.data.root.versionName}</span>
                </div>
                <div className="muted small">
                  {plan.data.root.filename}
                  {plan.data.root.size ? ` · ${formatSize(plan.data.root.size)}` : ''}
                </div>
                {plan.data.root.mismatch && <div className="dep-warn">⚠ {plan.data.root.mismatch}</div>}
              </div>

              {plan.data.required.length > 0 && (
                <div className="dep-group">
                  <div className="dep-group-title">必需前置（一起装，取消不了）</div>
                  {plan.data.required.map((d) => (
                    <DepLine key={d.projectId} d={d} />
                  ))}
                </div>
              )}

              {plan.data.optional.length > 0 && (
                <div className="dep-group">
                  <div className="dep-group-title">可选前置（想装就勾）</div>
                  {plan.data.optional.map((d) => (
                    <label className={`dep-row clickable ${picked[d.projectId] ? 'on' : ''}`} key={d.projectId}>
                      <input
                        type="checkbox"
                        checked={!!picked[d.projectId]}
                        onChange={(e) => setPicked((prev) => ({ ...prev, [d.projectId]: e.target.checked }))}
                      />
                      <span className="ellipsis">{d.title}</span>
                      {d.alreadyInstalled && <span className="dep-badge ok">已有</span>}
                      {d.error && <span className="dep-warn">{d.error}</span>}
                    </label>
                  ))}
                </div>
              )}

              {plan.data.incompatible.length > 0 && (
                <div className="dep-group">
                  <div className="dep-group-title">会冲突（只提示，不安装）</div>
                  {plan.data.incompatible.map((d) => (
                    <div className="dep-row" key={d.projectId}>
                      <span className="dep-badge bad">冲突</span>
                      <span className="ellipsis">{d.title}</span>
                    </div>
                  ))}
                </div>
              )}

              {plan.data.required.length + plan.data.optional.length === 0 && (
                <div className="muted small">这个项目没有前置依赖，直接装就行。</div>
              )}
            </div>
            <div className="dialog-actions">
              <button className="btn" disabled={planBusy} onClick={() => setPlan(null)}>
                取消
              </button>
              <button className="btn primary" disabled={planBusy} onClick={runInstall}>
                {planBusy
                  ? '安装中…'
                  : `开始安装（${1 + plan.data.required.filter((d) => !d.alreadyInstalled).length + Object.values(picked).filter(Boolean).length} 个）`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
