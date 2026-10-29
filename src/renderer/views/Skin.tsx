import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useLauncher, useT } from '../store'
import Select from '../components/Select'
import type { Account } from '../../shared/types'

interface SkinInfo {
  uuid: string
  name: string
  skinUrl?: string
  capeUrl?: string
  model?: 'slim' | 'steve'
  /** 查不到时的原因（没设皮肤 / 网络失败），界面直接显示 */
  error?: string
}

/** 披风缩略图：贴图也走主进程抓 dataURL，避免 <img> 直连被拦 */
function CapeThumb({ capeUrl }: { capeUrl?: string }) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    let alive = true
    if (!capeUrl) {
      setSrc(undefined)
      return
    }
    api
      .fetchTexture(capeUrl)
      .then((d) => alive && setSrc(d))
      .catch(() => alive && setSrc(undefined))
    return () => {
      alive = false
    }
  }, [capeUrl])
  if (!src) return null
  return <img className="cape-thumb" src={src} alt="披风" title="当前披风" />
}

type AnimKind = 'idle' | 'walk' | 'run' | 'fly' | 'none'

/** 真 3D 预览（skinview3d + three）。贴图先由主进程抓成 dataURL，避开 file:// 跨域 */
function Skin3D({
  skinUrl,
  capeUrl,
  model,
  anim = 'idle',
  spin = true
}: {
  skinUrl?: string
  capeUrl?: string
  model?: 'slim' | 'steve'
  anim?: AnimKind
  /** 是否自动旋转 */
  spin?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<any>(null)
  const svRef = useRef<any>(null)
  const [tex, setTex] = useState<{ skin?: string; cape?: string }>({})
  const [err, setErr] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [ready, setReady] = useState(false)
  const spinRef = useRef(true)

  // 1) 贴图 → dataURL（主进程抓，绕开跨域）
  useEffect(() => {
    let alive = true
    if (!skinUrl) {
      setTex({})
      return
    }
    setLoading(true)
    setErr(undefined)
    ;(async () => {
      try {
        const skin = await api.fetchTexture(skinUrl)
        const cape = capeUrl ? await api.fetchTexture(capeUrl).catch(() => undefined) : undefined
        if (alive) setTex({ skin, cape })
      } catch (e) {
        if (alive) setErr('皮肤贴图读不到：' + (e as Error).message)
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [skinUrl, capeUrl])

  // 2) 建 viewer（只建一次）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    ;(async () => {
      try {
        const sv: any = await import('skinview3d')
        if (disposed || !canvasRef.current) return
        svRef.current = sv
        const viewer = new sv.SkinViewer({ canvas: canvasRef.current, width: 220, height: 320 })
        viewer.autoRotate = false // 自己驱动旋转，库的 autoRotate 在部分版本不生效
        viewer.autoRotateSpeed = 0.7
        try {
          viewer.controls.enableZoom = false
          viewer.controls.enablePan = false
        } catch {
          /* 控制器可选 */
        }
        viewerRef.current = viewer
        ;(window as any).__skinViewer = viewer
        setReady(true)
      } catch (e) {
        setErr('3D 预览加载失败：' + (e as Error).message)
      }
    })()
    return () => {
      disposed = true
      try {
        viewerRef.current?.dispose?.()
      } catch {
        /* 忽略 */
      }
      viewerRef.current = null
      setReady(false)
    }
  }, [])

  // 3) 贴图到手就套上，并挂动作（动画必须在模型加载完之后设，否则不生效）
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !ready) return
    let cancelled = false
    ;(async () => {
      try {
        if (tex.skin) await viewer.loadSkin(tex.skin, model === 'slim' ? { model: 'slim' } : undefined)
        if (cancelled) return
        if (tex.cape) await viewer.loadCape(tex.cape)
        else if (viewer.cape) await viewer.loadCape(null)
        if (cancelled) return
        viewer.autoRotate = spinRef.current
        setErr(undefined)
      } catch (e) {
        if (!cancelled) setErr('3D 预览出错：' + (e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [tex, model, ready, spin])

  // 保持 spinRef 与 prop 同步（异步加载完成后要读最新值）
  useEffect(() => {
    spinRef.current = spin
  }, [spin])

  // 3.5) 旋转：自己用 rAF 驱动 playerObject，配合「停止/开始旋转」按钮
  useEffect(() => {
    if (!ready) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(64, now - last)
      last = now
      const v = viewerRef.current
      if (v && spinRef.current) {
        const node = v.playerObject || v.playerWrapper
        if (node) node.rotation.y += (dt / 1000) * 0.7
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ready, spin])

  // 4) 动作切换（待机 / 走路 / 奔跑 / 飞行 / 不动作）
  useEffect(() => {
    const viewer = viewerRef.current
    const sv = svRef.current
    if (!viewer || !sv || !ready) return
    try {
      const map: Record<AnimKind, any> = {
        idle: sv.IdleAnimation,
        walk: sv.WalkingAnimation,
        run: sv.RunningAnimation,
        fly: sv.FlyingAnimation,
        none: null
      }
      const Cls = map[anim]
      viewer.animation = Cls ? new Cls() : null
    } catch {
      /* 动画切换失败不影响静态预览 */
    }
  }, [anim, ready, tex])

  if (err && tex.skin) {
    return (
      <div className="skin-3d-wrap">
        <SkinPreview skinUrl={tex.skin} model={model} />
        <div className="skin-3d-hint error">{err}（已退回 2D 预览）</div>
      </div>
    )
  }

  return (
    <div className="skin-3d-wrap">
      <canvas ref={canvasRef} className="skin-3d" width={220} height={320} />
      {loading && <div className="skin-3d-hint">正在加载皮肤…</div>}
      {err && <div className="skin-3d-hint error">{err}</div>}
      {!skinUrl && !loading && <div className="skin-3d-hint">这个角色还没设置皮肤</div>}
    </div>
  )
}

/** 用 canvas 从皮肤贴图渲染一个「正面小人」，够看、纯前端、零依赖 */
function SkinPreview({ skinUrl, model }: { skinUrl?: string; model?: 'slim' | 'steve' }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = false

    if (!skinUrl) {
      ctx.fillStyle = 'rgba(120,130,160,0.25)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      return
    }

    const img = new Image()
    img.onload = () => {
      const S = 12 // 每个像素放大倍数
      const draw = (sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) => {
        ctx.drawImage(img, sx, sy, sw, sh, dx * S, dy * S, sw * S, sh * S)
      }
      const armW = model === 'slim' ? 3 : 4
      // 腿
      draw(4, 20, 4, 12, 4, 20)
      draw(20, 52, 4, 12, 8, 20)
      // 身体
      draw(20, 20, 8, 12, 4, 8)
      // 手臂
      draw(44, 20, armW, 12, 4 + 8, 8)
      draw(36, 52, armW, 12, 4 - armW, 8)
      // 头
      draw(8, 8, 8, 8, 4, 0)
      // 帽子层（有就叠上去）
      draw(40, 8, 8, 8, 4, 0)
    }
    img.src = skinUrl
  }, [skinUrl, model])

  return <canvas ref={ref} width={16 * 12} height={32 * 12} className="skin-canvas" />
}

export default function Skin() {
  const t = useT()
  const { accounts, refreshAccounts, toast, settings } = useLauncher()
  const [apiRoot, setApiRoot] = useState(settings?.yggdrasilApi || 'https://littleskin.cn/api/yggdrasil')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState('')
  const [profiles, setProfiles] = useState<{ id: string; name: string }[]>([])
  const [activeAccount, setActiveAccount] = useState<Account>()
  // 调试用：?demoSkin=<图片地址> 可直接试渲染，不用真登录
  const demoQuery = new URLSearchParams(location.search).get('demoSkin') ?? localStorage.getItem('demoSkin')
  const demoSkin = demoQuery || undefined
  const supressCape = !!demoQuery
  const [skin, setSkin] = useState<SkinInfo>()
  const [anim, setAnim] = useState<AnimKind>('idle')
  const [spin, setSpin] = useState(true)
  const [uploadModel, setUploadModel] = useState<'slim' | 'steve'>('steve')
  // 手动选过上传模型后，刷新皮肤不再覆盖选择
  const modelTouched = useRef(false)
  const [dragOver, setDragOver] = useState(false)

  const external = accounts.filter((a) => a.type === 'yggdrasil')

  useEffect(() => {
    const current = external.find((a) => a.id === settings?.activeAccountId) ?? external[0]
    setActiveAccount(current)
  }, [accounts, settings?.activeAccountId])

  // 拖拽卡片 / 别的页面写入的地址，同步到输入框
  useEffect(() => {
    if (settings?.yggdrasilApi) setApiRoot(settings.yggdrasilApi)
  }, [settings?.yggdrasilApi])

  const refreshSkin = async (account?: Account) => {
    const target = account ?? activeAccount
    if (!target) return
    const info = await api.lookupSkin(target.id)
    setSkin(info)
    if (info?.model && !modelTouched.current) setUploadModel(info.model)
  }

  useEffect(() => {
    refreshSkin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAccount?.id])

  const doLogin = async () => {
    setBusy('login')
    try {
      const res = await api.loginYggdrasil({ apiRoot, username, password })
      setProfiles(res.profiles)
      await api.setActiveAccount(res.account.id)
      await refreshAccounts()
      setActiveAccount(res.account)
      await refreshSkin(res.account)
      toast(`登录成功：${res.account.name}`, 'success')
    } catch (e) {
      toast(`登录失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  // 支持 LittleSkin 的「拖拽卡片」：authlib-injector:yggdrasil-server:<url>
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (text) {
      const parsed = await api.parseInjectorCard(text).catch(() => undefined)
      if (parsed) {
        setApiRoot(parsed)
        toast(`已识别验证服务器：${parsed}`, 'success')
        return
      }
    }
    const files = e.dataTransfer.files
    if (files?.length) {
      const path = api.pathOfFile(files[0])
      if (path && /\.(png)$/i.test(path)) {
        await uploadSkinFile(path)
        return
      }
    }
    toast('没识别拖进来的内容', 'error')
  }

  const uploadSkinFile = async (filePath: string) => {
    if (!activeAccount) return toast('先登录外置账号', 'error')
    setBusy('skin')
    try {
      await api.uploadSkin(activeAccount.id, filePath, uploadModel)
      await refreshSkin()
      toast('皮肤已更新（进游戏生效）', 'success')
    } catch (e) {
      toast(`上传失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  return (
    <div
      className="page"
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="page-head">
        <div>
          <h1>{t('皮肤 · 外置登录', 'Skins & Authlib Login')}</h1>
          <p className="muted">
            支持 authlib-injector 协议（LittleSkin、Blessing Skin 等）。登录后能管角色、换皮肤/披风，启动游戏自动注入验证。
          </p>
        </div>
        <button className="btn" onClick={() => api.openExternal('https://littleskin.cn')}>
          打开 LittleSkin 网站
        </button>
      </header>

      <div className="grid-2">
        <div className="card">
          <h3>登录外置账号</h3>
          <div className="form-grid">
            <label className="full">
              验证服务器（Yggdrasil API 根地址）
              <input value={apiRoot} onChange={(e) => setApiRoot(e.target.value)} placeholder="https://littleskin.cn/api/yggdrasil" />
            </label>
            <label>
              邮箱 / 用户名
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label>
              密码
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <div className="row wrap">
            <button className="btn primary" disabled={busy === 'login'} onClick={doLogin}>
              {busy === 'login' ? '登录中…' : '登录'}
            </button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const info = await api.ensureInjector()
                  toast(`authlib-injector 已就绪 ${info.version ?? ''}`, 'success')
                } catch (e) {
                  toast(`下载失败：${(e as Error).message}`, 'error')
                }
              }}
            >
              准备 authlib-injector
            </button>
            <button
              className="btn"
              title="拖拽失败时用这个：先在 LittleSkin 右键复制卡片链接"
              onClick={async () => {
                const url = await api.injectorFromClipboard()
                if (!url) return toast('剪贴板里没有可用的验证服务器地址', 'error')
                setApiRoot(url)
                toast(`已填入：${url}`, 'success')
              }}
            >
              从剪贴板识别
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>
            小技巧：把 LittleSkin 的「Yggdrasil 外置登录」卡片直接拖进这个窗口（任意页面都行），会自动跳到本页并填好地址；拖不动就右键复制卡片链接，点上面「从剪贴板识别」。
          </p>

          {profiles.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="mini-label">这个账号下的角色（点一个切换）</div>
              <div className="chips">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    className={`chip ${activeAccount?.uuid === p.id ? 'on' : ''}`}
                    onClick={async () => {
                      if (!activeAccount) return
                      try {
                        const updated = await api.selectProfile(activeAccount.id, p)
                        await refreshAccounts()
                        setActiveAccount(updated)
                        await refreshSkin(updated)
                        toast(`已切换到角色 ${p.name}`, 'success')
                      } catch (e) {
                        toast(`切换失败：${(e as Error).message}`, 'error')
                      }
                    }}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className={`card ${dragOver ? 'drop-active' : ''}`}>
          <h3>当前角色</h3>
          {activeAccount ? (
            <>
              <div className="row-between" style={{ border: 'none' }}>
                <div>
                  <b>{activeAccount.name}</b>
                  <div className="muted small">{activeAccount.server}</div>
                </div>
                <span className="badge ok">外置登录</span>
              </div>
              <div className="skin-stage">
                {skin?.error && !skin?.skinUrl && !demoSkin ? (
                  <div className="skin-3d-wrap">
                    <div className="skin-3d-hint error" style={{ position: 'static', whiteSpace: 'normal', maxWidth: '82%' }}>
                      {skin.error}
                    </div>
                  </div>
                ) : (
                  <Skin3D
                    skinUrl={demoSkin ?? skin?.skinUrl}
                    capeUrl={supressCape ? undefined : skin?.capeUrl}
                    model={skin?.model ?? 'steve'}
                    anim={anim}
                    spin={spin}
                  />
                )}
                {!skin?.skinUrl && !demoSkin && <SkinPreview skinUrl={skin?.skinUrl} model={skin?.model ?? 'steve'} />}
              </div>
              <div className="muted small">拖动可以旋转（鼠标按住小人左右拖），默认自动慢转</div>
              <div className="row wrap" style={{ marginTop: 10 }}>
                <Select
                  value={anim}
                  width={118}
                  options={[
                    { value: 'idle', label: '待机' },
                    { value: 'walk', label: '走路' },
                    { value: 'run', label: '奔跑' },
                    { value: 'fly', label: '飞行' },
                    { value: 'none', label: '不动作' }
                  ]}
                  onChange={(v) => setAnim(v as AnimKind)}
                />
                <button
                  className={`btn sm ${spin ? 'on' : ''}`}
                  onClick={() => setSpin((v) => !v)}
                  title={spin ? '点击停止自动旋转' : '点击开始自动旋转'}
                >
                  {spin ? '停止旋转' : '开始旋转'}
                </button>
                <button className="btn sm" onClick={() => refreshSkin()} title="重新从皮肤站拉一次">
                  刷新皮肤
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    const p = await api.pickFile()
                    if (p) await uploadSkinFile(p)
                  }}
                >
                  {busy === 'skin' ? '上传中…' : '上传皮肤'}
                </button>
                <span className="muted small" title="只影响下次上传；当前预览按皮肤文件显示">上传时用</span>
                <Select
                  value={uploadModel}
                  width={150}
                  options={[
                    { value: 'steve', label: '经典（4px 手臂）' },
                    { value: 'slim', label: '纤细 Alex（3px）' }
                  ]}
                  onChange={(v) => {
                    modelTouched.current = true
                    setUploadModel(v as 'slim' | 'steve')
                  }}
                />
                <button
                  className="btn sm"
                  onClick={async () => {
                    const p = await api.pickFile()
                    if (!p) return
                    try {
                      await api.uploadCape(activeAccount.id, p)
                      await refreshSkin()
                      toast('披风已更新', 'success')
                    } catch (e) {
                      toast(`上传披风失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  上传披风
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    try {
                      await api.clearTexture(activeAccount.id, 'skin')
                      await refreshSkin()
                      toast('皮肤已清除', 'success')
                    } catch (e) {
                      toast(`清除失败：${(e as Error).message}`, 'error')
                    }
                  }}
                >
                  清除皮肤
                </button>
              </div>
              <p className="muted small">
                也可以直接把 64×64 的皮肤 png 拖进这个窗口上传。改完进游戏才看得到（客户端按 uuid 拉皮肤）。
              </p>
            </>
) : demoSkin ? (
            <div className="skin-stage">
              <Skin3D skinUrl={demoSkin} model="steve" anim={anim} />
            </div>
          ) : (
            <div className="muted small">左边登录一个外置账号，这里就会出现角色和皮肤预览。</div>
          )}
        </div>
      </div>

      {external.length > 0 && (
        <div className="card">
          <h3>已登录的外置账号</h3>
          <div className="list">
            {external.map((a) => (
              <div className="row-between" key={a.id}>
                <span>
                  {a.name} <span className="muted small">{a.server}</span>
                  {settings?.activeAccountId === a.id && <span className="badge ok">使用中</span>}
                </span>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.setActiveAccount(a.id)
                    await refreshAccounts()
                    setActiveAccount(a)
                    toast(`已启用 ${a.name}`, 'success')
                  }}
                >
                  设为当前
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
