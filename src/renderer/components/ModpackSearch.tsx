import React, { useEffect, useState } from 'react'
import { api, friendlyError, progressPercent, progressText } from '../api'
import { useLauncher } from '../store'
import SourcePicker from './SourcePicker'
import Select from './Select'
import { SkeletonCards } from './Skeleton'
import type { ResourceHit, ResourceVersion } from '../../shared/types'

/** 上次搜到的结果留着，从这个分栏切回来能秒显（网络回来再覆盖） */
const cache: { hits: ResourceHit[]; total: number; loaded: boolean } = { hits: [], total: 0, loaded: false }

/** Modrinth 搜索接口不返回 page_url 时按 project_type + slug 拼页面地址，别让「页面」按钮点了没反应 */
export function resourcePageUrl(h: { pageUrl?: string; slug?: string; projectId?: string }): string {
  if (h.pageUrl) return h.pageUrl
  if (h.slug) return `https://modrinth.com/project/${h.slug}`
  if (h.projectId) return `https://modrinth.com/project/${h.projectId}`
  return ''
}

/**
 * 整合包：搜 Modrinth 上的整合包，一键装成新实例；也能导入本地 .mrpack / CurseForge zip。
 * 从「下载游戏」页搬到「模组 · 光影」的「整合包」分栏（1.0.38 起）。
 */
