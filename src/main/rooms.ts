/**
 * 联机房间码：把「公网地址:端口」编码成 6~10 位短码，好友输码即可直连。
 *
 * 设计取舍：这里做的是**地址分享码**，不做中继配对——码里就是加密后的 host:port，
 * 免服务器、免注册，谁拿到码谁就能连（跟密码一样，泄露就等于把地址给出去了）。
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去掉易混的 I/O/0/1
const KEY = [0x57, 0x46, 0x4d, 0x43, 0x1f, 0x2b, 0x3c, 0x4d] // "WFMC" + salt

function xorBytes(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ KEY[i % KEY.length] ^ (i & 0xff)
  return out
}

/** 5 bit 打包成 base32 */
function toBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-9]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 房间码里附带的环境信息（让好友不用再问「你开的什么版本」） */
export interface RoomEnv {
  mcVersion?: string
  loader?: string
  loaderVersion?: string
}

const LOADER_BYTES = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'paper']

function writeShortStr(bytes: number[], text: string, max = 24) {
  const buf = Buffer.from(text.slice(0, max), 'utf-8')
  bytes.push(buf.length)
  for (const b of buf) bytes.push(b)
}

function readShortStr(raw: Buffer, offset: number): { text: string; next: number } {
  const len = raw[offset] ?? 0
  const text = raw.subarray(offset + 1, offset + 1 + len).toString('utf-8')
  return { text, next: offset + 1 + len }
}

/** 生成房间码。IPv4 压成 7 字节起（类型+4 IP+2 端口），只有 10 位左右；带环境信息会长一些 */
export function encodeRoomCode(host: string, port: number, env?: RoomEnv): string {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  const tail: number[] = []
  if (env && (env.mcVersion || env.loader)) {
    tail.push(0x11) // 环境信息标记
    writeShortStr(tail, env.mcVersion ?? '')
    const idx = LOADER_BYTES.indexOf(env.loader ?? '')
    tail.push(idx < 0 ? 0xff : idx)
    writeShortStr(tail, env.loaderVersion ?? '')
  }
  let payload: Buffer
  if (ipv4) {
    payload = Buffer.alloc(7 + tail.length)
    payload[0] = 4 // 类型：IPv4
    for (let i = 0; i < 4; i++) payload[i + 1] = Number(ipv4[i + 1]) & 0xff
    payload.writeUInt16BE(port, 5)
    if (tail.length) payload.set(tail, 7)
  } else {
    const hostBuf = Buffer.from(host, 'utf-8')
    payload = Buffer.alloc(1 + 1 + hostBuf.length + 2 + tail.length)
    payload[0] = 2 // 类型：域名
    payload[1] = hostBuf.length
    hostBuf.copy(payload, 2)
    payload.writeUInt16BE(port, 2 + hostBuf.length)
    if (tail.length) payload.set(tail, 4 + hostBuf.length)
  }
  const code = toBase32(xorBytes(payload))
  return (code.match(/.{1,4}/g) ?? [code]).join('-')
}

/** 解析房间码 → { host, port, env? }（旧码没有 env） */
export function decodeRoomCode(code: string): { host: string; port: number; env?: RoomEnv } {
  const raw = xorBytes(fromBase32(code))
  if (raw.length < 3) throw new Error('房间码格式不对')

  const parseEnv = (offset: number): RoomEnv | undefined => {
    if (raw.length <= offset || raw[offset] !== 0x11) return undefined
    try {
      const mc = readShortStr(raw, offset + 1)
      const loaderByte = raw[mc.next] ?? 0xff
      const lv = readShortStr(raw, mc.next + 1)
      const env: RoomEnv = {}
      if (mc.text) env.mcVersion = mc.text
      if (loaderByte !== 0xff && LOADER_BYTES[loaderByte]) env.loader = LOADER_BYTES[loaderByte]
      if (lv.text) env.loaderVersion = lv.text
      return env
    } catch {
      return undefined
    }
  }

  const type = raw[0]
  if (type === 4) {
    if (raw.length < 7) throw new Error('房间码长度不对')
    const host = `${raw[1]}.${raw[2]}.${raw[3]}.${raw[4]}`
    return { host, port: raw.readUInt16BE(5), env: parseEnv(7) }
  }
  if (type === 2) {
    const len = raw[1]
    const host = raw.subarray(2, 2 + len).toString('utf-8')
    const port = raw.readUInt16BE(2 + len)
    if (!host || !port) throw new Error('房间码内容无效')
    return { host, port, env: parseEnv(4 + len) }
  }
  // 兼容早期的纯文本格式
  const text = raw.toString('utf-8')
  const match = /^(.+):(\d{1,5})$/.exec(text)
  if (!match) throw new Error('房间码格式不对')
  const port = Number(match[2])
  if (!port || port > 65535) throw new Error('房间码里的端口无效')
  return { host: match[1], port }
}
