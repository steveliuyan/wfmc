import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { store } from './store'
import { downloadFile } from './net'

/* ------------------------------------------------------------------ *
 * 1) 局域网世界发现（Minecraft LAN 广播 224.0.2.60:4445）
 * ------------------------------------------------------------------ */

export interface LanWorld {
  motd: string
  port: number
  address: string
  lastSeen: number
}

const lanWorlds = new Map<string, LanWorld>()
let lanSocket: dgram.Socket | undefined

export function lanStart(): { running: boolean; worlds: LanWorld[] } {
  if (lanSocket) return { running: true, worlds: [...lanWorlds.values()] }
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  lanSocket = sock
  sock.on('message', (msg, rinfo) => {
    const text = msg.toString('utf-8')
    const motd = /\[MOTD\](.*?)\[\/MOTD\]/s.exec(text)?.[1] ?? ''
    const ad = /\[AD\](\d+)\[\/AD\]/.exec(text)?.[1]
    if (!ad) return
    lanWorlds.set(rinfo.address, {
      motd: motd.replace(/§./g, ''),
      port: Number(ad),
      address: rinfo.address,
      lastSeen: Date.now()
    })
  })
  sock.on('error', () => {
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    lanSocket = undefined
  })
  try {
    sock.bind(4445, () => {
      try {
        sock.setBroadcast(true)
        sock.addMembership('224.0.2.60')
      } catch {
        /* 某些网卡不支持组播，仍然能收到广播 */
      }
    })
  } catch {
    lanSocket = undefined
  }
  return { running: true, worlds: [] }
}

export function lanStop(): void {
  try {
    lanSocket?.close()
  } catch {
    /* 忽略 */
  }
  lanSocket = undefined
}

export function lanList(): LanWorld[] {
  // 15 秒没更新就算过期
  const now = Date.now()
  for (const [key, world] of lanWorlds) if (now - world.lastSeen > 15000) lanWorlds.delete(key)
  return [...lanWorlds.values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

/* ------------------------------------------------------------------ *
 * 2) STUN：查自己的公网 IP / 端口（P2P 直连要用）
 * ------------------------------------------------------------------ */

function stunRequest(server: string, port = 19302): Promise<{ ip: string; port: number }> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      reject(new Error('STUN 超时（可能是 UDP 被限制）'))
    }, 4000)

    // Binding Request: type=0x0001, length=0, magic cookie, 12 字节 transaction id
    const buf = Buffer.alloc(20)
    buf.writeUInt16BE(0x0001, 0)
    buf.writeUInt16BE(0x0000, 2)
    buf.writeUInt32BE(0x2112a442, 4)
    for (let i = 8; i < 20; i++) buf[i] = Math.floor(Math.random() * 256)

    sock.on('message', (msg) => {
      clearTimeout(timer)
      try {
        // 解析属性，找 XOR-MAPPED-ADDRESS(0x0020) 或 MAPPED-ADDRESS(0x0001)
        let offset = 20
        while (offset + 4 <= msg.length) {
          const type = msg.readUInt16BE(offset)
          const len = msg.readUInt16BE(offset + 2)
          if (type === 0x0020 || type === 0x0001) {
            const family = msg[offset + 5]
            if (family === 0x01) {
              const xor = type === 0x0020
              const p = msg.readUInt16BE(offset + 6) ^ (xor ? 0x2112 : 0)
              const ipBytes = msg.subarray(offset + 8, offset + 12)
              const ip = xor
                ? [...ipBytes].map((b, i) => b ^ [0x21, 0x12, 0xa4, 0x42][i]).join('.')
                : [...ipBytes].join('.')
              sock.close()
              resolve({ ip, port: p })
              return
            }
          }
          offset += 4 + len + ((4 - (len % 4)) % 4)
        }
        sock.close()
        reject(new Error('STUN 响应里没有地址'))
      } catch (e) {
        sock.close()
        reject(e as Error)
      }
    })
    sock.send(buf, port, server, (err) => {
      if (err) {
        clearTimeout(timer)
        sock.close()
        reject(err)
      }
    })
  })
}

export async function publicEndpoint(): Promise<{ ip: string; port: number } | undefined> {
  for (const host of ['stun.l.google.com', 'stun1.l.google.com', 'stun.cloudflare.com']) {
    try {
      return await stunRequest(host)
    } catch {
      /* 换下一个 */
    }
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * 3) UPnP：自动给路由器加端口映射（家庭宽带下最像"真 P2P"的做法）
 * ------------------------------------------------------------------ */

function ssdpFindGateway(timeoutMs = 3000): Promise<{ location: string } | undefined> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const msg = Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 2',
        'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1',
        '',
        ''
      ].join('\r\n')
    )
    let done = false
    const finish = (value?: { location: string }) => {
      if (done) return
      done = true
      try {
        sock.close()
      } catch {
        /* 忽略 */
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    sock.on('message', (res) => {
      const text = res.toString('utf-8')
      const location = /LOCATION:\s*(\S+)/i.exec(text)?.[1]
      if (location) {
        clearTimeout(timer)
        finish({ location })
      }
    })
    sock.on('error', () => finish(undefined))
    sock.send(msg, 1900, '239.255.255.250')
  })
}