export default function ModpackSearch({ goto }: { goto?: (p: 'instances') => void }) {
  const { toast, refreshInstances, setCurrentId, progress } = useLauncher()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ResourceHit[]>(() => cache.hits)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState('')
  const [error, setError] = useState(false)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(() => cache.total)
  // 筛选：整合包也要能挑 MC 版本和加载器（否则只会装到「最新」，想装 1.20.1 的没门）
  const [mcVersion, setMcVersion] = useState('')
  const [loaderFilter, setLoaderFilter] = useState('')
  // 每个整合包的版本列表：「选版本」展开后才拉
  const [versions, setVersions] = useState<Record<string, ResourceVersion[]>>({})
  const [versionAll, setVersionAll] = useState<Record<string, boolean>>({})
  const [versionBusy, setVersionBusy] = useState('')
  const [installingVer, setInstallingVer] = useState('')

  const doSearch = async (attempt = 0, _a?: number, offsetOverride?: number, queryOverride?: string) => {
    setSearching(true)
    const nextOffset = offsetOverride ?? offset
    const q = queryOverride ?? query
    try {
      const res = await api.searchResources({
        type: 'modpack',
        query: q,
        index: 'downloads',
        offset: nextOffset,
        limit: 24,
        mcVersion: mcVersion || undefined,
        loader: loaderFilter || undefined
      })
      setHits(res.hits)
      setTotal(res.total)
      setOffset(nextOffset)
      setError(false)
      cache.hits = res.hits
      cache.total = res.total
      cache.loaded = true
    } catch {
      if (attempt < 1) {
        // 网络抖动自动重试一次
        await new Promise((r) => setTimeout(r, 1200))
        return doSearch(attempt + 1, 0, offsetOverride, queryOverride)
      }
      setError(true)
      if (hits.length === 0) toast('整合包列表没拉到：网络可能不通，点「重试」再试一次', 'error')
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    if (cache.loaded) return
    void doSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 拉某个整合包的版本列表；all=true 时不限 MC 版本 / 加载器 */
  const loadPackVersions = async (hit: ResourceHit, all: boolean) => {
    setVersionBusy(hit.projectId)
    try {
      const list = await api.resourceVersions(
        hit.projectId,
        all ? {} : { mcVersion: mcVersion || undefined, loader: loaderFilter || undefined }
      )
      setVersions((prev) => ({ ...prev, [hit.projectId]: list }))
      setVersionAll((prev) => ({ ...prev, [hit.projectId]: all }))
    } catch (e) {
      toast(`读取版本列表失败：${friendlyError(e)}`, 'error')
    } finally {
      setVersionBusy('')
    }
  }

  const togglePackVersions = async (hit: ResourceHit) => {
    if (versions[hit.projectId]) {
      setVersions((prev) => {
        const next = { ...prev }
        delete next[hit.projectId]
        return next
      })
      return
    }
    await loadPackVersions(hit, false)
  }

  /** ver 传了就装那一个版本，不传就按当前筛选挑最新 release */
  const installPack = async (hit: ResourceHit, ver?: ResourceVersion) => {
    setInstalling(hit.projectId)
    setInstallingVer(ver?.id ?? '')
    try {
      let v = ver
      if (!v) {
        let list = await api.resourceVersions(hit.projectId, {
          mcVersion: mcVersion || undefined,
          loader: loaderFilter || undefined
        })
        // 筛选太严可能一个都不剩：退回全部版本再挑，别让「安装」按钮点了没反应
        if (list.length === 0) list = await api.resourceVersions(hit.projectId, {})
        v = list.find((x) => x.versionType === 'release') ?? list[0]
      }
      if (!v) throw new Error('该整合包没有可下载版本')
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      if (!file) throw new Error('这个版本没有可下载的文件')
      const label = `${hit.title}${v.versionNumber ? ` ${v.versionNumber}` : ''}`
      toast(`开始安装整合包 ${label}…这会自动装对应版本与加载器`)
      const id = await api.installModpackUrl(file.url, label)
      await refreshInstances()
      setCurrentId(id)
      toast('整合包安装完成', 'success')
      goto?.('instances')
    } catch (e) {
      toast(`整合包安装失败：${friendlyError(e)}`, 'error')
    } finally {
      setInstalling('')
      setInstallingVer('')
    }
  }

  const importLocalPack = async () => {
    const file = await api.pickFile()
    if (!file) return
    try {
      toast('正在导入本地整合包…')
      const id = await api.installModpackFile(file)
      await refreshInstances()
      setCurrentId(id)
      toast('整合包导入完成', 'success')
      goto?.('instances')
    } catch (e) {
      toast(`导入失败：${friendlyError(e)}`, 'error')
    }
  }

  const openPage = (hit: ResourceHit) => {
    const url = resourcePageUrl(hit)
    if (!url) {
      toast('这个整合包没有可打开的页面', 'error')
      return
    }
    api.openExternal(url).catch(() => toast(`打不开浏览器，链接：${url}`, 'error'))
  }

  // 只读进度：整合包安装/下载的进度行（本页不提供暂停，暂停按钮在「下载游戏」页）
  const packProgress = Object.values(progress).filter(
    (p) => p.total && !p.done && (p.key === 'modpack-download' || /整合包/.test(p.phase ?? ''))
  )

  const page = 24

  return (
    <>
      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>整合包</h3>
          <SourcePicker compact />
        </div>
        <div className="row" data-tour="mp-search">
          <div className="search-wrap">
            <input
              placeholder="搜索整合包，例如：机械动力、空岛、RLCraft"
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
                  setTimeout(() => doSearch(0, 0, 0, ''), 0)
                }}
              >
                ✕
              </button>
            )}
          </div>
          <button className="btn primary" disabled={searching} onClick={() => doSearch()}>
            {searching ? '搜索中…' : '搜索'}
          </button>
          <button className="btn" onClick={importLocalPack}>
            导入本地 .mrpack / .zip
          </button>
        </div>
        <div className="row wrap" style={{ marginTop: 8, alignItems: 'flex-end' }}>
          <div className="field-mini">
            <div className="mini-label">MC 版本</div>
            <input
              className="w120"
              value={mcVersion}
              placeholder="全部"
              title="只找适配这个 Minecraft 版本的整合包；留空 ＝ 不限版本"
              onChange={(e) => setMcVersion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                setOffset(0)
                void doSearch(0, 0, 0)
              }}
            />
          </div>
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
            />
          </div>
          <button
            className="btn sm"
            disabled={searching}
            onClick={() => {
              setOffset(0)
              void doSearch(0, 0, 0)
            }}
          >
            按筛选搜索
          </button>
        </div>
        <p className="muted small">
          在线整合包来自 Modrinth（免 Key）。本地导入支持 Modrinth 与 CurseForge 压缩包。装完就是一个新实例，会自动下对应版本的
          Minecraft 和加载器。想装某个特定版本就点卡片上的「选版本」。
        </p>
      </div>

      {packProgress.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>安装进度</h3>
          {packProgress.map((p) => {
            const pct = progressPercent(p)
            return (
              <div className="progress-row" key={p.key}>
                <div className="progress-label">
                  <span>{p.phase}</span>
                  <span className="progress-nums muted">
                    {progressText(p)}
                    <b>{pct}%</b>
                  </span>
                </div>
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
          <p className="muted small" style={{ marginBottom: 0 }}>
            装的时候可以先去别的页面，进度和取消在右下角任务面板。
          </p>
        </div>
      )}

      {searching && hits.length === 0 && <SkeletonCards count={6} />}

      {error && hits.length === 0 && !searching && (
        <div className="card empty-state">
          <p className="muted">整合包列表没拉到，可能网络不通。</p>
          <button className="btn primary" onClick={() => doSearch()}>
            重试
          </button>
        </div>
      )}

      <div className="cards">
        {hits.map((h) => (
          <div className="card resource" key={h.projectId}>
            <div className="resource-head">
              {h.iconUrl ? <img src={h.iconUrl} alt="" /> : <div className="ph" />}
              <div>
                <h3>{h.title}</h3>
                <div className="muted small">
                  {h.author} · {h.downloads.toLocaleString()} 下载
                </div>
              </div>
            </div>
            <p className="desc">{h.description}</p>
            <div className="row wrap">
              <button className="btn primary sm" disabled={installing === h.projectId} onClick={() => installPack(h)}>
                {installing === h.projectId && !installingVer ? '安装中…' : '安装最新版'}
              </button>
              <button className="btn sm" onClick={() => togglePackVersions(h)}>
                {versions[h.projectId] ? '收起版本' : '选版本'}
              </button>
              <button className="btn ghost sm" onClick={() => openPage(h)}>
                Modrinth 页面
              </button>
            </div>
            {versions[h.projectId] && (
              <div className="version-list">
                <div className="version-head">
                  <span className="muted small">
                    {versionAll[h.projectId]
                      ? '全部版本（不限 MC 版本和加载器）'
                      : mcVersion || loaderFilter
                        ? `只列 ${[mcVersion || '不限 MC 版本', loaderFilter || '不限加载器'].join(' / ')} 的版本`
                        : '版本列表（没设 MC 版本 / 加载器筛选）'}
                  </span>
                  <button
                    className="btn ghost sm"
                    disabled={versionBusy === h.projectId}
                    onClick={() => loadPackVersions(h, !versionAll[h.projectId])}
                  >
                    {versionBusy === h.projectId ? '读取中…' : versionAll[h.projectId] ? '只看匹配的' : '显示全部版本'}
                  </button>
                </div>
                {versions[h.projectId].length === 0 && (
                  <div className="muted small">没有匹配当前筛选的版本，点右上「显示全部版本」自己挑。</div>
                )}
                {versions[h.projectId].slice(0, 30).map((v) => {
                  const mcOk = !mcVersion || v.gameVersions.length === 0 || v.gameVersions.includes(mcVersion)
                  const ldOk =
                    !loaderFilter || v.loaders.length === 0 || v.loaders.includes(loaderFilter)
                  const busyThis = installing === h.projectId && installingVer === v.id
                  return (
                    <div className={`version-row${mcOk && ldOk ? '' : ' mismatch'}`} key={v.id}>
                      <span>
                        {v.versionNumber || v.name}{' '}
                        <span className="muted small">
                          ({v.gameVersions.slice(0, 3).join('/') || '版本未标'} · {v.loaders.join('/') || '通用'}
                          {v.versionType === 'release' ? '' : ` · ${v.versionType}`})
                        </span>
                        {!(mcOk && ldOk) && <span className="warn-tag">跟筛选不匹配</span>}
                      </span>
                      <button className="btn sm" disabled={installing === h.projectId} onClick={() => installPack(h, v)}>
                        {busyThis ? '安装中…' : '装这个'}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {hits.length > 0 && (
        <div className="load-more">
          <button
            className="btn primary"
            disabled={searching}
            onClick={() => {
              const next = offset + page >= Math.max(total, page) ? 0 : offset + page
              doSearch(0, 0, next)
            }}
          >
            {searching ? '加载中…' : '换一批'}
          </button>
          <span className="muted small">
            已看 {Math.min(offset + hits.length, total || offset + hits.length)}
            {total ? ' / 共 ' + total + ' 个' : ''}
          </span>
        </div>
      )}
    </>
  )
}
