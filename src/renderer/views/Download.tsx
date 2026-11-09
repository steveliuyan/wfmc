import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, formatSize, friendlyError, progressPercent, progressText, versionTypeLabel } from '../api'

/** 剩余时间：只按当前这一条进度自己的实时速度算（和上面显示的 ↓ 速度同源，不会自相矛盾） */
function etaLabel(remainBytes: number, speed: number): string {
  if (speed <= 0) return ''
  const left = remainBytes / speed
  if (!isFinite(left) || left <= 0) return ''
  if (left > 3600) return `剩 ${Math.floor(left / 3600)}:${String(Math.floor((left % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(left % 60)).padStart(2, '0')}`
  const mm = Math.floor(left / 60)
  const ss = Math.floor(left % 60)
  return `剩 ${mm}:${String(ss).padStart(2, '0')}`
}
import type { RemoteVersion } from '../../shared/types'
import { useLauncher, useT } from '../store'
import SourcePicker from '../components/SourcePicker'
import Select from '../components/Select'

type VersionFilter = 'release' | 'april' | 'snapshot' | 'old' | 'all'

const FILTERS: { key: VersionFilter; label: string }[] = [
  { key: 'release', label: '正式版' },
  { key: 'april', label: '愚人节' },
  { key: 'snapshot', label: '快照' },
  { key: 'old', label: '远古版本' },
  { key: 'all', label: '全部' }
]

function matchFilter(v: RemoteVersion, f: VersionFilter): boolean {
  if (f === 'all') return true
  if (f === 'april') return !!v.aprilFools
  if (f === 'old') return v.type === 'old_beta' || v.type === 'old_alpha'
  if (f === 'snapshot') return v.type === 'snapshot' && !v.aprilFools
  return v.type === 'release'
}

export default function Download({ goto }: { goto: (p: 'instances') => void }) {
  const { toast, refreshInstances, progress, setCurrentId, settings, instances, clearProgress } = useLauncher()
  const t = useT()

  // 原版安装表单
  const [remote, setRemote] = useState<RemoteVersion[]>([])
  const [mcVersion, setMcVersion] = useState('')
  const [vFilter, setVFilter] = useState<VersionFilter>('release')
  const [loader, setLoader] = useState('vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaders, setLoaders] = useState<{ value: string; label: string }[]>([])
  const [installing, setInstalling] = useState(false)
  const [versionsLoading, setVersionsLoading] = useState(true)
  const [loadersLoading, setLoadersLoading] = useState(false)

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

  /** 按当前分类筛选出来的版本 */
  const shownVersions = useMemo(() => remote.filter((v) => matchFilter(v, vFilter)), [remote, vFilter])
  const filterCount = useMemo(() => {
    const c: Record<VersionFilter, number> = { release: 0, april: 0, snapshot: 0, old: 0, all: remote.length }
    for (const v of remote) {
      if (v.aprilFools) c.april++
      else if (v.type === 'release') c.release++
      else if (v.type === 'snapshot') c.snapshot++
      else if (v.type === 'old_beta' || v.type === 'old_alpha') c.old++
    }
    return c
  }, [remote])

  // 切分类后当前选中项可能不在列表里：自动落到这一类最新的一个
  useEffect(() => {
    if (shownVersions.length === 0) return
    if (shownVersions.some((v) => v.id === mcVersion)) return
    setMcVersion(shownVersions[0].id)
  }, [shownVersions, mcVersion])

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

  // 结束/取消的进度（done）不再显示，否则卡片会一直挂在页面上
  const currentProgress = Object.values(progress).filter((p) => p.total && !p.done)

  // 下载速度：进度事件只给累计字节，速度得自己按时间差算；用 EMA 平滑，暂停/卡住会自然掉回 0
  const speedRef = useRef<Record<string, { bytes: number; t: number; speed: number }>>({})
  const [speeds, setSpeeds] = useState<Record<string, number>>({})
  const progressRef = useRef(progress)
  progressRef.current = progress
  useEffect(() => {
    const tick = () => {
      const now = performance.now()
      const alive = progressRef.current
      const next: Record<string, number> = {}
      for (const [k, p] of Object.entries(alive)) {
        if (p.done || !p.totalBytes) continue
        const bytes = p.bytes ?? 0
        const prev = speedRef.current[k]
        if (!prev) {
          speedRef.current[k] = { bytes, t: now, speed: 0 }
          next[k] = 0
          continue
        }
        const dt = (now - prev.t) / 1000
        if (dt < 0.35) {
          next[k] = prev.speed
          continue
        }
        const inst = Math.max(0, bytes - prev.bytes) / dt
        const smooth = prev.speed > 0 ? prev.speed * 0.55 + inst * 0.45 : inst
        speedRef.current[k] = { bytes, t: now, speed: smooth }
        next[k] = smooth
      }
      for (const k of Object.keys(speedRef.current)) {
        const p = alive[k]
        if (!p || p.done) delete speedRef.current[k]
      }
      setSpeeds(next)
    }
    const id = window.setInterval(tick, 800)
    return () => window.clearInterval(id)
  }, [])

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
      </header>

      <div className="card" data-tour="dl-card">
        <div className="row-between" style={{ border: 'none' }}>
          <h3 style={{ margin: 0 }}>安装原版或加载器版本</h3>
          <SourcePicker />
        </div>
        <div className="chips" style={{ margin: '4px 0 12px' }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip ${vFilter === f.key ? 'on' : ''}`}
              onClick={() => setVFilter(f.key)}
              title={f.key === 'april' ? '每年 4 月 1 日的整蛊版本，能装也能玩' : undefined}
            >
              {f.label}
              <span className="muted small"> {filterCount[f.key]}</span>
            </button>
          ))}
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
              options={shownVersions.map((v) => ({ value: v.id, label: `${v.id} · ${versionTypeLabel(v)}` }))}
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

      {/* 贴链接下载：多线程、可暂停，存到 data/downloads */}
      <div className="card">
        <h3>贴链接下载</h3>
        <p className="muted small">
          HTTP/HTTPS 直链都行（jar、zip、整合包、任意文件），多线程 + 断点续传，支持暂停/继续。存到 data\downloads。
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
            const pct = progressPercent(p)
            // 两条暂停路径都要认：这里点的（pausedKeys）、任务面板点的（主进程已经把 phase 改成「已暂停 · …」）
            const paused = pausedKeys[p.key] || /^已暂停/.test(p.phase ?? '')
            const speed = paused ? 0 : speeds[p.key] ?? 0
            const remain = Math.max(0, (p.totalBytes ?? 0) - (p.bytes ?? 0))
            const live = p.phase && !/完成|失败|已取消/.test(p.phase)
            return (
              <div className="progress-row" key={i}>
                <div className="progress-label">
                  <span>{p.phase}</span>
                  <span className="progress-nums muted">
                    {live && speed > 0 && (
                      <i className="speed" title="当前下载速度">
                        ↓ {formatSize(speed)}/s
                      </i>
                    )}
                    {live && speed > 0 && remain > 0 && <i>{etaLabel(remain, speed)}</i>}
                    {paused && live && <i>已暂停</i>}
                    {progressText(p)}
                    <b>{pct}%</b>
                  </span>
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
