import net from 'node:net'
import { execFile } from 'node:child_process'

/**
 * 「我这台机器上的游戏到底开在哪个端口」
 *
 * 游戏里「对局域网开放」的端口是玩家自己填的（25565 / 1234 / 随便什么），
 * 光看设置猜不出来。这里做两件事：
 *   1. 找出本机 java 进程正在监听的 TCP 端口（netstat + tasklist 按 PID 过滤）
 *   2. 对每个候选端口做一次 Minecraft「服务器列表 ping」，能应答的才是真在开的房间
 *
 * 只有第 2 步通过才算数 —— 端口开着不等于有人玩（可能是别的程序占着）。
 */

export interface ScannedPort {
  port: number
  /** 房间名（MOTD） */
  motd?: string
  /** 游戏版本，例如 1.21.11 */
  version?: string
  players?: { online: number; max: number }
  /** 这个端口是不是 java 进程开的（= 基本可以确定是游戏） */
  fromJava?: boolean
}

/* ------------------------------ Minecraft ping ------------------------------ */

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    bytes.push(b)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function readVarInt(buf: Buffer, offset = 0): { value: number; size: number } | undefined {
  let value = 0
  let size = 0
  for (;;) {
    if (offset + size >= buf.length) return undefined
    const b = buf[offset + size]
    value |= (b & 0x7f) << (7 * size)
    size++
    if ((b & 0x80) === 0) return { value, size }
    if (size > 5) return undefined
  }
}

function handshake(host: string, port: number): Buffer {
  const hostBuf = Buffer.from(host, 'utf-8')
  const body = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(767), // 协议号随便给一个，服务端只看「next state = status」
    writeVarInt(hostBuf.length),
    hostBuf,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1)
  ])
  return Buffer.concat([writeVarInt(body.length), body])
}

/** MOTD 可能是字符串，也可能是聊天组件（{text, extra}），统一摊平成文本 */
function flattenDescription(node: unknown): string {
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(flattenDescription).join('')
  if (node && typeof node === 'object') {
    const obj = node as { text?: string; extra?: unknown; translate?: string }
    const head = typeof obj.text === 'string' ? obj.text : (obj.translate ?? '')
    return head + (obj.extra ? flattenDescription(obj.extra) : '')
  }
  return ''
}

/** 对 127.0.0.1:port 做一次服务器列表 ping；不是 Minecraft 就超时返回 undefined */
export function pingMinecraft(port: number, host = '127.0.0.1', timeoutMs = 900): Promise<ScannedPort | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const sock = new net.Socket()
    let buf = Buffer.alloc(0)
    const finish = (r?: ScannedPort) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    sock.on('error', () => finish(undefined))
    sock.on('close', () => finish(undefined))
    sock.connect(port, host, () => {
      try {
        sock.write(Buffer.concat([handshake(host, port), Buffer.from([0x01, 0x00])]))
      } catch {
        finish(undefined)
      }
    })
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const len = readVarInt(buf, 0)
      if (!len) return
      if (buf.length < len.size + len.value) return
      const packet = buf.subarray(len.size, len.size + len.value)
      const id = readVarInt(packet, 0)
      if (!id) return
      if (id.value !== 0x00) {
        finish(undefined)
        return
      }
      const strLen = readVarInt(packet, id.size)
      if (!strLen) return
      const start = id.size + strLen.size
      const json = packet.subarray(start, start + strLen.value).toString('utf-8')
      try {
        const info = JSON.parse(json) as {
          version?: { name?: string }
          players?: { online?: number; max?: number }
          description?: unknown
        }
        finish({
          port,
          motd: flattenDescription(info.description).replace(/§./g, '').trim(),
          version: info.version?.name,
          players: { online: info.players?.online ?? 0, max: info.players?.max ?? 0 }
        })
      } catch {
        finish({ port })
      }
    })
  })
}

/* ------------------------------ 端口枚举 ------------------------------ */

function runOut(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout ?? ''))
    })
  })
}

/** netstat 里处于 LISTENING 的 TCP 端口 → { port, pid } */
async function listeningPorts(): Promise<{ port: number; pid: number }[]> {
  const out = await runOut('netstat', ['-ano', '-p', 'TCP'])
  const rows: { port: number; pid: number }[] = []
  const seen = new Set<number>()
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4 || !/^tcp$/i.test(cols[0])) continue
    // 状态列在各语言版本里不一样（LISTENING / 侦听 / ABHÖREN），只认「本机自己有监听」的行：
    // 有 PID 列 + 状态不是已建立/等待
    const state = cols[3] ?? ''
    if (/ESTABLISHED|TIME_WAIT|CLOSE_WAIT|SYN_|FIN_/i.test(state) && !/LISTEN/i.test(state)) continue
    if (!/LISTEN|侦听|ABHÖREN|ABHOEREN/i.test(state)) continue
    const m = /:(\d+)$/.exec(cols[1])
    const port = m ? Number(m[1]) : 0
    if (!port || port <= 0 || seen.has(port)) continue
    seen.add(port)
    rows.push({ port, pid: cols.length >= 5 ? Number(cols[4]) || 0 : 0 })
  }
  return rows
}

/** 本机 java / javaw 进程的 PID（Windows 才有 tasklist；其它平台返回空，退回全端口扫） */
async function javaPids(): Promise<Set<number>> {
  const pids = new Set<number>()
  if (process.platform !== 'win32') return pids
  for (const image of ['java.exe', 'javaw.exe']) {
    const out = await runOut('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], 6000)
    for (const line of out.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
      if (m && m[1].toLowerCase() === image) pids.add(Number(m[2]))
    }
  }
  return pids
}

/**
 * 扫本机正在开着的 Minecraft 房间。
 * 先只探「java 进程监听的那些端口」（快、准），一个都没探到时再退一步扫全部监听端口。
 */
export async function scanMinecraftPorts(): Promise<ScannedPort[]> {
  const [ports, jPids] = await Promise.all([listeningPorts(), javaPids()])
  if (!ports.length) return []

  const javaPorts = jPids.size ? ports.filter((p) => jPids.has(p.pid)) : []
  const hit = new Map<number, ScannedPort>()

  const probeAll = async (list: { port: number }[], fromJava: boolean) => {
    const queue = list.slice(0, 300)
    const worker = async () => {
      for (;;) {
        const item = queue.shift()
        if (!item) return
        if (hit.has(item.port)) continue
        const r = await pingMinecraft(item.port)
        if (r) hit.set(item.port, { ...r, fromJava })
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker))
  }

  if (javaPorts.length) {
    await probeAll(javaPorts, true)
    if (hit.size) return sortOut(hit)
  }
  // java 进程没找到（比如游戏是别的启动器开的、或者 PID 过滤没命中）→ 扫全部监听端口
  await probeAll(
    ports.filter((p) => !hit.has(p.port)),
    false
  )
  return sortOut(hit)
}

function sortOut(hit: Map<number, ScannedPort>): ScannedPort[] {
  return [...hit.values()].sort((a, b) => {
    if (!!b.fromJava !== !!a.fromJava) return b.fromJava ? 1 : -1
    // 25565 是最常见的默认端口，排前面
    if (a.port === 25565) return -1
    if (b.port === 25565) return 1
    return a.port - b.port
  })
}
