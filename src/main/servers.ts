import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import dns from 'node:dns/promises'
import { randomUUID } from 'node:crypto'
import type { SavedServer, ServerStatus } from '../shared/types'
import { store } from './store'

function serversFile() {
  return path.join(store.dataDir, 'servers.json')
}

export function listServers(): SavedServer[] {
  try {
    const raw = JSON.parse(fs.readFileSync(serversFile(), 'utf-8')) as { servers: SavedServer[] }
    return raw.servers ?? []
  } catch {
    return []
  }
}

function saveServers(servers: SavedServer[]) {
  fs.mkdirSync(store.dataDir, { recursive: true })
  fs.writeFileSync(serversFile(), JSON.stringify({ servers }, null, 2), 'utf-8')
}

export function addServer(input: { name?: string; address: string; port?: number; note?: string }): SavedServer {
  const server: SavedServer = {
    id: randomUUID(),
    name: input.name?.trim() || input.address,
    address: input.address.trim(),
    port: input.port,
    note: input.note,
    createdAt: Date.now()
  }
  saveServers([...listServers(), server])
  return server
}

export function removeServer(id: string): SavedServer[] {
  const next = listServers().filter((s) => s.id !== id)
  saveServers(next)
  return next
}

export function updateServer(id: string, patch: Partial<SavedServer>): SavedServer[] {
  const next = listServers().map((s) => (s.id === id ? { ...s, ...patch, id: s.id } : s))
  saveServers(next)
  return next
}

// ---------------- Minecraft Server List Ping ----------------

function writeVarInt(value: number): Buffer {
  const bytes: number[] = []
  let v = value
  for (;;) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v)
      break
    }
    bytes.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  return Buffer.from(bytes)
}

function writeString(str: string): Buffer {
  const buf = Buffer.from(str, 'utf-8')
  return Buffer.concat([writeVarInt(buf.length), buf])
}

function readVarInt(buf: Buffer, offset: number): { value: number; size: number } | undefined {
  let value = 0
  let size = 0
  for (;;) {
    if (offset + size >= buf.length) return undefined
    const byte = buf[offset + size]
    value |= (byte & 0x7f) << (7 * size)
    size++
    if ((byte & 0x80) === 0) return { value, size }
    if (size > 5) return undefined
  }
}

interface PingResult {
  version?: string
  protocol?: number
  players?: { online: number; max: number; sample?: string[] }
  motd?: string
  favicon?: string
}

/** 通过 SRV 记录解析真实入口（2b2t.org 这类服务器必须） */
export async function resolveSrv(host: string): Promise<{ host: string; port: number } | undefined> {
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`)
    if (!records.length) return undefined
    const best = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0]
    return { host: best.name, port: best.port }
  } catch {
    return undefined
  }
}

function ping(host: string, port: number, timeoutMs = 5000): Promise<PingResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    socket.setTimeout(timeoutMs)
    let buffer = Buffer.alloc(0)
    let settled = false

    const finish = (err?: Error, result?: PingResult) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (err) reject(err)
      else resolve(result ?? {})
    }

    socket.on('connect', () => {
      const handshakePayload = Buffer.concat([
        writeVarInt(0x00), // packet id
        writeVarInt(-1), // protocol version（-1 = 探测）
        writeString(host),
        (() => {
          const b = Buffer.alloc(2)
          b.writeUInt16BE(port)
          return b
        })(),
        writeVarInt(1) // next state: status
      ])
      const handshake = Buffer.concat([writeVarInt(handshakePayload.length), handshakePayload])
      const request = Buffer.concat([writeVarInt(1), writeVarInt(0x00)])
      socket.write(Buffer.concat([handshake, request]))
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const lengthField = readVarInt(buffer, 0)
      if (!lengthField) return
      if (buffer.length < lengthField.size + lengthField.value) return

      const payload = buffer.subarray(lengthField.size, lengthField.size + lengthField.value)
      const packetId = readVarInt(payload, 0)
      if (!packetId) return
      const strLen = readVarInt(payload, packetId.size)
      if (!strLen) return
      const jsonBuf = payload.subarray(packetId.size + strLen.size, packetId.size + strLen.size + strLen.value)
      try {
        const data = JSON.parse(jsonBuf.toString('utf-8')) as {
          version?: { name?: string; protocol?: number }
          players?: { online?: number; max?: number; sample?: { name: string }[] }
          description?: unknown
          favicon?: string
        }
        const motd = flattenMotd(data.description)
        finish(undefined, {
          version: data.version?.name,
          protocol: data.version?.protocol,
          players: data.players
            ? {
                online: data.players.online ?? 0,
                max: data.players.max ?? 0,
                sample: data.players.sample?.map((s) => s.name).slice(0, 12)
              }
            : undefined,
          motd,
          favicon: data.favicon
        })
        void started
      } catch (e) {
        finish(new Error('返回数据解析失败'))
      }
    })

    socket.on('timeout', () => finish(new Error('连接超时')))
    socket.on('error', (e) => finish(e))
  })
}

/** MOTD 可能是字符串，也可能是聊天组件树 */
function flattenMotd(desc: unknown): string {
  if (!desc) return ''
  if (typeof desc === 'string') return desc
  if (Array.isArray(desc)) return desc.map(flattenMotd).join('')
  if (typeof desc === 'object') {
    const node = desc as { text?: string; extra?: unknown[]; translate?: string }
    const own = node.text ?? node.translate ?? ''
    const extra = node.extra ? (node.extra as unknown[]).map(flattenMotd).join('') : ''
    return own + extra
  }
  return ''
}

/** 查询服务器状态（含 SRV） */
export async function queryServer(address: string, port?: number): Promise<ServerStatus> {
  const cleaned = address.trim()
  if (!cleaned) return { online: false, error: '地址为空' }

  let host = cleaned
  let targetPort = port ?? 25565
  if (!port && cleaned.includes(':')) {
    const [h, p] = cleaned.split(':')
    host = h
    targetPort = Number(p) || 25565
  }

  const srv = await resolveSrv(host)
  const connectHost = srv?.host ?? host
  const connectPort = port ?? srv?.port ?? targetPort

  const started = Date.now()
  try {
    const result = await ping(connectHost, connectPort)
    const status: ServerStatus = {
      online: true,
      latency: Date.now() - started,
      version: result.version,
      protocol: result.protocol,
      players: result.players,
      motd: result.motd,
      favicon: result.favicon,
      srv
    }
    cacheStatus(cleaned, status)
    return status
  } catch (e) {
    const status: ServerStatus = { online: false, error: (e as Error).message, srv }
    cacheStatus(cleaned, status)
    return status
  }
}

/** 把最近一次查询结果写进 servers.json（MOTD / 图标 / 在线人数下次进页面直接显示） */
function cacheStatus(address: string, status: ServerStatus) {
  const match = listServers().find(
    (s) => `${s.address}${s.port ? ':' + s.port : ''}`.toLowerCase() === address.toLowerCase() || s.address.toLowerCase() === address.toLowerCase()
  )
  if (!match) return
  updateServer(match.id, {
    lastStatus: status,
    lastChecked: Date.now(),
    icon: status.favicon ?? match.icon
  })
}
