import React, { useEffect, useState } from 'react'
import { api, friendlyError, progressPercent, progressText } from '../api'
import { useLauncher } from '../store'
import SourcePicker from './SourcePicker'
import { SkeletonCards } from './Skeleton'
import type { ResourceHit } from '../../shared/types'

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
        limit: 24
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

  const installPack = async (hit: ResourceHit) => {
    setInstalling(hit.projectId)
    try {
      const versions = await api.resourceVersions(hit.projectId, {})
      const v = versions.find((x) => x.versionType === 'release') ?? versions[0]
      if (!v) throw new Error('该整合包没有可下载版本')
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      toast(`开始安装整合包 ${hit.title}…这会自动装对应版本与加载器`)
      const id = await api.installModpackUrl(file.url, hit.title)
      await refreshInstances()
      setCurrentId(id)
      toast('整合包安装完成', 'success')
      goto?.('instances')
    } catch (e) {
      toast(`整合包安装失败：${friendlyError(e)}`, 'error')
    } finally {
      setInstalling('')
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
        <div className="row">
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
        <p className="muted small">
          在线整合包来自 Modrinth（免 Key）。本地导入支持 Modrinth 与 CurseForge 压缩包。装完就是一个新实例，会自动下对应版本的
          Minecraft 和加载器。
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
                {installing === h.projectId ? '安装中…' : '安装'}
              </button>
              <button className="btn ghost sm" onClick={() => openPage(h)}>
                Modrinth 页面
              </button>
            </div>
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
