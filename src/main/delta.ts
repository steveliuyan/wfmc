/**
 * 增量更新用的二进制差分（rsync 那套：旧文件切固定块建索引，新文件用滚动弱哈希扫一遍）。
 *
 * 为什么不用 bsdiff：bsdiff 的复杂度吃后缀数组，M 级文件就要几十秒 + 大量内存，
 * 而我们的两个更新目标（安装包 .exe / app.asar）本来就是"大部分字节不变"，
 * 块级复制 + 逐字节延伸已经能压到 3%~8%，构建期跑一次也够快。零外部依赖是个额外好处。
 *
 * 文件格式（.wdelta）：
 *   magic "WFMCD1" (6B) | u32 headerLen | header JSON (utf8) | gzip(op 流)
 *   op 流：0x01 u32 len bytes…（插入字面量） / 0x02 u32 offset u32 len（从旧文件复制）
 * apply 前后都校验大小与 sha256，任何不符就抛错，由调用方回落到整包更新。
 */
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface DeltaInfo {
  format: number
  /** 生成补丁时旧文件的字节数 */
  fromSize: number
  /** 新文件应有的字节数 */
  toSize: number
  /** 新文件 sha256（hex，小写） */
  toSha256: string
  /** 旧文件 sha256（hex，小写） */
  fromSha256: string
  blockSize: number
}

const MAGIC = Buffer.from('WFMCD1', 'ascii')
const DEFAULT_BLOCK = 2048
const MOD = 65521
const OP_INSERT = 1
const OP_COPY = 2

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** 弱哈希：a = Σx，b = Σ(B−k)·x（滚动时只要 O(1) 就能更新），拼成一个整数当 Map key */
function weakInit(buf: Buffer, off: number, len: number): { a: number; b: number } {
  let a = 0
  let b = 0
  for (let k = 0; k < len; k++) {
    a += buf[off + k]
    b += a
  }
  return { a: a % MOD, b: b % MOD }
}

function opInsert(data: Buffer): Buffer {
  const head = Buffer.allocUnsafe(5)
  head[0] = OP_INSERT
  head.writeUInt32LE(data.length, 1)
  return Buffer.concat([head, data])
}

function opCopy(offset: number, len: number): Buffer {
  const head = Buffer.allocUnsafe(9)
  head[0] = OP_COPY
  head.writeUInt32LE(offset, 1)
  head.writeUInt32LE(len, 5)
  return head
}

/** 生成补丁：from = 客户端手上的旧文件，to = 新的目标文件 */
export function makeDelta(from: Buffer, to: Buffer, blockSize = DEFAULT_BLOCK): Buffer {
  const info: DeltaInfo = {
    format: 1,
    fromSize: from.length,
    toSize: to.length,
    toSha256: sha256(to),
    fromSha256: sha256(from),
    blockSize
  }

  if (to.length === 0) return pack(info, [])
  // 旧文件太小时没有可复制的块，整份当字面量
  if (from.length < blockSize) return pack(info, [opInsert(to)])

  // 1) 旧文件按固定块建弱哈希索引（rsync 的做法：只有旧文件按边界切，新文件任意偏移都能命中）
  const index = new Map<number, number[]>()
  for (let off = 0; off + blockSize <= from.length; off += blockSize) {
    const { a, b } = weakInit(from, off, blockSize)
    const key = a * MOD + b
    const list = index.get(key)
    if (list) list.push(off)
    else index.set(key, [off])
  }

  const ops: Buffer[] = []
  let insertStart = 0
  let i = 0
  // 2) 滚动窗口扫新文件
  if (to.length >= blockSize) {
    let { a, b } = weakInit(to, 0, blockSize)
    while (i + blockSize <= to.length) {
      const hit = index.get(a * MOD + b)
      let matched = -1
      if (hit) {
        // 弱哈希会撞，逐个用真实字节确认
        for (const off of hit) {
          // Buffer.compare 的参数是 (target, targetStart, targetEnd, sourceStart, sourceEnd)：
          // 目标区间在新文件窗口 i..i+B，源区间在旧文件块 off..off+B
          if (from.compare(to, i, i + blockSize, off, off + blockSize) === 0) {
            matched = off
            break
          }
        }
      }
      if (matched >= 0) {
        if (i > insertStart) ops.push(opInsert(to.subarray(insertStart, i)))
        // 命中后往前延伸：连续相同的一整段都算一次复制，op 数少一半以上
        let len = blockSize
        while (
          i + len < to.length &&
          matched + len < from.length &&
          from[matched + len] === to[i + len]
        ) {
          len++
        }
        ops.push(opCopy(matched, len))
        i += len
        insertStart = i
        if (i + blockSize <= to.length) ({ a, b } = weakInit(to, i, blockSize))
        continue
      }
      // 没命中就往前滚一格
      const out = to[i]
      const inn = to[i + blockSize]
      a = (a - out + inn) % MOD
      if (a < 0) a += MOD
      b = (b - blockSize * out + a) % MOD
      if (b < 0) b += MOD
      i++
    }
  }
  if (insertStart < to.length) ops.push(opInsert(to.subarray(insertStart)))

  return pack(info, ops)
}

