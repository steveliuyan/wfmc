import React, { useEffect, useState } from 'react'
import { api, type HostedServer, type LanWorld, type RoomEnv, type ServerManifest, type TunnelState, type UpnpResult } from '../api'
import { useLauncher, useT } from '../store'
import { joinWithSync } from '../joinWithSync'
import type { PageId } from '../App'

const LOADER_NAMES: Record<string, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  quilt: 'Quilt',
  paper: 'Paper'
}

const loaderName = (l?: string) => LOADER_NAMES[l ?? ''] ?? (l || '未知')

const envText = (m?: ServerManifest) =>
  m ? `${m.mcVersion} · ${loaderName(m.loader)}${m.loaderVersion ? ' ' + m.loaderVersion : ''} · ${m.mods.length} 个模组` : ''

export default function Online({ goto }: { goto: (p: PageId) => void }) {
  const { toast, current, currentId, askConfirm } = useLauncher()
  const t = useT()
  const [port, setPort] = useState(25565)
  const [lanWorlds, setLanWorlds] = useState<LanWorld[]>([])
  const [lanOn, setLanOn] = useState(false)
  const [lanIp, setLanIp] = useState('')
  const [pub, setPub] = useState<{ ip: string; port: number } | null>()
  const [upnp, setUpnp] = useState<UpnpResult>()
  const [tunnel, setTunnel] = useState<TunnelState>({ running: false, logs: [] })
  const [hosting, setHosting] = useState<HostedServer[]>([])
  const [busy, setBusy] = useState('')
  const [shareHost, setShareHost] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [roomCodeLan, setRoomCodeLan] = useState('')
  const [codeInput, setCodeInput] = useState('')
  // 每个局域网世界背后的环境（房主开了 WFMC 的模组清单才探得到）
  const [probes, setProbes] = useState<Record<string, { ok: boolean; manifest?: ServerManifest }>>({})

  useEffect(() => {
    api.lanIp().then(setLanIp)
    api.listHosted().then(setHosting)
    api.tunnelState().then(setTunnel)
  }, [])

  // 局域网世界轮询
  useEffect(() => {
    if (!lanOn) return
    const timer = setInterval(async () => setLanWorlds(await api.lanList()), 2000)
    return () => clearInterval(timer)
  }, [lanOn])

  // 探一下每个世界的版本/加载器/模组数（探不到就当「环境未知」，不拦人）
  useEffect(() => {
    if (!lanOn) return
    const todo = lanWorlds.filter((w) => probes[`${w.address}:${w.port}`] === undefined).slice(0, 6)
    if (!todo.length) return
    let cancelled = false
    ;(async () => {
      const patch: Record<string, { ok: boolean; manifest?: ServerManifest }> = {}
      for (const w of todo) {
        const key = `${w.address}:${w.port}`
        try {
          const r = await api.serverSyncProbe(w.address, w.port)
          patch[key] = r.found ? { ok: true, manifest: r.manifest } : { ok: false }
        } catch {
          patch[key] = { ok: false }
        }
      }
      if (!cancelled) setProbes((p) => ({ ...p, ...patch }))
    })()
    return () => {
      cancelled = true
    }
  }, [lanOn, lanWorlds, probes])

  useEffect(() => {
    if (!tunnel.running) return
    const timer = setInterval(async () => setTunnel(await api.tunnelState()), 2000)
    return () => clearInterval(timer)
  }, [tunnel.running])

  /**
   * 进服前先决定「用哪个实例」：
   * 知道房主环境 → 找本地同版本同加载器的实例；没有就问一句然后一键建一个；
   * 不知道环境 → 用左侧选中的实例，只有一个实例就直接用它。
   */
  const resolveInstance = async (env?: RoomEnv): Promise<string | null> => {
    const instances = await api.listInstances()
    if (!env?.mcVersion) {
      if (currentId && instances.some((i) => i.id === currentId)) return currentId
      if (instances.length === 1) {
        toast(`没选实例，自动用「${instances[0].name}」进服`, 'info')
        return instances[0].id
      }
      if (!instances.length) {
        toast('本地一个实例都没有：先去「实例」页建一个，或用房主的房间码（能自动匹配/建实例）', 'error')
        return null
      }
      toast('先在左侧选一个实例；如果房主给了房间码，用房间码会自动匹配', 'error')
      return null
    }
    const mc = env.mcVersion
    const loader = env.loader ?? 'vanilla'
    const hit = instances.find((i) => i.mcVersion === mc && (i.loader ?? 'vanilla') === loader)
    if (hit) {
      if (hit.id !== currentId) toast(`自动用实例「${hit.name}」进服（${mc} · ${loaderName(loader)}）`, 'info')
      return hit.id
    }
    const ok = await askConfirm({
      title: '建实例并进服',
      message: `本地没有「${mc} · ${loaderName(loader)}」的实例。\n\n现在建一个并进服吗？首次会下载游戏和加载器（几百 MB，看网速）。`,
      okText: '建实例并进服'
    })
    if (!ok) return null
    let loaderVersion = env.loaderVersion
    if (loader !== 'vanilla' && !loaderVersion) {
      const list = await api.loaderVersions(loader, mc).catch(() => [] as { value: string; stable?: boolean }[])
      loaderVersion = (list.find((v) => v.stable) ?? list[0])?.value
    }
    const inst = await api.createInstance({
      name: `${mc} ${loaderName(loader)}`,
      mcVersion: mc,
      loader,
      loaderVersion
    })
    await api.installGame(inst.id)
    toast(`实例「${inst.name}」建好了`, 'success')
    return inst.id
  }

  const joinWorld = async (address: string, portNumber: number, env?: RoomEnv) => {
    try {
      const instanceId = await resolveInstance(env)
      if (!instanceId) return
      const joined = await joinWithSync({
        instanceId,
        host: address,
        port: portNumber,
        toast,
        askConfirm
      })
      if (joined) goto('home')
    } catch (e) {
      toast(`进服失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('联机', 'Multiplayer')}</h1>
          <p className="muted">
            三种玩法：同一路由器下用局域网直连、家里宽带用 UPnP 打洞做 P2P、实在打不通就用公网中继穿透。
          </p>
        </div>
      </header>

      {/* 概念说明：开房间 ≠ 开服务端 */}
      <div className="card guide-card">
        <h3>先分清两件事（很多人在这搞混）</h3>
        <div className="compare">
          <div className="compare-col on">
            <div className="compare-title">本页：开房间（临时）</div>
            <ul>
              <li>你自己先打开游戏，在「对局域网开放」里开一个房间</li>
              <li>本页只是帮你把房间<strong>分享</strong>出去：局域网直连 / UPnP 打洞 / 公网中继</li>
              <li><strong>你一退出游戏，房间就没了</strong>；人数受游戏内限制（一般 8 人左右）</li>
              <li>适合：临时和朋友玩一晚上、玩自己的存档</li>
            </ul>
          </div>
          <div className="compare-col">
            <div className="compare-title">「一键开服」页：开服务端（常驻）</div>
            <ul>
              <li>启动器替你跑一个<strong>独立服务端进程</strong>，你关游戏它还在</li>
              <li>关掉窗口也不退出，会缩到右下角托盘继续跑（托盘菜单可停止 / 退出）</li>
              <li>玩家随时能进、人数上限可调、能装插件或 mod（Fabric / Forge / NeoForge）</li>
              <li>适合：想长期开服、朋友随时来、装了 mod 的整合服</li>
            </ul>
          </div>
        </div>
        <p className="muted small">
          三种分享渠道的区别：<strong>局域网直连</strong>＝同一个路由器下，零配置但只能同网；
          <strong>P2P 打洞（UPnP）</strong>＝自动给路由器开端口，外网可连、不过第三方、延迟最低，需要路由器支持；
          <strong>公网中继（bore）</strong>＝路由器不给映射时用，能连但延迟取决于中继。
        </p>
      </div>

      {/* 要共享的端口 */}
      <div className="card">
        <div className="row wrap">
          <label style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            要共享的游戏端口
            <input
              type="number"
              style={{ width: 120 }}
              value={port}
              onChange={(e) => setPort(Number(e.target.value) || 25565)}
            />
          </label>
          <span className="muted small">本机内网地址：{lanIp || '获取中…'}</span>
          {hosting.filter((h) => h.port).length > 0 && (
            <span className="muted small">
              已开服务端端口：
              {[...new Set(hosting.map((h) => h.port))].map((p) => (
                <button key={p} className="chip" style={{ marginLeft: 6 }} onClick={() => setPort(p)}>
                  {p}
                </button>
              ))}
            </span>
          )}
          <button className="btn sm" onClick={() => goto('hosting')}>
            去开服
          </button>
        </div>
      </div>

      {/* 1. 局域网 */}
      <div className="card">
        <h3>① 局域网联机（同一个路由器下）</h3>
        <div className="row wrap">
          <button
            className="btn primary"
            onClick={async () => {
              const res = await api.lanStart()
              setLanOn(res.running)
              toast('开始监听局域网广播（游戏里开「对局域网开放」就能被发现）', 'success')
            }}
          >
            {lanOn ? '监听中…' : '开始发现局域网世界'}
          </button>
          <button className="btn" disabled={!lanOn} onClick={() => api.lanList().then(setLanWorlds)}>
            刷新列表
          </button>
          <button
            className="btn"
            disabled={!currentId}
            title="游戏里点过「对局域网开放」之后，启动器会自动发布；这里可以手动补一次"
            onClick={async () => {
              if (!currentId) return
              const r = await api.publishInstanceManifest(currentId, port + 1).catch(() => undefined)
              if (r?.ok) toast(`模组清单已发布：${r.lanIp || lanIp}:${r.port}（${r.mods} 个 mod）`, 'success')
              else toast('发布失败：端口被占用或实例不存在', 'error')
            }}
          >
            共享我的模组清单
          </button>
          {lanOn && (
            <button
              className="btn"
              onClick={async () => {
                await api.lanStop()
                setLanOn(false)
                setLanWorlds([])
              }}
            >
              停止
            </button>
          )}
          <span className="muted small">
            好友/你自己在游戏里「对局域网开放」后，这里会自动出现；右边会显示房主的版本/加载器/模组数（房主也用的 WFMC 才看得到），点「进入」直接连。
          </span>
        </div>
        {lanOn && (
          <div className="file-list" style={{ marginTop: 10 }}>
            {lanWorlds.length === 0 && <div className="muted small">还没发现世界，等几秒或让对方重开一下局域网。</div>}
            {lanWorlds.map((w) => {
              const key = `${w.address}:${w.port}`
              const probe = probes[key]
              const manifest = probe?.ok ? probe.manifest : undefined
              return (
                <div className="file-row" key={key}>
                  <span className="ellipsis" title={w.motd}>
                    {w.motd || '局域网世界'} <span className="muted small">{w.address}:{w.port}</span>
                  </span>
                  <span className={manifest ? 'badge ok' : 'muted small'}>
                    {manifest ? envText(manifest) : probe ? '环境未知（房主没用 WFMC 开房间）' : '探测中…'}
                  </span>
                  <button
                    className="btn sm primary"
                    onClick={() =>
                      joinWorld(
                        w.address,
                        w.port,
                        manifest
                          ? { mcVersion: manifest.mcVersion, loader: manifest.loader, loaderVersion: manifest.loaderVersion }
                          : undefined
                      )
                    }
                  >
                    进入
                  </button>
                  <button
                    className="btn sm"
                    onClick={async () => {
                      setPort(w.port)
                      try {
                        const st = await api.tunnelStart(w.port)
                        setTunnel(st)
                        toast(st.publicAddress ? `已分享到公网：${st.publicAddress}` : '隧道启动中，看下面的日志', st.publicAddress ? 'success' : 'info')
                      } catch (e) {
                        toast(`分享失败：${(e as Error).message}`, 'error')
                      }
                    }}
                  >
                    分享到公网
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 2. P2P / UPnP */}
      <div className="card">
        <h3>② P2P 直连（自动改路由器端口映射）</h3>
        <div className="row wrap">
          <button
            className="btn primary"
            disabled={busy === 'upnp'}
            onClick={async () => {
              setBusy('upnp')
              try {
                const r = await api.upnpMap(port)
                // 顺带把「模组清单」端口(port+1)也映射出去，好友进服才能自动补 mod
                const manifest = await api.upnpMap(port + 1).catch(() => undefined)
                setUpnp(
                  manifest?.ok
                    ? { ...r, message: `${r.message}；模组清单端口 ${port + 1} 也已映射（房主那边开着 WFMC 的模组清单时，好友进服会自动补齐 mod）` }
                    : r
                )
              } finally {
                setBusy('')
              }
            }}
          >
            {busy === 'upnp' ? '正在和路由器协商…' : `把 ${port} 端口映射到公网`}
          </button>
          <button className="btn" onClick={async () => setPub(await api.publicEndpoint())}>
            查我的公网地址
          </button>
          <button className="btn" onClick={() => api.upnpUnmap(port)}>
            撤销映射
          </button>
        </div>
        {upnp && (
          <div className="card inner">
            <div className={upnp.ok ? 'badge ok' : 'badge warn'}>{upnp.ok ? '映射成功' : '没成功'}</div>
            <div className="small" style={{ marginTop: 6 }}>{upnp.message}</div>
            {upnp.ok && upnp.externalIp && (
              <div className="small" style={{ marginTop: 4 }}>
                把这行发给好友：<code>{upnp.externalIp}:{upnp.externalPort ?? port}</code>
              </div>
            )}
          </div>
        )}
        {pub && (
          <div className="muted small" style={{ marginTop: 8 }}>
            STUN 看到的公网出口：{pub.ip}:{pub.port}（端口是 NAT 临时映射，仅作参考）
          </div>
        )}
        <p className="muted small">
          原理：通过 UPnP 直接在你家路由器上加一条 TCP 端口映射，好友就能用「公网IP:端口」连进来，流量不过第三方服务器。
          路由器关了 UPnP 就换下面的公网中继。
        </p>
      </div>

      {/* 3. 内网穿透 */}
      <div className="card">
        <h3>③ 公网中继穿透（路由器不让映射时用）</h3>
        <div className="row wrap">
          <button
            className="btn primary"
            disabled={busy === 'tunnel' || tunnel.running}
            onClick={async () => {
              setBusy('tunnel')
              try {
                const st = await api.tunnelStart(port)
                setTunnel(st)
                if (st.publicAddress) toast(`公网地址：${st.publicAddress}`, 'success')
                else toast(st.error ?? '隧道已启动，但还没拿到公网地址，看下面的日志', 'error')
              } catch (e) {
                toast(`穿透失败：${(e as Error).message}`, 'error')
              } finally {
                setBusy('')
              }
            }}
          >
            {tunnel.running ? '穿透中…' : '开启公网穿透（bore.pub）'}
          </button>
          {tunnel.running && (
            <button
              className="btn danger"
              onClick={async () => {
                await api.tunnelStop()
                setTunnel({ running: false, logs: [] })
              }}
            >
              关闭隧道
            </button>
          )}
          <span className="muted small">
            走 <code>bore.pub</code> 公共中继，不用注册账号；第一次会自动下载 bore 客户端（约 2MB）。
            <span className="muted small">
              　注意：中继只转发游戏端口，模组服的「自动补 mod」只在局域网 / UPnP 直连时生效；走中继请让好友先用整合包对齐版本。
            </span>
          </span>
        </div>
        {tunnel.publicAddress && (
          <div className="card inner">
            <div className="badge ok">隧道已建立</div>
            <div style={{ marginTop: 6 }}>
              好友在「服务器」里加：<code>{tunnel.publicAddress}</code>
              {current && <span className="muted small">（游戏版本需与 {current.name} 一致）</span>}
            </div>
          </div>
        )}
        {tunnel.logs.length > 0 && <pre className="log" style={{ height: 140, marginTop: 10 }}>{tunnel.logs.join('\n')}</pre>}
      </div>

      {/* 4. 房间码 */}
      <div className="card">
        <h3>④ 联机码（房间号）</h3>
        <p className="muted small">
          把「公网地址:端口」压成短码，好友在启动器里输码就能直接进服，免手打 IP。
          码里还带着<strong>你的游戏版本和加载器</strong>——好友解码后启动器会自动挑对的实例，没有就当场建一个。
          码本身就是加密过的地址，跟密码一样——只发给自己人。
        </p>
        <div className="form-grid two" style={{ marginTop: 8 }}>
          <div>
            <label>
              生成码 · 地址
              <input
                value={shareHost}
                placeholder={upnp?.externalIp || tunnel.publicAddress?.split(':')[0] || lanIp || '公网IP或域名'}
                onChange={(e) => setShareHost(e.target.value)}
              />
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                onClick={async () => {
                  const host = shareHost.trim() || upnp?.externalIp || tunnel.publicAddress?.split(':')[0] || lanIp
                  if (!host) return toast('先拿到一个可用的地址（做映射/开穿透/填内网 IP）', 'error')
                  const env: RoomEnv | undefined = current
                    ? { mcVersion: current.mcVersion, loader: current.loader, loaderVersion: current.loaderVersion }
                    : undefined
                  const code = await api.encodeRoom(host, port, env)
                  setRoomCode(code)
                  const mine = await api.encodeRoom(lanIp, port, env)
                  setRoomCodeLan(mine)
                  toast(env ? '房间码已生成（含版本/加载器）' : '房间码已生成（没选实例，所以不含版本信息）', 'success')
                }}
              >
                生成房间码
              </button>
              {roomCode && (
                <button
                  className="btn"
                  onClick={() => {
                    navigator.clipboard.writeText(roomCode)
                    toast('已复制房间码', 'success')
                  }}
                >
                  复制
                </button>
              )}
            </div>
            {roomCode && (
              <div className="card inner">
                <div className="mini-label">发给好友（公网）</div>
                <b className="code" style={{ fontSize: 18, letterSpacing: 2 }}>{roomCode}</b>
                {roomCodeLan && (
                  <>
                    <div className="mini-label" style={{ marginTop: 8 }}>同局域网用（内网）</div>
                    <b className="code" style={{ fontSize: 16 }}>{roomCodeLan}</b>
                  </>
                )}
              </div>
            )}
          </div>

          <div>
            <label>
              加入 · 输入好友的房间码
              <input
                value={codeInput}
                placeholder="例如 K7M2-QH4P"
                onChange={(e) => setCodeInput(e.target.value)}
              />
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="btn primary"
                disabled={!codeInput.trim()}
                onClick={async () => {
                  try {
                    const target = await api.decodeRoom(codeInput.trim())
                    if (target.env?.mcVersion) {
                      toast(
                        `房主环境：${target.env.mcVersion} · ${loaderName(target.env.loader)}${
                          target.env.loaderVersion ? ' ' + target.env.loaderVersion : ''
                        }`,
                        'info'
                      )
                    }
                    await joinWorld(target.host, target.port, target.env)
                  } catch (e) {
                    toast(`房间码无效：${(e as Error).message}`, 'error')
                  }
                }}
              >
                解码并进服
              </button>
              <span className="muted small">不用先选实例：码里带版本就自动匹配/建实例</span>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>怎么选</h3>
        <ul className="muted small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          <li>同一个 WiFi / 同一路由器：用 ①，零配置。</li>
          <li>各自在家、路由器支持 UPnP：用 ②，延迟最低、不过第三方。</li>
          <li>公司网 / 校园网 / 运营商大内网：用 ③，能连但延迟看中继。</li>
          <li>房主也在用 WFMC：在游戏里「对局域网开放」之后，启动器会把<strong>版本 + 加载器 + 模组清单</strong>一起发出去，好友这边列表里直接能看到，点「进入」会自动补齐缺的模组（不用再问「你开的什么版本」）。</li>
          <li>进服前记得：双方游戏版本和 mod 必须一致（Minecraft 自己的限制；上面的自动补齐就是为了省这一步）。</li>
        </ul>
      </div>
    </div>
  )
}
