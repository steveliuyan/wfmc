/**
 * NBT 读写（E 方向：存档工坊的地基）
 *
 * Minecraft 的 level.dat / *.dat / 区块数据都是 NBT：一棵带类型标签的树，大端序。
 * 这里实现完整读写（1–12 全部标签类型），关键是**字节级往返**：
 * 没改过的字段写回去必须和原文件一模一样，否则我们就是在「顺手改坏别人的存档」。
 *
 * 两个容易踩的点：
 *  1. 字符串是 **Modified UTF-8**（U+0000 编成 C0 80，增补字符按代理对拆成 6 字节），
 *     不是标准 UTF-8 —— 直接用 Buffer.toString('utf8') 会把 emoji 名字读坏。
 *  2. TAG_Compound 的键是有序的，必须原序保留（用数组而不是对象存）。
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

export const TAG = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12
} as const

export type TagType = (typeof TAG)[keyof typeof TAG]

export interface NbtNumber {
  t: 1 | 2 | 3 | 5 | 6
  v: number
}
export interface NbtLong {
  t: 4
  v: bigint
}
export interface NbtByteArray {
  t: 7
  v: number[]
}
export interface NbtString {
  t: 8
  v: string
}
export interface NbtList {
  t: 9
  /** 元素类型（空列表是 0，写回去要原样保留） */
  item: TagType
  v: Tag[]
}
export interface NbtCompound {
  t: 10
  /** 有序键值对 —— 顺序就是字节顺序，别换成普通对象 */
  v: { name: string; tag: Tag }[]
}
export interface NbtIntArray {
  t: 11
  v: number[]
}
export interface NbtLongArray {
  t: 12
  v: bigint[]
}

export type Tag =
  | NbtNumber
  | NbtLong
  | NbtByteArray
  | NbtString
  | NbtList
  | NbtCompound
  | NbtIntArray
  | NbtLongArray

/** 一个 .dat 文件：根总是 TAG_Compound，带一个名字（通常是空串） */
export interface NbtFile {
  name: string
  root: NbtCompound
  /** 原文件用的压缩方式，写回时保持一致 */
  compression: 'gzip' | 'zlib' | 'none'
}

/* ------------------------------ Modified UTF-8 ------------------------------ */