async function soapControl(
  controlUrl: string,
  serviceType: string,
  action: string,
  body: string
): Promise<string> {
  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${serviceType}#${action}"`
    },
    body: `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${body}</s:Body>
</s:Envelope>`
  })
  return await res.text()
}

export interface UpnpResult {
  ok: boolean
  externalIp?: string
  externalPort?: number
  message: string
}

/** 通过 UPnP 把本机端口映射到公网 */
export async function upnpMap(
  internalPort: number,
  description = 'WFMC Minecraft'
): Promise<UpnpResult> {
  const gw = await ssdpFindGateway()
  if (!gw) return { ok: false, message: '没找到支持 UPnP 的路由器（可能关了 UPnP 或网络不是家用路由）' }

  let desc = ''
  try {
    desc = await (await fetch(gw.location, { headers: { 'User-Agent': 'WFMC/1.0 UPnP/1.1' } })).text()
  } catch {
    return { ok: false, message: '读取路由器描述文件失败' }
  }

  // 找 WANIPConnection / WANPPPConnection 的 controlURL
  const serviceBlock =
    /<service>[\s\S]*?WANIPConnection[\s\S]*?<\/service>/i.exec(desc)?.[0] ??
    /<service>[\s\S]*?WANPPPConnection[\s\S]*?<\/service>/i.exec(desc)?.[0]
  if (!serviceBlock) return { ok: false, message: '路由器没暴露 WAN 连接服务' }

  const serviceType = /<serviceType>(.*?)<\/serviceType>/i.exec(serviceBlock)?.[1] ?? 'urn:schemas-upnp-org:service:WANIPConnection:1'
  const controlPath = /<controlURL>(.*?)<\/controlURL>/i.exec(serviceBlock)?.[1] ?? ''
  const base = new URL(gw.location)
  const controlUrl = new URL(controlPath, base).toString()

  let externalIp = ''
  try {
    const xml = await soapControl(
      controlUrl,
      serviceType,
      'GetExternalIPAddress',
      '<u:GetExternalIPAddress xmlns:u="' + serviceType + '"></u:GetExternalIPAddress>'
    )
    externalIp = /<NewExternalIPAddress>(.*?)<\/NewExternalIPAddress>/i.exec(xml)?.[1] ?? ''
  } catch {
    /* 拿不到公网 IP 也继续尝试映射 */
  }

  const extPort = internalPort
  const localIp = firstLanIp()
  const body = `<u:AddPortMapping xmlns:u="${serviceType}">
    <NewRemoteHost></NewRemoteHost>
    <NewExternalPort>${extPort}</NewExternalPort>
    <NewProtocol>TCP</NewProtocol>
    <NewInternalPort>${internalPort}</NewInternalPort>
    <NewInternalClient>${localIp}</NewInternalClient>
    <NewEnabled>1</NewEnabled>
    <NewPortMappingDescription>${description}</NewPortMappingDescription>
    <NewLeaseDuration>0</NewLeaseDuration>
  </u:AddPortMapping>`

  try {
    const res = await soapControl(controlUrl, serviceType, 'AddPortMapping', body)
    if (/errorCode/i.test(res) || /<errorCode>/.test(res)) {
      return { ok: false, message: '路由器拒绝端口映射（可能已有冲突规则）' }
    }
  } catch (e) {
    return { ok: false, message: `端口映射请求失败：${(e as Error).message}` }
  }

  return {
    ok: true,
    externalIp: externalIp || undefined,
    externalPort: extPort,
    message: externalIp
      ? `已映射成功：好友可连 ${externalIp}:${extPort}`
      : `已提交映射，公网 IP 查不到，用路由器 WAN IP + ${extPort} 试`
  }
}

export async function upnpUnmap(internalPort: number): Promise<void> {
  const gw = await ssdpFindGateway()
  if (!gw) return
  try {
    const desc = await (await fetch(gw.location)).text()
    const serviceBlock =
      /<service>[\s\S]*?WANIPConnection[\s\S]*?<\/service>/i.exec(desc)?.[0] ??
      /<service>[\s\S]*?WANPPPConnection[\s\S]*?<\/service>/i.exec(desc)?.[0]
    if (!serviceBlock) return
    const serviceType = /<serviceType>(.*?)<\/serviceType>/i.exec(serviceBlock)?.[1] ?? ''
    const controlPath = /<controlURL>(.*?)<\/controlURL>/i.exec(serviceBlock)?.[1] ?? ''
    const controlUrl = new URL(controlPath, new URL(gw.location)).toString()
    await soapControl(
      controlUrl,
      serviceType,
      'DeletePortMapping',
      `<u:DeletePortMapping xmlns:u="${serviceType}"><NewRemoteHost></NewRemoteHost><NewExternalPort>${internalPort}</NewExternalPort><NewProtocol>TCP</NewProtocol></u:DeletePortMapping>`
    )
  } catch {
    /* 忽略 */
  }
}

