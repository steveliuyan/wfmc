import React, { useEffect, useState } from 'react'
import { api, friendlyError } from '../api'
import { useLauncher, useT } from '../store'
import SourcePicker from '../components/SourcePicker'
import Select from '../components/Select'
import { SkeletonCards } from '../components/Skeleton'
import type { ResourceHit } from '../../shared/types'

type Tab = 'game' | 'modpack'

export default function Download({ goto }: { goto: (p: 'instances') => void }) {
  const { toast, refreshInstances, progress, setCurrentId, settings, instances, clearProgress } = useLauncher()
  const t = useT()
  const [tab, setTab] = useState<Tab>('game')

  // 原版安装表单
  const [remote, setRemote] = useState<{ id: string; type: string; releaseTime: string }[]>([])
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState('vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaders, setLoaders] = useState<{ value: string; label: string }[]>([])
  const [installing, setInstalling] = useState(false)
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [loadersLoading, setLoadersLoading] = useState(false)

  // 整合包
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ResourceHit[]>([])
  const [searching, setSearching] = useState(false)
  const [packInstalling, setPackInstalling] = useState<string>('')
  const [packError, setPackError] = useState(false)
  const [packOffset, setPackOffset] = useState(0)
  const [packTotal, setPackTotal] = useState(0)
  const [pausedKeys, setPausedKeys] = useState<Record<string, boolean>>({})
  const [urlInput, setUrlInput] = useState('')

  const loadVersions = async () => {
    setVersionsLoading(true)
    try {
      const list = await api.remoteVersions()
      setRemote(list)
      setMcVersion((prev) => prev || list.find((v) => v.type === 'release')?.id || list[0]?.id || '')
    } catch {
      toast('版本列表没拉下来：网络可能不通，点下拉框里的「重试」', 'error')
    } finally {
      setVersionsLoading(false)
    }
  }

  useEffect(() => {
    void loadVersions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (loader === 'vanilla' || !mcVersion) return
    let alive = true
    setLoadersLoading(true)
    api
      .loaderVersions(loader, mcVersion)
      .then((l) => {
        if (!alive) return
        setLoaders(l)
        setLoaderVersion((prev) => prev || l[0]?.value || '')
      })
      .catch(() => {
        if (alive) toast('加载器版本没拉下来，稍后再试', 'error')
      })
      .finally(() => {
        if (alive) setLoadersLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loader, mcVersion, toast])

  const doInstallVanilla = async () => {
    if (!mcVersion) return
    setInstalling(true)
    const wantedName = `${mcVersion}${loader !== 'vanilla' ? ` ${loader}` : ''}`
    let createdId: string | undefined
    try {
      // 同名同版本同加载器就复用，避免每点一次就新建空实例 + 留一条 0% 进度
      const existing = instances.find((i) => i.name === wantedName && i.mcVersion === mcVersion && i.loader === loader)
      const instance =
        existing ??
        (await api.createInstance({
          name: wantedName,
          mcVersion,
          loader,
          loaderVersion: loader === 'vanilla' ? undefined : loaderVersion
        }))
      if (!existing) createdId = instance.id
      await refreshInstances()
      setCurrentId(instance.id)
      toast(`开始安装 ${instance.name}…`)
      await api.installGame(instance.id)
      await refreshInstances()
      toast(`${instance.name} 安装完成`, 'success')
      goto('instances')
    } catch (e) {
      toast(`安装失败：${friendlyError(e)}`, 'error')
      clearProgress()
      // 这次新建出来的空实例删掉，别在实例列表里堆垃圾
      if (createdId) {
        await api.deleteInstance(createdId, true).catch(() => undefined)
        await refreshInstances()
      }
    } finally {
      setInstalling(false)
    }
  }

  // 首屏先骨架占位；有旧结果就保留着不闪白；失败只在真的空手时才提示
  const doSearch = async (attempt = 0, _a?: number, offsetOverride?: number, queryOverride?: string) => {
    setSearching(true)
    const nextOffset = offsetOverride ?? packOffset
    try {
      const res = await api.searchResources({
        type: 'modpack',
        query: queryOverride ?? query,
        index: 'downloads',
        offset: nextOffset,
        limit: 24
      })
      setHits(res.hits)
      setPackTotal(res.total)
      setPackOffset(nextOffset)
      setPackError(false)
    } catch {
      if (attempt < 1) {
        // 网络抖动自动重试一次，避免一打开就甩「被墙」
        await new Promise((r) => setTimeout(r, 1200))
        return doSearch(attempt + 1, 0, offsetOverride, queryOverride)
      }
      setPackError(true)
      if (hits.length === 0) toast('整合包列表没拉到：网络可能不通，点「重试」再试一次', 'error')
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    doSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const installPack = async (hit: ResourceHit) => {
    setPackInstalling(hit.projectId)
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
      goto('instances')
    } catch (e) {
      toast(`整合包安装失败：${friendlyError(e)}`, 'error')
    } finally {
      setPackInstalling('')
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
      goto('instances')
    } catch (e) {
      toast(`导入失败：${friendlyError(e)}`, 'error')
    }
  }

  // 结束/取消的进度（done）不再显示，否则卡片会一直挂在页面上
  const currentProgress = Object.values(progress).filter((p) => p.total && !p.done)

  const startUrlDownload = async () => {
    const url = urlInput.trim()
    if (!url) return
    try {
      const res = await api.startUrlDownload(url)
      setUrlInput('')
      toast(`开始下载 ${res.name}`, 'success')
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('下载游戏', 'Download')}</h1>
          <p className="muted">
            下载源：{settings?.downloadSource === 'mirror' ? '国内镜像 BMCLAPI（推荐）' : 'Mojang 官方'}
          </p>
        </div>
        <div className="tabs">
          <button className={tab === 'game' ? 'on' : ''} onClick={() => setTab('game')}>
            原版 / 加载器
          </button>
          <button className={tab === 'modpack' ? 'on' : ''} onClick={() => setTab('modpack')}>
            整合包
          </button>
        </div>
      </header>

      {tab === 'game' && (
        <div className="card">
          <div className="row-between" style={{ border: 'none' }}>
            <h3 style={{ margin: 0 }}>安装原版或加载器版本</h3>
            <SourcePicker />
          </div>
          <div className="form-grid">
            <label>
              Minecraft 版本
              <Select
                value={mcVersion}
                placeholder="选择版本"
                loading={versionsLoading}
                loadingText="正在拉版本列表…"
                emptyText="版本列表没拉到（网络不通）"
                onRetry={loadVersions}
                options={remote.map((v) => ({ value: v.id, label: `${v.id} (${v.type})` }))}
                onChange={setMcVersion}
              />
            </label>
            <label>
              加载器
              <Select
                value={loader}
                options={[
                  { value: 'vanilla', label: '原版' },
                  { value: 'fabric', label: 'Fabric（推荐，轻量）' },
                  { value: 'quilt', label: 'Quilt' },
                  { value: 'forge', label: 'Forge' },
                  { value: 'neoforge', label: 'NeoForge' }
                ]}
                onChange={(v) => {
                  setLoader(v)
                  if (v === 'vanilla') setLoaderVersion('')
                }}
              />
            </label>
            {loader !== 'vanilla' && (
              <label>
                加载器版本
                <Select
                  value={loaderVersion}
                  placeholder="选择加载器版本"
                  loading={loadersLoading}
                  loadingText="正在拉加载器版本…"
                  options={loaders.map((l) => ({ value: l.value, label: l.label }))}
                  onChange={setLoaderVersion}
                />
              </label>
            )}
          </div>
          <div className="row">
            <button className="btn primary" disabled={installing} onClick={doInstallVanilla}>
              {installing ? '安装中…' : '下载并安装'}
            </button>
            <span className="muted small">
              会在实例目录里下载 client.jar、libraries、assets 全套文件；1.20+ 一般 300MB 左右。
            </span>
          </div>
        </div>
      )}

      {tab === 'modpack' && (
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
                      setPackOffset(0)
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
            <p className="muted small">在线整合包来自 Modrinth（免 Key）。本地导入支持 Modrinth 与 CurseForge 压缩包。</p>
          </div>

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
                  <button
                    className="btn primary sm"
                    disabled={packInstalling === h.projectId}
                    onClick={() => installPack(h)}
                  >
                    {packInstalling === h.projectId ? '安装中…' : '安装'}
                  </button>
                  <button className="btn ghost sm" onClick={() => api.openExternal(h.pageUrl)}>
                    Modrinth 页面
                  </button>
                </div>
              </div>
            ))}

          {hits.length > 0 && (
            <div className="load-more">
              <button
                className="btn primary"
                disabled={searching}
                onClick={() => {
                  const page = 24
                  const next = packOffset + page >= Math.max(packTotal, page) ? 0 : packOffset + page
                  doSearch(0, 0, next)
                }}
              >
                {searching ? '加载中…' : '换一批'}
              </button>
              <span className="muted small">
                已看 {Math.min(packOffset + hits.length, packTotal || packOffset + hits.length)}
                {packTotal ? ' / 共 ' + packTotal + ' 个' : ''}
              </span>
            </div>
          )}
          </div>
        </>
      )}

      {/* 贴链接下载：多线程、可暂停，存到 data/downloads */}
      <div className="card">
        <h3>贴链接下载</h3>
        <p className="muted small">
          HTTP/HTTPS 直链都行（jar、zip、整合包、任意文件），48 线程 + 断点续传，支持暂停/继续。存到 data\downloads。
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            placeholder="https://example.com/file.zip"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') startUrlDownload()
            }}
            style={{ flex: 1, minWidth: 260 }}
          />
          <button className="btn" disabled={!urlInput.trim()} onClick={startUrlDownload}>
            开始下载
          </button>
        </div>
      </div>

      {currentProgress.length > 0 && (
        <div className="card sticky-progress">
          <div className="row-between" style={{ border: 'none', marginBottom: 6 }}>
            <h3 style={{ margin: 0 }}>下载进度</h3>
            <button className="btn sm ghost" onClick={() => clearProgress()}>
              清空
            </button>
          </div>
          {currentProgress.map((p, i) => {
            const pct = p.total ? Math.min(100, Math.round(((p.current ?? 0) / p.total) * 100)) : 0
            const paused = pausedKeys[p.key]
            const live = p.phase && !/完成|失败|已取消/.test(p.phase)
            return (
              <div className="progress-row" key={i}>
                <div className="progress-label">
                  <span>{p.phase}</span>
                  <span className="muted">{pct}%</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                {live && (
                  <div className="row" style={{ marginTop: 6 }}>
                    <button
                      className="btn sm ghost"
                      onClick={async () => {
                        if (paused) {
                          await api.resumeDownload(p.key)
                          setPausedKeys((v) => ({ ...v, [p.key]: false }))
                        } else {
                          await api.pauseDownload(p.key)
                          setPausedKeys((v) => ({ ...v, [p.key]: true }))
                        }
                      }}
                    >
                      {paused ? '继续' : '暂停'}
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        setPausedKeys((v) => ({ ...v, [p.key]: false }))
                        await api.cancelDownload(p.key)
                        clearProgress(p.key)
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
