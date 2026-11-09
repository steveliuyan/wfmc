import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { MirrorHit, MirrorSite } from '../../shared/types'
import { SkeletonCards } from './Skeleton'

/**
 * 国内资源站搜索（BBSMC / XyeBBS）。
 *
 * 这两家的文件都被「人机验证 / 网盘」挡着，启动器没法自动装，所以这里只做：
 * 中文关键词搜到 → 打开网页去下。想一键安装的还走 Modrinth / CurseForge 那条线。
 */

const KIND_LABEL: Record<string, string> = {
  mod: '模组',
  shader: '光影',
  resourcepack: '资源包',
  modpack: '整合包'
}

const SITE_NOTE: Record<MirrorSite, string> = {
  bbsmc: 'bbsmc.net · 中文名索引最全，模组 / 光影 / 整合包 / 资源包 / 数据包都有',
  xyebbs: 'xyebbs.com · 中文论坛，整合包 / 模组 / 材质 / 光影 / 汉化 / 插件 / 地图'
}

export default function CnMirror({
  kind,
  mcVersion,
  loader
}: {
  kind: string
  mcVersion?: string
  loader?: string
}) {
  const [site, setSite] = useState<MirrorSite>('bbsmc')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MirrorHit[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sort, setSort] = useState<'downloads' | 'newest' | 'relevance'>('downloads')
  // 站点 / 分类一切换就自动拉一屏默认榜，别让用户对着空白发呆
  const inited = useRef('')

  const load = async (opts: {
    site?: MirrorSite
    page?: number
    query?: string
    sort?: 'downloads' | 'newest' | 'relevance'
  }) => {
    const s = opts.site ?? site
    const p = opts.page ?? 1
    const q = opts.query ?? query
    const so = opts.sort ?? sort
    setBusy(true)
    setErr('')
    try {
      const res = await api.mirrorSearch({
        site: s,
        type: kind,
        query: q,
        mcVersion: mcVersion || undefined,
        // 只有模组才按加载器筛；光影 / 资源包 / 整合包 BBSMC 的 categories 里没有加载器这一说
        loader: kind === 'mod' ? loader || undefined : undefined,
        page: p,
        sort: so
      })
      setHits(res.hits)
      setTotal(res.total)
      setPage(res.page)
      setHasMore(res.hasMore)
      setHint(res.hint ?? '')
    } catch (e) {
      setErr((e as Error).message || '没连上')
      setHits([])
      setTotal(0)
      setHasMore(false)
      setHint('')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const key = `${site}|${kind}`
    if (inited.current === key) return
    inited.current = key
    void load({ site, page: 1, query: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site, kind])

  const open = (url?: string) => {
    if (!url) return
    api.openExternal(url).catch(() => undefined)
  }

  const label = KIND_LABEL[kind] ?? '资源'

  return (
    <>
      <div className="card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>
            国内站 · {label}
            <span className="muted small" style={{ marginLeft: 8 }}>
              {total ? `共 ${total.toLocaleString()} 个` : ''}
            </span>
          </h3>
          <div className="tabs">
            {(Object.keys(SITE_NOTE) as MirrorSite[]).map((s) => (
              <button
                key={s}
                className={site === s ? 'on' : ''}
                onClick={() => {
                  setSite(s)
                  setQuery('')
                  setHits([])
                  setTotal(0)
                  void load({ site: s, page: 1, query: '' })
                }}
              >
                {s === 'bbsmc' ? 'BBSMC' : 'XyeBBS'}
              </button>
            ))}
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 4 }}>
          {SITE_NOTE[site]}
        </p>
        <div className="row wrap">
          <div className="search-wrap">
            <input
              placeholder={`用中文搜${label}，例如：机械动力、钠、光影`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void load({ page: 1 })}
            />
            {query && (
              <button
                className="search-clear"
                title="清除搜索"
                onClick={() => {
                  setQuery('')
                  void load({ page: 1, query: '' })
                }}
              >
                ✕
              </button>
            )}
          </div>
          <button className="btn primary" disabled={busy} onClick={() => void load({ page: 1 })}>
            {busy ? '搜索中…' : '搜索'}
          </button>
          {site === 'bbsmc' && (
            <div className="field-mini">
              <div className="mini-label">排序</div>
              <div className="row" style={{ gap: 6 }}>
                {(
                  [
                    ['downloads', '下载最多'],
                    ['newest', '最新发布'],
                    ['relevance', '相关度']
                  ] as ['downloads' | 'newest' | 'relevance', string][]
                ).map(([k, text]) => (
                  <button
                    key={k}
                    className={`chip ${sort === k ? 'on' : ''}`}
                    onClick={() => {
                      setSort(k)
                      void load({ page: 1, sort: k })
                    }}
                  >
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          这两家的文件都有人机验证 / 网盘挡着，启动器下不了：点「打开页面」去网页下，回来用「导入本地整合包」或手动放进
          mods 文件夹。能一键安装的请切回 Modrinth / CurseForge。
        </p>
        {hint && <p className="muted small">{hint}</p>}
      </div>

      {busy && hits.length === 0 && <SkeletonCards count={6} />}

      {!busy && err && (
        <div className="card inline-notice">
          <span className="muted">没搜到东西：{err}</span>
          <button className="btn sm primary" onClick={() => void load({ page: 1 })}>
            重试
          </button>
        </div>
      )}

      <div className="cards">
        {hits.map((h) => (
          <div className="card resource" key={`${h.site}-${h.id}`}>
            <div className="resource-head">
              {h.iconUrl ? (
                <img src={h.iconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <div className="ph" />
              )}
              <div>
                <h3>{h.title}</h3>
                <div className="muted small">
                  {h.author ? `${h.author} · ` : ''}
                  {h.downloads.toLocaleString()} 下载
                </div>
              </div>
            </div>
            {h.description && <p className="desc">{h.description}</p>}
            {h.versions.length > 0 && (
              <div className="row wrap" style={{ gap: 6 }}>
                {h.versions.slice(0, 6).map((v) => (
                  <span className="chip" key={v} style={{ cursor: 'default' }}>
                    {v}
                  </span>
                ))}
                {h.versions.length > 6 && <span className="muted small">等 {h.versions.length} 个版本</span>}
              </div>
            )}
            {h.note && <p className="muted small" style={{ marginBottom: 4 }}>{h.note}</p>}
            <div className="row wrap">
              <button className="btn primary sm" onClick={() => open(h.pageUrl)}>
                打开页面
              </button>
              {h.downloadUrl && (
                <button className="btn sm" onClick={() => open(h.downloadUrl)}>
                  打开下载页
                </button>
              )}
              <button
                className="btn ghost sm"
                onClick={() => {
                  void navigator.clipboard?.writeText(h.pageUrl)
                }}
                title={h.pageUrl}
              >
                复制链接
              </button>
            </div>
          </div>
        ))}
      </div>

      {hits.length > 0 && (
        <div className="load-more">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void load({ page: hasMore ? page + 1 : 1 })}
          >
            {busy ? '加载中…' : hasMore ? '下一页' : '回到第一页'}
          </button>
          <span className="muted small">
            第 {page} 页{total ? ` / 共 ${total.toLocaleString()} 个` : ''}
          </span>
        </div>
      )}
    </>
  )
}