function readMutf8(buf: Buffer, start: number, byteLen: number): string {
  let out = ''
  let i = start
  const end = start + byteLen
  while (i < end) {
    const b = buf[i]
    if (b < 0x80) {
      out += String.fromCharCode(b)
      i += 1
    } else if ((b & 0xe0) === 0xc0) {
      // 两字节：可能表示 U+0000（C0 80）或 BMP 内的字符
      const c = ((b & 0x1f) << 6) | (buf[i + 1] & 0x3f)
      out += String.fromCharCode(c)
      i += 2
    } else if ((b & 0xf0) === 0xe0) {
      const c = ((b & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f)
      out += String.fromCharCode(c)
      i += 3
    } else if ((b & 0xf8) === 0xf0) {
      // 标准 UTF-8 的四字节（Java 不会这么写，但别人生成的文件可能有，读进来别崩）
      const cp = ((b & 0x07) << 18) | ((buf[i + 1] & 0x3f) << 12) | ((buf[i + 2] & 0x3f) << 6) | (buf[i + 3] & 0x3f)
      out += String.fromCodePoint(cp)
      i += 4
    } else {
      out += '\ufffd'
      i += 1
    }
  }
  return out
}

function writeMutf8(str: string): Buffer {
  const bytes: number[] = []
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    if (c === 0) {
      bytes.push(0xc0, 0x80) // NUL 不用 0x00
    } else if (c < 0x80) {
      bytes.push(c)
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      // Java 里增补字符就是两个代理分别三字节编码（CESU-8）
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
      const low = str.charCodeAt(++i)
      bytes.push(0xe0 | (low >> 12), 0x80 | ((low >> 6) & 0x3f), 0x80 | (low & 0x3f))
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return Buffer.from(bytes)
}

/* ---------------------------------- 读 ---------------------------------- */

class Reader {
  constructor(
    private buf: Buffer,
    public pos = 0
  ) {}

  u8(): number {
    return this.buf[this.pos++]
  }
  i8(): number {
    const v = this.buf.readInt8(this.pos)
    this.pos += 1
    return v
  }
  i16(): number {
    const v = this.buf.readInt16BE(this.pos)
    this.pos += 2
    return v
  }
  u16(): number {
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }
  i32(): number {
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }
  i64(): bigint {
    const v = this.buf.readBigInt64BE(this.pos)
    this.pos += 8
    return v
  }
  f32(): number {
    const v = this.buf.readFloatBE(this.pos)
    this.pos += 4
    return v
  }
  f64(): number {
    const v = this.buf.readDoubleBE(this.pos)
    this.pos += 8
    return v
  }
  str(): string {
    const len = this.u16()
    const s = readMutf8(this.buf, this.pos, len)
    this.pos += len
    return s
  }

  payload(type: TagType): Tag {
    switch (type) {
      case TAG.byte:
        return { t: 1, v: this.i8() }
      case TAG.short:
        return { t: 2, v: this.i16() }
      case TAG.int:
        return { t: 3, v: this.i32() }
      case TAG.long:
        return { t: 4, v: this.i64() }
      case TAG.float:
        return { t: 5, v: this.f32() }
      case TAG.double:
        return { t: 6, v: this.f64() }
      case TAG.byteArray: {
        const n = this.i32()
        const v: number[] = new Array(n)
        for (let i = 0; i < n; i++) {
          v[i] = this.buf.readInt8(this.pos)
          this.pos += 1
        }
        return { t: 7, v }
      }
      case TAG.string:
        return { t: 8, v: this.str() }
      case TAG.list: {
        const item = this.u8() as TagType
        const n = this.i32()
        const v: Tag[] = []
        for (let i = 0; i < n; i++) v.push(this.payload(item))
        return { t: 9, item, v }
      }
      case TAG.compound: {
        const v: { name: string; tag: Tag }[] = []
        for (;;) {
          const t = this.u8() as TagType
          if (t === TAG.end) break
          const name = this.str()
          v.push({ name, tag: this.payload(t) })
        }
        return { t: 10, v }
      }
      case TAG.intArray: {
        const n = this.i32()
        const v: number[] = new Array(n)
        for (let i = 0; i < n; i++) {
          v[i] = this.i32()
        }
        return { t: 11, v }
      }
      case TAG.longArray: {
        const n = this.i32()
        const v: bigint[] = new Array(n)
        for (let i = 0; i < n; i++) {
          v[i] = this.i64()
        }
        return { t: 12, v }
      }
      default:
        throw new Error(`不认识的 NBT 标签类型：${type}`)
    }
  }
}

/** 解开压缩（按魔数判断，别信扩展名） */
export function decompress(raw: Buffer): { data: Buffer; compression: 'gzip' | 'zlib' | 'none' } {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return { data: zlib.gunzipSync(raw), compression: 'gzip' }
  }
  if (raw.length >= 2 && raw[0] === 0x78) {
    return { data: zlib.inflateSync(raw), compression: 'zlib' }
  }
  return { data: raw, compression: 'none' }
}

export function compress(data: Buffer, kind: 'gzip' | 'zlib' | 'none'): Buffer {
  if (kind === 'gzip') return zlib.gzipSync(data, { level: 9 })
  if (kind === 'zlib') return zlib.deflateSync(data, { level: 9 })
  return data
}

export function parseNbtBytes(data: Buffer, compression: NbtFile['compression'] = 'none'): NbtFile {
  const r = new Reader(data)
  const type = r.u8() as TagType
  if (type !== TAG.compound) throw new Error(`根标签应该是 compound，实际是 ${type}`)
  const name = r.str()
  const root = r.payload(TAG.compound) as NbtCompound
  return { name, root, compression }
}

/** 读 .dat（自动认压缩） */
export function readNbtFile(file: string): NbtFile {
  const { data, compression } = decompress(fs.readFileSync(file))
  return parseNbtBytes(data, compression)
}

/* ---------------------------------- 写 ---------------------------------- */

function writePayload(out: number[], tag: Tag): void {
  switch (tag.t) {
    case 1: {
      const b = Buffer.alloc(1)
      b.writeInt8(tag.v as number)
      out.push(...b)
      return
    }
    case 2: {
      const b = Buffer.alloc(2)
      b.writeInt16BE(tag.v as number)
      out.push(...b)
      return
    }
    case 3: {
      const b = Buffer.alloc(4)
      b.writeInt32BE(tag.v as number)
      out.push(...b)
      return
    }
    case 4: {
      const b = Buffer.alloc(8)
      b.writeBigInt64BE(tag.v)
      out.push(...b)
      return
    }
    case 5: {
      const b = Buffer.alloc(4)
      b.writeFloatBE(tag.v as number)
      out.push(...b)
      return
    }
    case 6: {
      const b = Buffer.alloc(8)
      b.writeDoubleBE(tag.v as number)
      out.push(...b)
      return
    }
    case 7: {
      const head = Buffer.alloc(4)
      head.writeInt32BE(tag.v.length)
      out.push(...head)
      const body = Buffer.alloc(tag.v.length)
      tag.v.forEach((n, i) => body.writeInt8(n, i))
      out.push(...body)
      return
    }
    case 8: {
      const s = writeMutf8(tag.v)
      const head = Buffer.alloc(2)
      head.writeUInt16BE(Math.min(s.length, 0xffff))
      out.push(...head, ...s)
      return
    }
    case 9: {
      out.push(tag.item)
      const head = Buffer.alloc(4)
      head.writeInt32BE(tag.v.length)
      out.push(...head)
      for (const item of tag.v) writePayload(out, item)
      return
    }
    case 10: {
      for (const entry of tag.v) {
        out.push(entry.tag.t)
        const nameBytes = writeMutf8(entry.name)
        const head = Buffer.alloc(2)
        head.writeUInt16BE(Math.min(nameBytes.length, 0xffff))
        out.push(...head, ...nameBytes)
        writePayload(out, entry.tag)
      }
      out.push(TAG.end)
      return
    }
    case 11: {
      const head = Buffer.alloc(4)
      head.writeInt32BE(tag.v.length)
      out.push(...head)
      for (const n of tag.v) {
        const b = Buffer.alloc(4)
        b.writeInt32BE(n)
        out.push(...b)
      }
      return
    }
    case 12: {
      const head = Buffer.alloc(4)
      head.writeInt32BE(tag.v.length)
      out.push(...head)
      for (const n of tag.v) {
        const b = Buffer.alloc(8)
        b.writeBigInt64BE(n)
        out.push(...b)
      }
      return
    }
    default:
      throw new Error(`不认识的 NBT 标签：${JSON.stringify(tag)}`)
  }
}

export function serializeNbt(file: NbtFile): Buffer {
  const out: number[] = [TAG.compound]
  const nameBytes = writeMutf8(file.name)
  const head = Buffer.alloc(2)
  head.writeUInt16BE(Math.min(nameBytes.length, 0xffff))
  out.push(...head, ...nameBytes)
  writePayload(out, file.root)
  return compress(Buffer.from(out), file.compression)
}

/** 原子写：先写 .tmp 再换名，断电也不会留半个档 */
export function writeNbtFile(file: string, nbt: NbtFile): void {
  const bytes = serializeNbt(nbt)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, bytes)
  fs.renameSync(tmp, file)
}