export function firstLanIp(): string {
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

/* ------------------------------------------------------------------ *
 * 4) 内网穿透：bore 公共中继（不需要账号、不需要自己搭服务器）
 * ------------------------------------------------------------------ */

export interface TunnelState {
  running: boolean
  localPort?: number
  publicAddress?: string
  logs: string[]
  error?: string
}

let tunnel: { proc: ChildProcess; state: TunnelState } | undefined

function boreBinary(): string {
  const dir = path.join(store.dataDir, 'tools')
  return path.join(dir, 'bore.exe')
}

async function ensureBore(): Promise<string> {
  const exe = boreBinary()
  if (fs.existsSync(exe) && fs.statSync(exe).size > 100_000) return exe
  fs.mkdirSync(path.dirname(exe), { recursive: true })

  const PINNED = 'v0.6.0'
  const candidates: string[] = []

  // 1) 先问 GitHub API 拿最新版（网络不通就跳过）
  try {
    const rel = await fetch('https://api.github.com/repos/ekzhang/bore/releases/latest', {
      headers: { 'User-Agent': 'WFMC', Accept: 'application/vnd.github+json' }
    }).then((r) => r.json() as Promise<{ assets?: { name: string; browser_download_url: string }[] }>)
    const asset =
      rel.assets?.find((a) => /x86_64-pc-windows-msvc\.zip$/i.test(a.name)) ??
      rel.assets?.find((a) => /windows.*\.zip$/i.test(a.name))
    if (asset?.browser_download_url) candidates.push(asset.browser_download_url)
  } catch {
    /* 走固定版本地址 */
  }

  // 2) 固定版本直连 + 镜像回退
  const pinnedPath = `/ekzhang/bore/releases/download/${PINNED}/bore-${PINNED}-x86_64-pc-windows-msvc.zip`
  candidates.push(
    `https://github.com${pinnedPath}`,
    `https://ghfast.top/https://github.com${pinnedPath}`,
    `https://gh-proxy.com/https://github.com${pinnedPath}`
  )

  const zipPath = path.join(store.dataDir, 'tools', 'bore.zip')
  let lastError: unknown
  for (const url of candidates) {
    try {
      await downloadFile(url, zipPath, undefined, { skipIfExists: false })
      const { readZipFromFile, readZipEntry } = await import('./zip')
      const { buf, entries } = readZipFromFile(zipPath)
      const entry = entries.find((e) => e.name.toLowerCase().endsWith('bore.exe'))
      if (!entry) throw new Error('bore.zip 里没有 bore.exe')
      fs.writeFileSync(exe, readZipEntry(buf, entry))
      fs.rmSync(zipPath, { force: true })
      return exe
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(
    `下载 bore 客户端失败（${(lastError as Error)?.message ?? '网络不通'}）。` +
      `可以手动把 bore.exe 放到 ${path.dirname(exe)} 再重试。`
  )
}

export function tunnelState(): TunnelState {
  return tunnel?.state ?? { running: false, logs: [] }
}

/** 起一个公网中继，把本机 127.0.0.1:localPort 暴露成 bore.pub:xxxxx */
export async function tunnelStart(
  localPort: number,
  relay = 'bore.pub'
): Promise<TunnelState> {
  if (tunnel?.state.running) return tunnel.state
  const exe = await ensureBore()

  const state: TunnelState = { running: true, localPort, logs: [] }
  const proc = spawn(exe, ['local', String(localPort), '--to', relay], { windowsHide: true })
  tunnel = { proc, state }

  const push = (line: string) => {
    state.logs.push(line)
    state.logs = state.logs.slice(-300)
    const match = /listening at (\S+:\d+)/i.exec(line)
    if (match) state.publicAddress = match[1]
  }

  const pipe = (stream: NodeJS.ReadableStream | null | undefined) => {
    if (!stream) return
    let buf = ''
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) push(l.trim())
    })
  }
  pipe(proc.stdout)
  pipe(proc.stderr)

  proc.on('exit', (code) => {
    state.running = false
    push(`[隧道] 已结束 code=${code}`)
    tunnel = undefined
  })
  proc.on('error', (e) => {
    state.running = false
    state.error = e.message
    push(`[隧道] 启动失败：${e.message}`)
    tunnel = undefined
  })

  // 等最多 15 秒拿公网地址
  for (let i = 0; i < 30 && !state.publicAddress && state.running; i++) {
    await new Promise((r) => setTimeout(r, 500))
  }
  return state
}

export function tunnelStop(): void {
  if (!tunnel) return
  try {
    tunnel.proc.kill()
  } catch {
    /* 忽略 */
  }
  tunnel.state.running = false
  tunnel = undefined
}
