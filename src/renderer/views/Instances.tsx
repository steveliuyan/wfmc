import React, { useEffect, useState } from 'react'
import { api, friendlyError, formatDuration, formatSize, type InstanceDetail } from '../api'
import { useLauncher, useT } from '../store'
import type { Instance, JavaInfo } from '../../shared/types'
import Select from '../components/Select'

type PanelKey = 'info' | 'settings' | 'loader'

const LOADER_LABEL: Record<string, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  vanilla: '原版'
}

/** 给已有实例补装 / 换加载器（原版实例塞模组用不了，就是从这里装） */
function LoaderPanel({ instance, onDone }: { instance: Instance; onDone: () => Promise<void> }) {
  const { toast, askConfirm } = useLauncher()
  const [loader, setLoader] = useState<'fabric' | 'forge' | 'neoforge' | 'quilt'>('fabric')
  const [versions, setVersions] = useState<{ value: string; label: string }[]>([])
  const [ver, setVer] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)

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

  return (
    <div className="detail loader-panel">
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
              { value: 'quilt', label: 'Quilt' }
            ]}
            onChange={(v) => setLoader(v as 'fabric' | 'forge' | 'neoforge' | 'quilt')}
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
          {busy ? '安装中…（看右下角任务）' : `给这个实例装 ${LOADER_LABEL[loader]}`}
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
          装完会新建 {instance.mcVersion} 的 {LOADER_LABEL[loader]} 版本并自动切过去，原来的存档 / mods 都不动。
        </span>
      </div>
    </div>
  )
}

export default function Instances() {
  const t = useT()
  const { instances, refreshInstances, currentId, setCurrentId, toast , askConfirm } = useLauncher()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState('vanilla')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [remote, setRemote] = useState<{ id: string; type: string }[]>([])
  const [loaders, setLoaders] = useState<{ value: string; label: string }[]>([])
  const [loaderLoading, setLoaderLoading] = useState(false)
  const [loaderErr, setLoaderErr] = useState('')
  const [verTick, setVerTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [detail, setDetail] = useState<Record<string, InstanceDetail>>({})
  const [javas, setJavas] = useState<JavaInfo[]>([])
  const [presets, setPresets] = useState<{ id: string; name: string; desc: string; memoryMb: number }[]>([])
  const [packInfo, setPackInfo] = useState('')
  // 卡片里的折叠面板：一次只开一个，收起/展开都有动画
  const [openPanel, setOpenPanel] = useState<{ id: string; key: PanelKey }>()
  const [visiblePanel, setVisiblePanel] = useState<{ id: string; key: PanelKey }>()

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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('实例', 'Instances')}</h1>
          <p className="muted">每个实例是一套独立的 .minecraft，模组/光影/存档互不干扰。</p>
        </div>
        <div className="row">
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
                options={remote.map((v) => ({ value: v.id, label: `${v.id}（${v.type}）` }))}
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
                  { value: 'neoforge', label: 'NeoForge' }
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
        {instances.map((i) => {
          const d = detail[i.id]
          const openKey = openPanel?.id === i.id ? openPanel.key : undefined
          const mountedKey = visiblePanel?.id === i.id ? visiblePanel.key : undefined
          return (
            <div className={`card instance ${i.id === currentId ? 'current' : ''}`} key={i.id}>
              <div className="instance-head">
                <h3>{i.name}</h3>
                <span className={`badge ${i.loader}`}>{i.loader}</span>
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
                  >
                    {label}
                    <i className={`chev ${openKey === key ? 'up' : ''}`}>▾</i>
                  </button>
                ))}
                <button className="btn sm" onClick={() => api.openInstanceFolder(i.id)}>
                  目录
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    if (!(await askConfirm({ title: '删除实例', message: `「${i.name}」会连同游戏文件一起删除，确定？`, okText: '删除', danger: true }))) return
                    await api.deleteInstance(i.id, true)
                    await refreshInstances()
                    toast('实例已删除', 'success')
                  }}
                >
                  删除
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
                  <div className="version-list">
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
                          toast(res.note, res.hasUpdate ? 'success' : 'info')
                        } catch (e) {
                          toast(`检查失败：${friendlyError(e)}`, 'error')
                        }
                      }}
                    >
                      检查整合包更新
                    </button>
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