/* ------------------------------ 路径取/改 ------------------------------ */

type Seg = string | number

/**
 * 'Data.LevelName' / 'Data.Player.Inventory[0].Count' → 段列表
 * 注意：数字下标只对 TAG_List 生效；byte/int/long 数组的下标还取不到（返回 undefined）。
 */
export function parsePath(p: string): Seg[] {
  const out: Seg[] = []
  for (const part of p.split('.')) {
    const m = /^([^[\]]+)((\[\d+\])*)$/.exec(part.trim())
    if (!m) {
      if (part.trim()) out.push(part.trim())
      continue
    }
    out.push(m[1])
    for (const idx of m[2].match(/\d+/g) ?? []) out.push(Number(idx))
  }
  return out
}

export function getPath(root: NbtCompound, p: string): Tag | undefined {
  let cur: Tag = root
  for (const seg of parsePath(p)) {
    if (typeof seg === 'number') {
      if (cur.t !== 9) return undefined
      cur = cur.v[seg]
    } else {
      if (cur.t !== 10) return undefined
      const hit: { name: string; tag: Tag } | undefined = cur.v.find((e) => e.name === seg)
      if (!hit) return undefined
      cur = hit.tag
    }
    if (!cur) return undefined
  }
  return cur
}

/** 定点改：路径上的中间节点必须存在（存档里缺这个字段就别瞎造，返回 false 让上层报错） */
export function setPath(root: NbtCompound, p: string, tag: Tag): boolean {
  const segs = parsePath(p)
  if (!segs.length) return false
  let cur: Tag = root
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    if (typeof seg === 'number') {
      if (cur.t !== 9 || !cur.v[seg]) return false
      cur = cur.v[seg]
    } else {
      if (cur.t !== 10) return false
      const hit: { name: string; tag: Tag } | undefined = cur.v.find((e) => e.name === seg)
      if (!hit) return false
      cur = hit.tag
    }
  }
  const last = segs[segs.length - 1]
  if (typeof last === 'number') {
    if (cur.t !== 9) return false
    cur.v[last] = tag
    return true
  }
  if (cur.t !== 10) return false
  const hit: { name: string; tag: Tag } | undefined = cur.v.find((e) => e.name === last)
  if (!hit) {
    // 只有列表末尾能追加；这里保守：不存在就不动
    return false
  }
  hit.tag = tag
  return true
}

