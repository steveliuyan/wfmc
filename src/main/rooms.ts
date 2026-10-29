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

/** 生成房间码。IPv4 会压成 6 字节（4 IP + 2 端口），所以只有 10 位左右 */
export function encodeRoomCode(host: string, port: number): string {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  let payload: Buffer
  if (ipv4) {
    payload = Buffer.alloc(7)
    payload[0] = 4 // 类型：IPv4
    for (let i = 0; i < 4; i++) payload[i + 1] = Number(ipv4[i + 1]) & 0xff
    payload.writeUInt16BE(port, 5)
  } else {
    const hostBuf = Buffer.from(host, 'utf-8')
    payload = Buffer.alloc(1 + 1 + hostBuf.length + 2)
    payload[0] = 2 // 类型：域名
    payload[1] = hostBuf.length
    hostBuf.copy(payload, 2)
    payload.writeUInt16BE(port, 2 + hostBuf.length)
  }
  const code = toBase32(xorBytes(payload))
  return (code.match(/.{1,4}/g) ?? [code]).join('-')
}

/** 解析房间码 → { host, port } */
export function decodeRoomCode(code: string): { host: string; port: number } {
  const raw = xorBytes(fromBase32(code))
  if (raw.length < 3) throw new Error('房间码格式不对')

  const type = raw[0]
  if (type === 4) {
    if (raw.length < 7) throw new Error('房间码长度不对')
    const host = `${raw[1]}.${raw[2]}.${raw[3]}.${raw[4]}`
    return { host, port: raw.readUInt16BE(5) }
  }
  if (type === 2) {
    const len = raw[1]
    const host = raw.subarray(2, 2 + len).toString('utf-8')
    const port = raw.readUInt16BE(2 + len)
    if (!host || !port) throw new Error('房间码内容无效')
    return { host, port }
  }
  // 兼容早期的纯文本格式
  const text = raw.toString('utf-8')
  const match = /^(.+):(\d{1,5})$/.exec(text)
  if (!match) throw new Error('房间码格式不对')
  const port = Number(match[2])
  if (!port || port > 65535) throw new Error('房间码里的端口无效')
  return { host: match[1], port }
}
