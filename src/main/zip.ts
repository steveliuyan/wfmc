import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * 自带的最小 ZIP 读写器（只依赖 node:zlib）。
 *
 * 为什么不用 yauzl / @xmcl/unzip：本机 Node 24 下 yauzl 系列在读取多条目 zip 时
 * 会卡在 openReadStream 的 'end' 上（原生 yauzl 也一样卡），导致 natives 解压、
 * 整合包 overrides 解压直接挂住。这里直接按 ZIP 规范解析中央目录 + inflateRaw，
 * 行为确定、无第三方依赖。
 */

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
  isDirectory: boolean
}

const EOCD_SIG = 0x06054b50
const CEN_SIG = 0x02014b50
const LOC_SIG = 0x04034b50

export function listZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1
  const minPos = Math.max(0, buf.length - 65557)
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip：找不到中央目录结尾')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) break
    if (buf.readUInt32LE(offset) !== CEN_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const size = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compressedSize, size, localOffset, isDirectory: name.endsWith('/') })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const at = entry.localOffset
  if (buf.readUInt32LE(at) !== LOC_SIG) throw new Error(`损坏的 zip 条目: ${entry.name}`)
  const nameLen = buf.readUInt16LE(at + 26)
  const extraLen = buf.readUInt16LE(at + 28)
  const dataStart = at + 30 + nameLen + extraLen
  const raw = buf.slice(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`)
}

export function readZipFromFile(zipPath: string): { buf: Buffer; entries: ZipEntry[] } {
  const buf = fs.readFileSync(zipPath)
  return { buf, entries: listZipEntries(buf) }
}

export function readFileInsideZip(zipPath: string, fileName: string): Buffer | undefined {
  const { buf, entries } = readZipFromFile(zipPath)
  const entry = entries.find((e) => e.name === fileName)
  return entry ? readZipEntry(buf, entry) : undefined
}

/** 把 zip 中匹配前缀的条目解压到目标目录（用于整合包 overrides） */
export async function extractZipPrefixes(
  zipPath: string,
  prefixes: string[],
  destRoot: string
): Promise<number> {
  const { buf, entries } = readZipFromFile(zipPath)
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const matched = prefixes.find((p) => entry.name.startsWith(p))
    if (!matched) continue
    const relative = entry.name.slice(matched.length)
    if (!relative) continue
    const dest = path.join(destRoot, relative)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, readZipEntry(buf, entry))
    count++
  }
  return count
}

// ---------------- 写 zip（备份 / 导出用，store 无压缩，够快够稳） ----------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

export interface ZipWriteItem {
  /** zip 内的相对路径，用 / 分隔 */
  name: string
  data: Buffer
}

/** 收集目录下所有文件（相对路径用 /） */
export function collectDirFiles(root: string, prefix = ''): { name: string; full: string; size: number }[] {
  const out: { name: string; full: string; size: number }[] = []
  const walk = (dir: string, rel: string) => {
    let items: fs.Dirent[]
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      const full = path.join(dir, item.name)
      const name = rel ? `${rel}/${item.name}` : item.name
      if (item.isDirectory()) {
        walk(full, name)
      } else {
        try {
          out.push({ name, full, size: fs.statSync(full).size })
        } catch {
          /* 跳过读不到的文件 */
        }
      }
    }
  }
  if (prefix) walk(root, prefix)
  else walk(root, '')
  return out
}

/** 把若干文件写成 zip（store 模式，无压缩） */
export function writeZip(outputPath: string, files: { name: string; full: string }[]): number {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const fd = fs.openSync(outputPath, 'w')

  const central: Buffer[] = []
  let offset = 0
  let count = 0

  for (const file of files) {
    let data: Buffer
    try {
      data = fs.readFileSync(file.full)
    } catch {
      continue
    }
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    fs.writeSync(fd, local)
    fs.writeSync(fd, nameBuf)
    fs.writeSync(fd, data)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(0, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(data.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + data.length
    count++
  }

  const cenStart = offset
  let cenSize = 0
  for (const buf of central) {
    fs.writeSync(fd, buf)
    cenSize += buf.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(cenSize, 12)
  eocd.writeUInt32LE(cenStart, 16)
  eocd.writeUInt16LE(0, 20)
  fs.writeSync(fd, eocd)
  fs.closeSync(fd)
  return count
}

/** 打包整个目录到 zip */
export function zipDirectory(dir: string, outputPath: string): number {
  const files = collectDirFiles(dir)
  return writeZip(outputPath, files)
}

/**
 * 写 zip 时对每个文件做 deflate（压不动就退回 store）。
 * 存档里大量是 region/mca 和 json 文本，压一下能小不少，恢复时再解回来。
 */
export function writeZipCompressed(
  outputPath: string,
  files: { name: string; full: string }[],
  onEach?: (name: string, index: number, total: number) => void
): number {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const fd = fs.openSync(outputPath, 'w')

  const central: Buffer[] = []
  let offset = 0
  let count = 0
  const total = files.length

  for (const file of files) {
    let raw: Buffer
    try {
      raw = fs.readFileSync(file.full)
    } catch {
      continue
    }
    const crc = crc32(raw)
    let method = 0
    let body = raw
    try {
      const packed = zlib.deflateRawSync(raw, { level: 6 })
      if (packed.length < raw.length) {
        method = 8
        body = packed
      }
    } catch {
      /* 压缩失败就用原文 */
    }

    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOC_SIG, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    fs.writeSync(fd, local)
    fs.writeSync(fd, nameBuf)
    fs.writeSync(fd, body)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(CEN_SIG, 0)
    cen.writeUInt16LE(20, 4)
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(0, 12)
    cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE(0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(cen, nameBuf)

    offset += local.length + nameBuf.length + body.length
    count++
    if (onEach) onEach(file.name, count, total)
  }

  const cenStart = offset
  let cenSize = 0
  for (const buf of central) {
    fs.writeSync(fd, buf)
    cenSize += buf.length
  }

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(count, 8)
  eocd.writeUInt16LE(count, 10)
  eocd.writeUInt32LE(cenSize, 12)
  eocd.writeUInt32LE(cenStart, 16)
  eocd.writeUInt16LE(0, 20)
  fs.writeSync(fd, eocd)
  fs.closeSync(fd)
  return count
}
