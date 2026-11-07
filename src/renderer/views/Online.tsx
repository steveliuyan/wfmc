import React, { useEffect, useMemo, useState } from 'react'
import { api, type HostedServer, type LanWorld, type RoomEnv, type ScannedPort, type ServerManifest, type TunnelState, type UpnpResult } from '../api'
import type { Instance } from '../../shared/types'
import { useLauncher, useT } from '../store'
import { joinWithSync } from '../joinWithSync'
import RoomManifestCard from '../components/RoomManifestCard'
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
  const { toast, current, currentId, askConfirm, instances, setCurrentId, refreshInstances, tasks } = useLauncher()
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
  const [codeInput, setCodeInput] = useState(() => {
    try {
      return localStorage.getItem('wfmc.roomCodeInput') ?? ''
    } catch {
      return ''
    }
  })
  // 切页面回来不要丢：每次改动都存一份到本地
  useEffect(() => {
    try {
      localStorage.setItem('wfmc.roomCodeInput', codeInput)
    } catch {
      /* 隐私模式就算了 */
    }
  }, [codeInput])
  // 「扫描端口」的结果（本机正在开着的游戏端口）
  const [scanning, setScanning] = useState(false)
  const [scanned, setScanned] = useState<ScannedPort[]>([])
  // 本机游戏「对局域网开放」实际用的端口（游戏里自己填的，不一定是 25565）
  const [myPort, setMyPort] = useState<{ instanceId?: string; port?: number }>({})
  // 当前实例的模组清单共享在哪个端口（0 = 没共享）
  const [livePort, setLivePort] = useState(0)
  // 手动发布的模组数（用来把「共享中」说得具体点）
  const [publishedMods, setPublishedMods] = useState(0)
  // 判断不出该用哪个实例时，让用户直接在列表里点一个
  const [pick, setPick] = useState<{ address: string; port: number; env?: RoomEnv } | null>(null)
  // 每个局域网世界背后的环境（房主开了 WFMC 的模组清单才探得到）；at=上次探测时间，用来允许重探
  const [probes, setProbes] = useState<Record<string, { ok: boolean; manifest?: ServerManifest; at: number }>>({})

  const installing = tasks.find((x) => x.kind === 'install' && (x.status === 'running' || x.status === 'paused'))
  const myWorld = useMemo(() => lanWorlds.find((w) => !!lanIp && w.address === lanIp), [lanWorlds, lanIp])

  useEffect(() => {
    api.lanIp().then(setLanIp)
    api.listHosted().then(setHosting)
    api.tunnelState().then(setTunnel)
    refreshInstances().catch(() => undefined)
  }, [])

  // 端口自动识别①：launch.ts 从游戏日志里解析出的「对局域网开放」端口
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const mine = await api.myLanPort().catch(() => ({}) as { instanceId?: string; port?: number })
      if (alive) setMyPort(mine)
    }
    void tick()
    const timer = setInterval(tick, 3000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 只在「游戏报出来的端口变了」时才覆盖输入框，用户手动改的不会被每 3 秒顶回去
  useEffect(() => {
    const p = myPort.port
    if (!p) return
    setPort((cur) => (cur === p ? cur : p))
    toast(`自动识别到游戏局域网端口 ${p}（已帮你填好）`, 'info')
  }, [myPort.port])

  // 端口自动识别②：还没拿到日志端口时，从局域网广播里认出「自己的房间」
  useEffect(() => {
    if (!myWorld || myPort.port) return
    if (port === myWorld.port) return
    setPort(myWorld.port)
    toast(`自动识别到游戏局域网端口 ${myWorld.port}（从「${myWorld.motd || '我的房间'}」广播里认出来的）`, 'info')
  }, [myWorld, myPort.port, port])

  // 模组清单共享状态（游戏里开房间后由 launch.ts 自动发布，这里只负责显示）
  useEffect(() => {
    if (!currentId) {
      setLivePort(0)
      return
    }
    let alive = true
    const tick = async () => {
      const p = await api.instanceManifestPort(currentId).catch(() => 0)
      if (alive) setLivePort(p)
    }
    void tick()
    const timer = setInterval(tick, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [currentId])

  // 端口变了（手填 / 自动识别到新端口）→ 已经共享出去的模组清单要跟着搬到新端口。
  // 不搬的话：先在默认 25565 点了「共享我的模组清单」，等游戏报出 1234 之后，
  // 好友按房间里的 1234 探过来永远探不到清单（服务还挂在 25566）。
  useEffect(() => {
    if (!livePort || !currentId) return
    if (livePort === port + 1) return
    let alive = true
    void api
      .publishInstanceManifest(currentId, port + 1)
      .then((r) => {
        if (!alive || !r?.ok) return
        setLivePort(r.port ?? port + 1)
        setPublishedMods(r.mods ?? 0)
        toast(`端口变了，模组清单已跟着换到 ${r.lanIp || lanIp}:${r.port}`, 'info')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [port, currentId])

  // 局域网世界轮询
  useEffect(() => {
    if (!lanOn) return
    const timer = setInterval(async () => setLanWorlds(await api.lanList()), 2000)
    return () => clearInterval(timer)
  }, [lanOn])

  // 探一下每个世界的版本/加载器/模组数。探不到的 8 秒后重探 ——
  // 房主可能先进游戏、后点「共享模组清单」，只探一次就永远看不到。
  useEffect(() => {
    if (!lanOn) return
    const now = Date.now()
    const todo = lanWorlds
      .filter((w) => {
        const prev = probes[`${w.address}:${w.port}`]
        return !prev || (!prev.ok && now - prev.at > 8000)
      })
      .slice(0, 6)
    if (!todo.length) return
    let cancelled = false
    ;(async () => {
      // 并发探，串行探一排世界会等到天荒地老
      const rows = await Promise.all(
        todo.map(async (w) => {
          const key = `${w.address}:${w.port}`
          try {
            const r = await api.serverSyncProbe(w.address, w.port)
            return [key, r.found ? { ok: true, manifest: r.manifest, at: Date.now() } : { ok: false, at: Date.now() }] as const
          } catch {
            return [key, { ok: false, at: Date.now() }] as const
          }
        })
      )
      if (!cancelled) setProbes((p) => ({ ...p, ...Object.fromEntries(rows) }))
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

  /** 手动发布当前实例的模组清单（游戏里开房间时 launch.ts 会自动发，这里是手动补一刀） */
  const shareManifest = async () => {
    const target = current ?? instances.find((i) => i.id === currentId)
    if (!target) {
      toast('先在左侧选一个实例（共享出去的就是它的 mods 目录）', 'error')
      return
    }
    const basePort = (myPort.port ?? port) + 1
    setBusy('manifest')
    try {
      const r = await api.publishInstanceManifest(target.id, basePort).catch(() => undefined)
      if (r?.ok) {
        setLivePort(r.port ?? basePort)
        setPublishedMods(r.mods ?? 0)
        toast(`模组清单已发布：${r.lanIp || lanIp}:${r.port}（${r.mods} 个 mod）`, 'success')
      } else {
        toast('发布失败：端口被占用或实例不存在', 'error')
      }
    } finally {
      setBusy('')
    }
  }

  /** 本地有没有「同版本 + 同加载器」的实例 */
  const matchInstance = (list: Instance[], env?: RoomEnv): Instance | undefined => {
    if (!env?.mcVersion) return undefined
    const loader = env.loader ?? 'vanilla'
    return list.find((i) => i.mcVersion === env.mcVersion && (i.loader ?? 'vanilla') === loader)
  }

  /** 游戏本体没装好就先装（续传），装不好就绝不进服 —— 顺序错了就是「先加 mod 再进服然后报错」 */
  const ensureInstalled = async (id: string): Promise<boolean> => {
    const fresh = (await api.listInstances()).find((i) => i.id === id)
    if (!fresh) {
      toast('实例不见了（可能被删了），请重新选一个', 'error')
      return false
    }
    if (fresh.installed) return true
    const ok = await askConfirm({
      title: '游戏本体还没装完',
      message: `实例「${fresh.name}」的游戏文件不完整（上次下载大概中断了）。\n\n现在接着下载吗？已经下好的文件会自动跳过，不用从头来。装完才会真正进服，然后才补模组。`,
      okText: '继续下载'
    })
    if (!ok) return false
    toast('开始补齐游戏本体，装完会自动继续…', 'info')
    try {
      await api.installGame(fresh.id)
    } catch (e) {
      toast(`游戏本体没装完：${(e as Error).message}`, 'error')
      return false
    }
    const after = (await api.listInstances()).find((i) => i.id === id)
    if (!after?.installed) {
      toast('游戏本体还是不完整：去「实例」页点一次「校验/补全文件」再来', 'error')
      return false
    }
    await refreshInstances().catch(() => undefined)
    toast('游戏本体已就绪', 'success')
    return true
  }

  /**
   * 进服前把「游戏文件」备齐。
   * 优先走局域网整包直传：房主机器上有版本文件 / 模组 / Java 运行时，
   * 同一个路由器下拷过来比让好友各自去外网下几百 MB 稳得多（版本对不上、Java 下不下来是大坑）。
   */
  const prepareFiles = async (id: string, address: string, portNumber: number): Promise<boolean> => {
    const fresh = (await api.listInstances()).find((i) => i.id === id)
    if (!fresh) {
      toast('实例不见了（可能被删了），请重新选一个', 'error')
      return false
    }
    if (fresh.installed) return true

    const probe = await api
      .serverSyncProbe(address, portNumber)
      .catch(() => ({ found: false }) as { found: boolean; manifest?: ServerManifest })
    const canDirect = !!(probe.found && probe.manifest?.pack)

    if (canDirect) {
      // 局域网里直接拷是用户明确要的默认行为：不再弹窗问一遍（问了也只是点「好」），
      // 拷不动或者拷完还是不全，下面会自动退回去自己下载。
      toast(`房主开着整包直传，从他那台机直接拷版本文件/模组/Java（进度在右下角，可以取消）…`, 'info')
      try {
        const r = await api.pullPackFromHost(id, address, portNumber)
        if (!r.ok) toast(r.message || '拷贝没完成，接着自己下载补齐…', 'error')
        else toast(`拷好了：${r.downloaded} 个文件，跳过 ${r.skipped} 个`, 'success')
      } catch (e) {
        toast(`从房主拷文件失败：${(e as Error).message}`, 'error')
      }
      await refreshInstances().catch(() => undefined)
      const after = (await api.listInstances()).find((i) => i.id === id)
      if (after?.installed) return true
      toast('文件还是不全，接着自己下载补齐…', 'info')
    }

    return await ensureInstalled(id)
  }

  /** 按房主环境建实例（这里只建，不装游戏，装什么由 ensureInstalled 统一管） */
  const createInstanceFor = async (env: RoomEnv): Promise<Instance | undefined> => {
    const mc = env.mcVersion as string
    const loader = env.loader ?? 'vanilla'
    const ok = await askConfirm({
      title: '建实例并进服',
      message: `本地没有「${mc} · ${loaderName(loader)}」的实例。\n\n现在建一个再进服吗？建完会先把游戏文件备齐：房主开着「整包直传」就直接从他机器上拷（局域网内很快，几百 MB 也不用等下载），否则才自己下载。装完才进服。`,
      okText: '建实例并进服'
    })
    if (!ok) return undefined
    let loaderVersion = env.loaderVersion
    if (loader !== 'vanilla' && !loaderVersion) {
      const list = await api.loaderVersions(loader, mc).catch(() => [] as { value: string; stable?: boolean }[])
      loaderVersion = (list.find((v) => v.stable) ?? list[0])?.value
    }
    try {
      const inst = await api.createInstance({ name: `${mc} ${loaderName(loader)}`, mcVersion: mc, loader, loaderVersion })
      await refreshInstances().catch(() => undefined)
      toast(`实例「${inst.name}」建好了`, 'success')
      return inst
    } catch (e) {
      toast(`建实例失败：${(e as Error).message}`, 'error')
      return undefined
    }
  }

  /**
   * 进服主流程（顺序不能反）：
   * 定实例（按环境匹配 → 按环境新建 → 选中的 → 唯一的 → 让用户点一个）
   * → 确认游戏本体装好了（没装先续传）→ 才 joinWithSync 补模组并进服。
   * 以前是先 joinWithSync（补 mod）再发现本体没装，就变成用户说的「先加 mod、再进服、然后报错」。
   */
  const startJoin = async (address: string, portNumber: number, env?: RoomEnv, hintInstanceId?: string) => {
    setPick(null)
    try {
      const list = await api.listInstances()
      let target = hintInstanceId ? list.find((i) => i.id === hintInstanceId) : undefined
      if (!target) target = matchInstance(list, env)
      if (!target && env?.mcVersion) {
        target = await createInstanceFor(env)
        if (!target) return
      }
      if (!target) target = list.find((i) => i.id === currentId)
      if (!target && list.length === 1) {
        target = list[0]
        toast(`没选实例，自动用「${target.name}」进服`, 'info')
      }
      if (!target) {
        if (!list.length) {
          toast(
            '本地还没有实例，也没探到房主的房间信息（要房主也用 WFMC，并且联机页里显示「模组清单共享中」）。两个办法：① 让房主确认那边共享着；② 用房主的房间码进（码里带版本，会自动建实例并从他那拷文件）。',
            'error'
          )
          return
        }
        setPick({ address, port: portNumber, env })
        toast('下面列出的实例里点一个就能进（不用先去左边选）', 'info')
        return
      }
      if (env?.mcVersion) toast(`用实例「${target.name}」进服（${env.mcVersion} · ${loaderName(env.loader)}）`, 'info')
      if (target.id !== currentId) setCurrentId(target.id)
      if (!(await prepareFiles(target.id, address, portNumber))) return
      const joined = await joinWithSync({
        instanceId: target.id,
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
          {myPort.port ? (
            <span className="muted small">
              游戏实际端口：
              <button className="chip" style={{ marginLeft: 6 }} onClick={() => setPort(myPort.port as number)}>
                {myPort.port}
              </button>
              {port === myPort.port ? '（已在用）' : '（点一下切过去）'}
            </span>
          ) : (
            <span className="muted small">
              游戏里点过「对局域网开放」之后，这里的端口会自动变成游戏实际用的那个（不用手填）
            </span>
          )}
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
          <button
            className="btn sm"
            disabled={scanning}
            onClick={async () => {
              setScanning(true)
              try {
                const rows = await api.scanLanPorts()
                setScanned(rows)
                if (!rows.length) {
                  toast('没扫到正在开的房间：先在游戏里点「对局域网开放」再扫一次', 'error')
                } else if (rows.length === 1) {
                  setPort(rows[0].port)
                  toast(`扫到 ${rows[0].port} 端口上的房间，已帮你填好`, 'success')
                } else {
                  toast(`扫到 ${rows.length} 个端口，点一个填进输入框`, 'info')
                }
              } catch (e) {
                toast(`扫描失败：${(e as Error).message}`, 'error')
              } finally {
                setScanning(false)
              }
            }}
          >
            {scanning ? '扫描中…' : '扫描端口'}
          </button>
          <button className="btn sm" onClick={() => goto('hosting')}>
            去开服
          </button>
        </div>
        {scanned.length > 0 && (
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="muted small">扫到的房间：</span>
            {scanned.map((s) => (
              <button
                key={s.port}
                className={`chip${s.port === port ? ' on' : ''}`}
                title={`${s.motd || '未命名房间'}${s.version ? ` · ${s.version}` : ''}${
                  s.players ? ` · ${s.players.online}/${s.players.max} 人` : ''
                }`}
                onClick={() => setPort(s.port)}
              >
                {s.port}
                {s.version ? ` · ${s.version}` : ''}
                {s.motd ? ` · ${s.motd.slice(0, 16)}` : ''}
              </button>
            ))}
          </div>
        )}
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
            disabled={!currentId || busy === 'manifest'}
            title="游戏里点过「对局域网开放」之后，启动器会自动发布；这里可以手动补一次"
            onClick={shareManifest}
          >
            {busy === 'manifest' ? '发布中…' : '共享我的模组清单'}
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

        {/* 共享状态：让用户看得见「点完到底发生了什么」 */}
        {livePort > 0 && (
          <div className="card inner" style={{ marginTop: 10 }}>
            <div className="badge ok">模组清单共享中（端口 {livePort}）</div>
            <div className="small" style={{ marginTop: 6 }}>
              {current?.name ?? '当前实例'} 的 mods 清单已经发在
              <code>
                {' '}
                http://{lanIp || '<你的内网IP>'}:{livePort}/manifest.json
              </code>
              {publishedMods > 0 ? `（${publishedMods} 个 mod）` : ''}
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              这个地址是给<strong>好友</strong>用的：他那边「局域网联机」列表里会出现你的房间，右边显示「版本 · 加载器 · N 个模组」，
              点「进入」时缺的 mod 会自动从你这台机下载、补齐后进服。<strong>你自己这边不会有什么变化</strong>（不需要下载自己的 mod），
              所以别在自己的列表里找「下载」；想验证就在好友那台机上打开联机页看一眼。
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              同一个服务还带着<strong>整包直传</strong>：好友那边缺游戏版本文件、缺 Java 运行时，也能直接从你这台机拷，
              不用各自去外网下几百 MB（国内下 Java 经常断，这条路最稳）。
            </div>
            <div className="muted small" style={{ marginTop: 4 }}>
              传的只有<strong>能进服必需的东西</strong>：版本文件、libraries、assets、mods、config 和 Java 运行时。
              <strong>存档（saves）、日志、截图、资源包都不传</strong> —— 你的世界还是你自己的。
            </div>
          </div>
        )}

        {/* 判断不出用哪个实例时，直接让用户点一个，别把人堵在「先在左侧选实例」 */}
        {pick && (
          <div className="card inner" style={{ marginTop: 10 }}>
            <div className="small">
              用哪个实例进「{pick.address}:{pick.port}」？
            </div>
            <div className="row wrap" style={{ marginTop: 8 }}>
              {instances.map((i) => (
                <button
                  key={i.id}
                  className={i.id === currentId ? 'btn sm primary' : 'btn sm'}
                  onClick={() => {
                    setCurrentId(i.id)
                    void startJoin(pick.address, pick.port, pick.env, i.id)
                  }}
                >
                  {i.name}（{i.mcVersion}
                  {i.loader && i.loader !== 'vanilla' ? ` · ${loaderName(i.loader)}` : ''}）
                  {i.installed ? '' : ' · 未安装'}
                </button>
              ))}
              <button className="btn sm" onClick={() => setPick(null)}>
                取消
              </button>
            </div>
          </div>
        )}

        {/* 下载进度：卡住了能取消、能续传 */}
        {installing && (
          <div className="card inner" style={{ marginTop: 10 }}>
            <div className="small">
              正在下载：{installing.phase ?? installing.title}
              {installing.total ? `（${installing.current ?? 0}/${installing.total}）` : ''}
            </div>
            <div className="row wrap" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => api.cancelTask(installing.id)}>
                取消下载
              </button>
              <span className="muted small">
                卡在同一个数字很久不动？点取消，再点一次「进入」会接着下（已下好的文件直接跳过，不重下）。
              </span>
            </div>
          </div>
        )}
        {lanOn && (
          <div className="file-list" style={{ marginTop: 10 }}>
            {lanWorlds.length === 0 && <div className="muted small">还没发现世界，等几秒或让对方重开一下局域网。</div>}
            {lanWorlds.map((w) => {
              const key = `${w.address}:${w.port}`
              const probe = probes[key]
              const manifest = probe?.ok ? probe.manifest : undefined
              const isMine = !!lanIp && w.address === lanIp
              return (
                <div className="file-row" key={key}>
                  <span className="ellipsis" title={w.motd}>
                    {isMine && (
                      <span className="badge ok" style={{ marginRight: 6 }}>
                        我的房间
                      </span>
                    )}
                    {w.motd || '局域网世界'} <span className="muted small">{w.address}:{w.port}</span>
                  </span>
                  <span className={manifest ? 'badge ok' : 'muted small'}>
                    {manifest ? envText(manifest) : probe ? '环境未知（房主没开 WFMC 共享）' : '探测中…'}
                  </span>
                  {manifest?.pack && !isMine && (
                    <span className="badge" title="房主开着整包直传：缺的文件可以从他机器上直接拷，不用重新下载">
                      可直传
                    </span>
                  )}
                  <button
                    className="btn sm primary"
                    onClick={() =>
                      startJoin(
                        w.address,
                        w.port,
                        manifest
                          ? { mcVersion: manifest.mcVersion, loader: manifest.loader, loaderVersion: manifest.loaderVersion }
                          : undefined,
                        // 自己的房间：直接用开这个房间的那个实例，别去猜
                        isMine && myPort.port === w.port ? myPort.instanceId : undefined
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
                    await startJoin(target.host, target.port, target.env)
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

      <RoomManifestCard
        instanceId={currentId}
        instanceName={current?.name}
        defaultHost={shareHost.trim() || upnp?.externalIp || tunnel.publicAddress?.split(':')[0] || lanIp}
        defaultPort={port}
      />

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