/* ------------------------------ 便于展示 ------------------------------ */

/** 转成好显示的普通值（大数组截断，别把几千个方块塞进 IPC） */
export function toPlain(tag: Tag, depth = 0, maxArray = 32): unknown {
  switch (tag.t) {
    case 4:
      return tag.v.toString()
    case 7:
    case 11:
      return tag.v.length > maxArray ? [...tag.v.slice(0, maxArray), `…共 ${tag.v.length} 项`] : tag.v
    case 12:
      return tag.v.length > maxArray
        ? [...tag.v.slice(0, maxArray).map((n) => n.toString()), `…共 ${tag.v.length} 项`]
        : tag.v.map((n) => n.toString())
    case 8:
      return tag.v
    case 9:
      if (depth > 8) return `[${tag.v.length} 项]`
      return tag.v.map((item) => toPlain(item, depth + 1, maxArray))
    case 10: {
      if (depth > 8) return `{${tag.v.length} 个字段}`
      const obj: Record<string, unknown> = {}
      for (const e of tag.v) obj[e.name] = toPlain(e.tag, depth + 1, maxArray)
      return obj
    }
    default:
      return tag.v
  }
}

export function tagNumber(n: number, t: 1 | 2 | 3 | 4 | 5 | 6 = 3): Tag {
  if (t === 4) return { t: 4, v: BigInt(Math.round(n)) }
  return { t, v: n } as Tag
}

export function tagString(s: string): Tag {
  return { t: 8, v: s }
}

export function tagByte(b: boolean | number): Tag {
  return { t: 1, v: typeof b === 'boolean' ? (b ? 1 : 0) : b }
}

/** 从普通值造标签（只支持 UI 需要的几种：数字/字符串/布尔） */
export function fromPlain(value: unknown, like?: Tag): Tag {
  if (typeof value === 'string') return tagString(value)
  if (typeof value === 'boolean') return tagByte(value)
  if (typeof value === 'number') {
    if (like && (like.t === 1 || like.t === 2 || like.t === 3 || like.t === 5 || like.t === 6)) {
      return tagNumber(value, like.t)
    }
    if (like && like.t === 4) return { t: 4, v: BigInt(Math.round(value)) }
    return tagNumber(value)
  }
  throw new Error('只支持数字 / 字符串 / 布尔')
}

/** 读一个 .dat 并返回它的根（找不到就 undefined） */
export function tryReadNbt(file: string): NbtFile | undefined {
  if (!fs.existsSync(file)) return undefined
  try {
    return readNbtFile(file)
  } catch {
    return undefined
  }
}

/** 目录里所有 .dat 文件（存档工坊用） */
export function listDatFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.dat'))
    .map((n) => path.join(dir, n))
}