function pack(info: DeltaInfo, ops: Buffer[]): Buffer {
  const headerBuf = Buffer.from(JSON.stringify(info), 'utf8')
  const size = Buffer.allocUnsafe(4)
  size.writeUInt32LE(headerBuf.length, 0)
  const body = ops.length ? gzipSync(Buffer.concat(ops), { level: 9 }) : gzipSync(Buffer.alloc(0), { level: 9 })
  return Buffer.concat([MAGIC, size, headerBuf, body])
}

function parseDelta(delta: Buffer): { info: DeltaInfo; bodyOffset: number } {
  if (delta.length < 10 || delta.compare(MAGIC, 0, 6, 0, 6) !== 0) {
    throw new Error('不是有效的增量补丁文件')
  }
  const headerLen = delta.readUInt32LE(6)
  if (headerLen <= 0 || 10 + headerLen > delta.length) throw new Error('增量补丁头部损坏')
  const info = JSON.parse(delta.subarray(10, 10 + headerLen).toString('utf8')) as DeltaInfo
  return { info, bodyOffset: 10 + headerLen }
}

/** 只读头部，不解压 op 流（下载完先看一遍补丁对不对得上当前版本） */
export function readDeltaHeader(delta: Buffer): DeltaInfo {
  return parseDelta(delta).info
}

/** 应用补丁；旧文件对不上（版本不对/文件被改过）直接抛错，不会产出半成品 */
export function applyDelta(from: Buffer, delta: Buffer): Buffer {
  const { info, bodyOffset } = parseDelta(delta)
  if (info.fromSize !== from.length) {
    throw new Error(`增量补丁与当前文件不匹配（大小 ${from.length} ≠ ${info.fromSize}）`)
  }
  if (info.fromSha256 && sha256(from) !== info.fromSha256) {
    throw new Error('增量补丁与当前文件不匹配（校验和不一致）')
  }
  const ops = gunzipSync(delta.subarray(bodyOffset))
  const out = Buffer.allocUnsafe(info.toSize)
  let src = 0
  let dst = 0
  while (src < ops.length) {
    const type = ops[src]
    if (type === OP_INSERT) {
      const len = ops.readUInt32LE(src + 1)
      src += 5
      if (dst + len > info.toSize) throw new Error('增量补丁数据越界')
      ops.copy(out, dst, src, src + len)
      src += len
      dst += len
    } else if (type === OP_COPY) {
      const off = ops.readUInt32LE(src + 1)
      const len = ops.readUInt32LE(src + 5)
      src += 9
      if (off + len > from.length || dst + len > info.toSize) throw new Error('增量补丁数据越界')
      from.copy(out, dst, off, off + len)
      dst += len
    } else {
      throw new Error(`增量补丁包含未知操作 0x${type.toString(16)}`)
    }
  }
  if (dst !== info.toSize) throw new Error(`增量补丁产出大小不符（${dst} ≠ ${info.toSize}）`)
  if (sha256(out) !== info.toSha256) throw new Error('增量补丁产出校验和不符')
  return out
}
