import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { listZipEntries, readZipEntry } from './zip'
import { store } from './store'
import { gamePathFor } from './paths'
import { DiskCache } from './metacache'

export type ModLoaderKind = 'fabric' | 'forge' | 'neoforge' | 'quilt'

/**
 * 元数据解析规则的版本号，参与缓存 key。
 * 解析逻辑一改（比如开始认 Forge 的 jar-in-jar）就要 +1，否则用户本机缓存里那份旧结论会一直生效 —— 修好的误报还会继续报。
 */
const META_PARSER_VERSION = 'v2'

export interface ModIssue {
  level: 'error' | 'warn' | 'info'
  title: string
  detail: string
  /** 「这是什么」：这条问题是什么意思、会有什么症状、能不能不管（新手用） */
  explain?: string
  files?: string[]
  /** 这条问题的「一键修复」= 给实例装这个加载器（模组要它，而实例装的不是它） */
  fixLoader?: 'fabric' | 'forge' | 'neoforge' | 'quilt'
  /** 这条问题的「一键修复」= 去 Modrinth 把这个前置模组装上 */
  fixDep?: string
  /** 前置要求的版本范围（展示用，例如 >=1.0.0） */
  depRange?: string
  /** 这条问题的「一键修复」= 把 mods 里这几个 .disabled 文件改回 .jar（前置装了但被禁用了） */
  enableFiles?: string[]
}

export interface ModMeta {
  file: string
  path: string
  id?: string
  name?: string
  version?: string
  loader?: 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'unknown'
  /** jar 里**所有**能找到的加载器元数据（通用包同时带 fabric.mod.json + mods.toml） */
  loaders?: ModLoaderKind[]
  depends?: string[]
  /** 声明「和谁不兼容」（fabric.mod.json 的 breaks / mods.toml 的 incompatible） */
  breaks?: string[]
  /** 依赖 id → 版本要求（Fabric 的 >=1.0.0、Forge 的 [1.0,) 都在这里） */
  depRanges?: Record<string, string>
  /**
   * 同一个 jar 同时带 fabric.mod.json 和 mods.toml（通用包）时，Forge 那侧的依赖。
   * 在 Forge 实例里必须用这套 —— 拿 Fabric 那套会报出「缺 Fabric API」这种
   * 永远不会被加载的假前置。
   */
  forgeDepends?: string[]
  forgeDepRanges?: Record<string, string>
  /** fabric.mod.json 的 provides：这个 jar 额外「顶替」了哪些 modId（如 cloth-config 提供 cloth-config2） */
  provides?: string[]
  /** 塞在 META-INF/jars 里的嵌套 mod（Fabric 的 Jar-in-Jar，如 fabric-api 内嵌 50 多个模块） */
  bundled?: BundledMod[]
  /** 文件名带 .disabled：装了但被禁用，游戏不会加载它 */
  disabled?: boolean
}

/** 一个 jar 内部嵌着的 mod（不单独占 mods 目录里的文件，但确实提供 modId） */
interface BundledMod {
  id: string
  version?: string
  provides: string[]
}

/** 提供某个 modId 的「来源」：可能是文件自己的 id，也可能是它的 provides / 内嵌 jar */
interface ModProvider {
  mod: ModMeta
  version?: string
}

/** 不算「要装的前置」的那些 id：游戏本体、Java、加载器自己 */
export const NOT_A_MOD = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'fabric_loader',
  'forge',
  'neoforge',
  'quilt_loader',
  'quilted_fabric_loader',
  'quilt-loader'
])

/**
 * 版本号比较：只比数字主干，`1.2.3-beta`、`1.2.3+build.5` 都当 1.2.3。
 * 后缀（-264 / +1.20.1 / build.1744）在模组圈里只是打包号，拿来比较会成片误报：
 * 例如 flywheel 要 `>=1.0.5-264`，实际装的是 `1.0.5+1.20.1.build.264`，
 * 按字面数字比会把「264」当成第 4 段主版本号，直接比成 1 < 264 判成版本对不上。
 */
function cmpVersion(a: string, b: string): number {
  const seg = (v: string) =>
    v
      .split('+')[0]
      .split('-')[0]
      .split(/[._ ]/)
      .map((x) => Number.parseInt(x.replace(/[^\d]/g, ''), 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const x = seg(a)
  const y = seg(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  // 主干一样时再看 dash 后面那截：有些 mod 把整套版本号塞在 dash 里，
  // 比如 lightmanscurrency 装的是 `1.20.1-2.3.0.5`，要求 [1.20.1-2.3.0.4,1.20.1-2.4.0.0)。
  // 只比主干就会当成「都是 1.20.1」，上界判成越界 → 天天假警告。
  // 只有两边都有 dash 尾巴才比；一边没有（`>=1.0.5-264` 对 `1.0.5+1.20.1.build.264`）当相等。
  const tail = (v: string) => {
    const main = v.split('+')[0]
    const i = main.indexOf('-')
    return i < 0
      ? []
      : main
          .slice(i + 1)
          .split(/[._ -]+/)
          .filter(Boolean)
          .map((s) => {
            const n = Number.parseInt(s.replace(/[^\d]/g, ''), 10)
            return Number.isFinite(n) ? n : 0
          })
  }
  const ta = tail(a)
  const tb = tail(b)
  if (ta.length === 0 || tb.length === 0) return 0
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const d = (ta[i] ?? 0) - (tb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/**
 * 判断已装版本满不满足前置要求。
 * 支持 Fabric 的 `>=1.0.0`、`>=1.0.0 <2.0.0`、`~1.2`、`^1.2`、`1.2.x`、`*`，
 * 也支持 Forge / Maven 的 `[1.0,2.0)`、`[1.0,)`。看不懂的要求一律当满足（别乱报警）。
 */
export function satisfiesRange(version: string | undefined, range?: string): boolean {
  if (!range) return true
  const r = range.trim()
  if (!r || r === '*' || r === 'x' || r === 'any') return true
  if (!version) return false
  // Maven 区间写法：[1.0,2.0) (1.0,) [1.0]
  if (/^[[(]/.test(r)) {
    const m = /^([[（(])\s*([^,\])]*)\s*,\s*([^)\]）]*)\s*([)\]）)])$/.exec(r)
    if (!m) return true
    const lo = m[2].trim()
    const hi = m[3].trim()
    if (lo) {
      const c = cmpVersion(version, lo)
      if (c < 0 || (c === 0 && m[1] === '(')) return false
    }
    if (hi) {
      const c = cmpVersion(version, hi)
      if (c > 0 || (c === 0 && m[4] !== ']' && m[4] !== '）')) return false
    }
    return true
  }
  // 空格或逗号分隔的多个条件
  const parts = r.split(/[\s,]+/).filter(Boolean)
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(p)
    if (!m) return true
    const op = m[1] ?? ''
    let want = m[2].trim()
    if (!want || want === '*' || want === 'x') continue
    // 1.2.x / 1.2.* → 前缀匹配
    if (/[xX*]/.test(want)) {
      const prefix = want.split(/[xX*]/)[0].replace(/\.$/, '')
      if (!version.startsWith(prefix) && cmpVersion(version, prefix) < 0) return false
      continue
    }
    want = want.replace(/^v/, '')
    const c = cmpVersion(version, want)
    if (op === '>=' && c < 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '=' && c !== 0) return false
    if (op === '~') {
      // ~1.2.3 → >=1.2.3 <1.3.0
      const head = want.split('.').slice(0, 2).join('.')
      if (c < 0 || !version.startsWith(head)) return false
    }
    if (op === '^') {
      // ^1.2.3 → >=1.2.3 <2.0.0
      const major = Number.parseInt(want.split('.')[0] ?? '0', 10) || 0
      if (c < 0 || Number.parseInt(version.split('.')[0] ?? '0', 10) !== major) return false
    }
  }
  return true
}

function readText(zipBuf: Buffer, entries: ReturnType<typeof listZipEntries>, name: string): string | undefined {
  const entry = entries.find((e) => e.name === name)
  if (!entry) return undefined
  try {
    return readZipEntry(zipBuf, entry).toString('utf-8')
  } catch {
    return undefined
  }
}

/**
 * Forge 的 mods.toml 里版本常写成 `${file.jarVersion}` —— 加载器运行时才把它换成
 * jar 的 MANIFEST 版本号。原样读出来就会显示成 `${file.jarVersion}`，
 * 更麻烦的是拿它去比版本区间必然「对不上」，一个包能刷出十几条假警告。
 */
const VERSION_PLACEHOLDER = /\$\{[^}]*\}|@[A-Za-z0-9_.-]+@/g

const hasPlaceholder = (v: string): boolean => /\$\{[^}]*\}|@[A-Za-z0-9_.-]+@/.test(v)

/** MANIFEST 里的 Implementation-Version（长行会折行，续行以空格开头） */
function manifestVersion(zipBuf: Buffer, entries: ReturnType<typeof listZipEntries>): string | undefined {
  const mf = readText(zipBuf, entries, 'META-INF/MANIFEST.MF')
  if (!mf) return undefined
  const unfolded = mf.replace(/\r?\n /g, '')
  const m = /^Implementation-Version:\s*(.+)$/im.exec(unfolded)
  const v = m?.[1].trim()
  return v && !hasPlaceholder(v) ? v : undefined
}

/** 兜底：从文件名里扣版本号（iceberg-1.1.20.jar → 1.1.20） */
function versionFromFileName(file: string): string | undefined {
  const base = path.basename(file).replace(/\.(jar|zip)(\.disabled)?$/i, '')
  const m = /[-_](?:v)?(\d+(?:\.\d+)+(?:[-+][A-Za-z0-9._-]+)?)$/.exec(base)
  return m?.[1]
}

/** 把占位符换成真版本：占位符 → MANIFEST 版本 → 文件名里的数字；都拿不到就不猜 */
function resolveVersion(raw: string | undefined, file: string, fromManifest?: string): string | undefined {
  let v = raw?.trim()
  if (v && hasPlaceholder(v)) {
    v = v
      .replace(/\$\{file\.jarVersion\}/gi, fromManifest ?? '')
      .replace(/@version@/gi, fromManifest ?? '')
      .replace(VERSION_PLACEHOLDER, '')
      .trim()
  }
  if (!v) v = fromManifest
  if (!v) v = versionFromFileName(file)
  return v && !hasPlaceholder(v) ? v : undefined
}

/**
 * 扫 fabric.mod.json 里 `jars` 声明的嵌套 mod（Jar-in-Jar），递归 2 层。
 * fabric-api 一个文件里就塞了 50 多个模块（fabric-resource-loader-v0 之类），
 * bclib 塞了 wunderlib —— 不认这些就会把「前置明明在」当成「缺前置」。
 */
function collectNestedJars(
  buf: Buffer,
  entries: ReturnType<typeof listZipEntries>,
  depth: number,
  out: BundledMod[]
): void {
  if (depth > 2) return
  const raw = readText(buf, entries, 'fabric.mod.json')
  if (!raw) return
  let json: { jars?: (string | { file?: string })[] }
  try {
    json = JSON.parse(raw)
  } catch {
    return
  }
  const jars = Array.isArray(json.jars) ? json.jars : []
  // 少数打包工具会把条目写成 META-INF\jars\xxx.jar（反斜杠），按 zip 规范比名字前先统一
  const norm = (s: string) => s.replace(/\\/g, '/')
  for (const item of jars) {
    const file = typeof item === 'string' ? item : item?.file
    if (!file) continue
    const entry = entries.find((e) => norm(e.name) === norm(file))
    if (!entry) continue
    let nested: Buffer
    try {
      nested = readZipEntry(buf, entry)
    } catch {
      continue
    }
    let nestedEntries: ReturnType<typeof listZipEntries>
    try {
      nestedEntries = listZipEntries(nested)
    } catch {
      continue
    }
    const nestedRaw = readText(nested, nestedEntries, 'fabric.mod.json')
    if (!nestedRaw) continue
    let nj: { id?: string; version?: unknown; provides?: unknown }
    try {
      nj = JSON.parse(nestedRaw)
    } catch {
      continue
    }
    if (nj.id) {
      out.push({
        id: String(nj.id),
        version: nj.version != null ? String(nj.version) : undefined,
        provides: Array.isArray(nj.provides) ? nj.provides.map((x) => String(x)).filter(Boolean) : []
      })
    }
    collectNestedJars(nested, nestedEntries, depth + 1, out)
  }
}

/** 大小写不敏感地读一个 zip 条目（有的包把 mods.toml 写成 META-INF/Mods.toml） */
function readTextCI(
  zipBuf: Buffer,
  entries: ReturnType<typeof listZipEntries>,
  name: string
): string | undefined {
  const want = name.toLowerCase()
  const entry = entries.find((e) => e.name.toLowerCase() === want)
  if (!entry) return undefined
  try {
    return readZipEntry(zipBuf, entry).toString('utf-8')
  } catch {
    return undefined
  }
}

/**
 * 只读 Forge 那一侧的元数据（mods.toml / neoforge.mods.toml）：
 * 通用包（Terralith、Towns-and-Towers、DramaticDoors-QuiFabrge 这类同时带
 * fabric.mod.json 的 jar）在 Forge 实例里真正生效的是这一套依赖。
 */
function parseForgeSide(
  buf: Buffer,
  entries: ReturnType<typeof listZipEntries>
): { id?: string; version?: string; ranges: Record<string, string> } | undefined {
  const raw =
    readTextCI(buf, entries, 'META-INF/mods.toml') ?? readTextCI(buf, entries, 'META-INF/neoforge.mods.toml')
  if (!raw) return undefined
  const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(raw)?.[1]
  const version = /^\s*version\s*=\s*["']([^"']*)["']/m.exec(raw)?.[1]
  const ranges: Record<string, string> = {}
  const heads: { start: number; end: number }[] = []
  const secRe = /^\s*\[\[dependencies\.[^\]]+\]\]/gm
  let mm: RegExpExecArray | null
  while ((mm = secRe.exec(raw))) heads.push({ start: mm.index + mm[0].length, end: raw.length })
  for (let i = 0; i < heads.length; i++) {
    if (i + 1 < heads.length) heads[i].end = raw.lastIndexOf('[[dependencies.', heads[i + 1].start)
    const body = raw.slice(heads[i].start, heads[i].end)
    const depId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(body)?.[1]
    if (!depId || NOT_A_MOD.has(depId.toLowerCase())) continue
    const mandatory = /^\s*mandatory\s*=\s*["']?(\w+)["']?/m.exec(body)?.[1]
    const type = /^\s*type\s*=\s*["']([^"']+)["']/m.exec(body)?.[1]
    if (mandatory === 'false') continue
    if (type === 'optional' || type === 'incompatible' || type === 'discouraged') continue
    if (id && depId === id) continue
    ranges[depId] = (/^\s*versionRange\s*=\s*["']([^"']*)["']/m.exec(body)?.[1] ?? '')
      .replace(VERSION_PLACEHOLDER, '')
      .trim()
  }
  return { id, version, ranges }
}

/**
 * Forge / NeoForge 的 Jar-in-Jar（META-INF/jarjar/metadata.json + 里面的 .jar）：
 * Create 6 自带 flywheel + ponder、fruitsdelight 自带 l2lib / l2harvester、
 * Xaero 自带 xaerolib、PuzzlesLib 自带 puzzlesaccessapi、kotlinforforge-all 自带
 * kffmod/kfflib —— 这些前置**本来就在 jar 里**，不认就会全报成「缺前置」。
 */
function collectForgeJarJars(
  buf: Buffer,
  entries: ReturnType<typeof listZipEntries>,
  out: BundledMod[],
  depth: number
): void {
  if (depth > 2) return
  const norm = (s: string) => s.replace(/\\/g, '/')
  const paths = new Set<string>()
  const metaRaw =
    readTextCI(buf, entries, 'META-INF/jarjar/metadata.json') ?? readTextCI(buf, entries, 'META-INF/jars/metadata.json')
  if (metaRaw) {
    try {
      const json = JSON.parse(metaRaw) as { jars?: { path?: string }[] }
      for (const it of json.jars ?? []) if (it?.path) paths.add(norm(it.path))
    } catch {
      /* 坏 metadata 就只靠目录扫描 */
    }
  }
  for (const e of entries) {
    const n = norm(e.name)
    if (/^META-INF\/(jarjar|jars)\/[^/]+\.jar$/i.test(n)) paths.add(n)
  }
  for (const p of paths) {
    const entry = entries.find((e) => norm(e.name) === p)
    if (!entry) continue
    let nested: Buffer
    try {
      nested = readZipEntry(buf, entry)
    } catch {
      continue
    }
    let nestedEntries: ReturnType<typeof listZipEntries>
    try {
      nestedEntries = listZipEntries(nested)
    } catch {
      continue
    }
    const forge = parseForgeSide(nested, nestedEntries)
    if (forge?.id) {
      out.push({ id: forge.id, version: forge.version, provides: [] })
    } else {
      const fab = readTextCI(nested, nestedEntries, 'fabric.mod.json')
      if (fab) {
        try {
          const nj = JSON.parse(fab) as { id?: string; version?: unknown; provides?: unknown }
          if (nj.id) {
            out.push({
              id: String(nj.id),
              version: nj.version != null ? String(nj.version) : undefined,
              provides: Array.isArray(nj.provides) ? nj.provides.map((x) => String(x)).filter(Boolean) : []
            })
          }
        } catch {
          /* 跳过 */
        }
      }
    }
    collectForgeJarJars(nested, nestedEntries, out, depth + 1)
  }
}

/**
 * 解析结果缓存：key = 路径 + 修改时间 + 大小。
 * 体检要常驻后台跑（mods 一变就重扫），300+ 个 jar 每次都全量读太浪费。
 */
const JAR_CACHE = new Map<string, { key: string; meta: ModMeta }>()

/**
 * 落盘缓存（data/cache/moddoctor-meta.json）：重启之后第一次体检也不用把 400 个 jar 全拆一遍。
 * key = 路径|修改时间|大小，jar 一动就自动失效。
 */
let jarMetaDisk: DiskCache<ModMeta> | undefined
function metaDisk(): DiskCache<ModMeta> {
  if (!jarMetaDisk) {
    jarMetaDisk = new DiskCache<ModMeta>(path.join(store.dataDir, 'cache', 'moddoctor-meta.json'))
  }
  return jarMetaDisk
}

/** 已经被解析过的就直接用（内存 → 磁盘 → 现拆），返回 undefined 表示得现拆 */
function cachedMeta(file: string, cacheKey: string): ModMeta | undefined {
  const hit = JAR_CACHE.get(file)
  if (hit && hit.key === cacheKey) return { ...hit.meta }
  const fromDisk = metaDisk().get(`${file}|${cacheKey}`)
  if (fromDisk) {
    rememberMeta(file, cacheKey, fromDisk)
    return { ...fromDisk }
  }
  return undefined
}

function rememberMeta(file: string, cacheKey: string, meta: ModMeta): void {
  if (JAR_CACHE.size > 1200) JAR_CACHE.clear()
  JAR_CACHE.set(file, { key: cacheKey, meta })
  metaDisk().set(`${file}|${cacheKey}`, meta)
}

function parseModJar(file: string): ModMeta {
  let st: fs.Stats
  try {
    st = fs.statSync(file)
  } catch {
    return { file: path.basename(file), path: file, loader: 'unknown' }
  }
  const key = `${META_PARSER_VERSION}:${st.mtimeMs}:${st.size}`
  const cached = cachedMeta(file, key)
  if (cached) return cached
  const meta = parseModJarRaw(file)
  rememberMeta(file, key, meta)
  return { ...meta }
}

/** 异步版：读文件不阻塞主进程，体检几百个 jar 时界面不会僵 */
async function parseModJarAsync(file: string): Promise<ModMeta> {
  let st: fs.Stats
  try {
    st = await fs.promises.stat(file)
  } catch {
    return { file: path.basename(file), path: file, loader: 'unknown' }
  }
  const key = `${META_PARSER_VERSION}:${st.mtimeMs}:${st.size}`
  const cached = cachedMeta(file, key)
  if (cached) return cached
  let buf: Buffer
  try {
    buf = await fs.promises.readFile(file)
  } catch {
    return { file: path.basename(file), path: file, loader: 'unknown' }
  }
  const meta = parseModJarBuffer(buf, file)
  rememberMeta(file, key, meta)
  return { ...meta }
}

/** 把元数据缓存写盘（退出前调一次，别等 1.5s 的定时器） */
export function flushModMetaCache(): void {
  jarMetaDisk?.flush()
}

/** 从 jar 里读 mod 元数据（Fabric 的 fabric.mod.json / Forge 的 mods.toml） */
function parseModJarRaw(file: string): ModMeta {
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch {
    return { file: path.basename(file), path: file, loader: 'unknown' }
  }
  return parseModJarBuffer(buf, file)
}

/** 同一套解析，入口是内存里的字节（异步扫描时用 fs.promises 读进来再走这里） */
function parseModJarBuffer(buf: Buffer, file: string): ModMeta {
  const meta: ModMeta = { file: path.basename(file), path: file, loader: 'unknown' }
  let entries: ReturnType<typeof listZipEntries>
  try {
    entries = listZipEntries(buf)
  } catch {
    return meta
  }
  // 一个 jar 里可能同时有好几套元数据：不少「通用包」既带 fabric.mod.json 又带 META-INF/mods.toml。
  // 只看解析到的第一个，会把这类包统一判成「只给 fabric 用」，在 Forge 实例里成片误报「加载器不匹配」。
  const has = (n: string) => entries.some((e) => e.name === n)
  const loaders: ModLoaderKind[] = []
  if (has('fabric.mod.json')) loaders.push('fabric')
  if (has('quilt.mod.json')) loaders.push('quilt')
  if (has('META-INF/neoforge.mods.toml')) loaders.push('neoforge')
  if (has('META-INF/mods.toml')) loaders.push('forge')
  if (loaders.length === 0 && has('mcmod.info')) loaders.push('forge')
  if (loaders.length > 0) meta.loaders = loaders
  // 版本占位符要用 MANIFEST 里的真版本号补上（下面各分支都用）
  const mfVersion = manifestVersion(buf, entries)
  // Forge 的 jar-in-jar（Create 的 flywheel/ponder、Xaero 的 xaerolib…）统一在这里收
  const jarJarBundled: BundledMod[] = []
  collectForgeJarJars(buf, entries, jarJarBundled, 1)
  if (jarJarBundled.length > 0) meta.bundled = jarJarBundled

  const fabric = readText(buf, entries, 'fabric.mod.json')
  if (fabric) {
    try {
      const json = JSON.parse(fabric) as {
        id?: string
        name?: string
        version?: string
        depends?: Record<string, string | string[]>
        breaks?: Record<string, string | string[]>
        provides?: unknown
        jars?: unknown
      }
      meta.loader = 'fabric'
      meta.id = json.id
      meta.name = json.name ?? json.id
      meta.version = resolveVersion(
        typeof json.version === 'string' ? json.version : json.version ? String(json.version) : undefined,
        file,
        mfVersion
      )
      meta.provides = Array.isArray(json.provides) ? json.provides.map((x) => String(x)).filter(Boolean) : []
      const bundled: BundledMod[] = []
      collectNestedJars(buf, entries, 1, bundled)
      meta.bundled = [...jarJarBundled, ...bundled]
      // 通用包（fabric + forge 双元数据）：在 Forge 实例里真正生效的是 mods.toml 那套依赖，
      // 存一份给 analyzeMods 按实例加载器挑
      if (loaders.includes('forge') || loaders.includes('neoforge')) {
        const forgeSide = parseForgeSide(buf, entries)
        if (forgeSide) {
          // 即使 Forge 侧压根没声明依赖，也要留个『空集』：通用包的 Fabric 侧依赖在 Forge 实例里不会被加载，不能拿来报警
          meta.forgeDepRanges = forgeSide.ranges
          meta.forgeDepends = Object.keys(forgeSide.ranges)
        }
      }
      const ranges: Record<string, string> = {}
      for (const [k, v] of Object.entries(json.depends ?? {})) {
        if (NOT_A_MOD.has(k.toLowerCase())) continue
        ranges[k] = Array.isArray(v) ? v.join(' ') : String(v ?? '')
      }
      meta.depRanges = ranges
      meta.depends = Object.keys(ranges)
      // breaks：明确声明不兼容的 modId（依赖图里画红色虚线）
      meta.breaks = Object.keys(json.breaks ?? {})
        .map((k) => k.toLowerCase())
        .filter((k) => !NOT_A_MOD.has(k) && k !== (meta.id ?? '').toLowerCase())
      return meta
    } catch {
      /* 继续看 forge */
    }
  }

  // Quilt
  const quilt = readText(buf, entries, 'quilt.mod.json')
  if (quilt) {
    try {
      const json = JSON.parse(quilt) as {
        quilt_loader?: {
          id?: string
          version?: string
          metadata?: { name?: string }
          depends?: ({ id?: string; versions?: string } | string)[]
        }
      }
      const q = json.quilt_loader ?? {}
      meta.loader = 'quilt'
      meta.id = q.id
      meta.name = q.metadata?.name ?? q.id
      meta.version = resolveVersion(q.version, file, mfVersion)
      const ranges: Record<string, string> = {}
      for (const d of q.depends ?? []) {
        const id = typeof d === 'string' ? d : d.id
        if (!id || NOT_A_MOD.has(id.toLowerCase())) continue
        ranges[id] = typeof d === 'string' ? '' : (d.versions ?? '')
      }
      meta.depRanges = ranges
      meta.depends = Object.keys(ranges)
      return meta
    } catch {
      /* 继续看 forge */
    }
  }

  const modsToml = readText(buf, entries, 'META-INF/mods.toml') ?? readText(buf, entries, 'META-INF/neoforge.mods.toml')
  if (modsToml) {
    meta.loader = readText(buf, entries, 'META-INF/neoforge.mods.toml') ? 'neoforge' : 'forge'
    meta.id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(modsToml)?.[1]
    meta.name = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(modsToml)?.[1] ?? meta.id
    meta.version = resolveVersion(/^\s*version\s*=\s*["']([^"']+)["']/m.exec(modsToml)?.[1], file, mfVersion)
    // [[dependencies.<ownModId>]] 段落里才是真依赖：modId / versionRange / mandatory / type
    const ranges: Record<string, string> = {}
    const secRe = /^\[\[dependencies\.[^\]]+\]\]\s*$/gm
    const heads: { start: number; end: number }[] = []
    let mm: RegExpExecArray | null
    while ((mm = secRe.exec(modsToml))) heads.push({ start: mm.index + mm[0].length, end: modsToml.length })
    for (let i = 0; i < heads.length; i++) {
      if (i + 1 < heads.length) heads[i].end = modsToml.lastIndexOf('[[dependencies.', heads[i + 1].start)
      const body = modsToml.slice(heads[i].start, heads[i].end)
      const depId = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(body)?.[1]
      if (!depId || NOT_A_MOD.has(depId.toLowerCase())) continue
      const mandatory = /^\s*mandatory\s*=\s*["']?(\w+)["']?/m.exec(body)?.[1]
      const type = /^\s*type\s*=\s*["']([^"']+)["']/m.exec(body)?.[1]
      if (mandatory === 'false') continue
      if (type === 'optional' || type === 'incompatible' || type === 'discouraged') continue
      if (depId === meta.id) continue
      const range = (/^\s*versionRange\s*=\s*["']([^"']*)["']/m.exec(body)?.[1] ?? '').replace(
        VERSION_PLACEHOLDER,
        ''
      ).trim()
      ranges[depId] = range
    }
    meta.depRanges = ranges
    meta.depends = Object.keys(ranges)
    return meta
  }

  // 老 forge：mcmod.info
  const mcmod = readText(buf, entries, 'mcmod.info')
  if (mcmod) {
    meta.loader = 'forge'
    meta.id = /"modid"\s*:\s*"([^"]+)"/.exec(mcmod)?.[1]
    meta.name = /"name"\s*:\s*"([^"]+)"/.exec(mcmod)?.[1] ?? meta.id
    meta.version = resolveVersion(/"version"\s*:\s*"([^"]+)"/.exec(mcmod)?.[1], file, mfVersion)
  }
  return meta
}

/**
 * 常见前置的显示名。
 * 注意：Fabric API 的 modId 就叫 `fabric`（加载器自己叫 fabricloader），
 * 所以依赖里有 `fabric` 是「缺 Fabric API」，不是「缺 Fabric 加载器」。
 */
const DEP_LABEL: Record<string, string> = {
  fabric: 'Fabric API',
  'fabric-api': 'Fabric API',
  'cloth-config': 'Cloth Config API',
  'architectury': 'Architectury API',
  'forge-config-api-port': 'Forge Config API Port'
}

export function depLabel(id: string): string {
  return DEP_LABEL[id.toLowerCase()] ?? id
}

/** Modrinth 上能直接搜到的 project id（modId 和 project slug 常常不是一回事） */
function depProjectId(id: string): string {
  const k = id.toLowerCase()
  if (k === 'fabric') return 'fabric-api'
  return id
}

/**
 * 同一个东西的两种 id：老模组写 `fabric`（Fabric API 的旧 modId），
 * 新模组写 `fabric-api`。查依赖时两边都要认。
 */
const DEP_ALIAS: Record<string, string> = {
  fabric: 'fabric-api',
  'fabric-api': 'fabric'
}

function lookupProviders(map: Map<string, ModProvider[]>, key: string): ModProvider[] {
  const direct = map.get(key)
  if (direct && direct.length > 0) return direct
  const alias = DEP_ALIAS[key]
  return alias ? (map.get(alias) ?? []) : []
}

/**
 * 「谁提供了这个 modId」索引：文件自己的 id、fabric.mod.json 的 provides、
 * 以及 META-INF/jars 里内嵌的模块都算。只按文件 id 建索引会把
 * cloth-config2 / fabric-resource-loader-v0 / wunderlib 全判成「缺前置」。
 */
function buildProviderIndex(mods: ModMeta[]): Map<string, ModProvider[]> {
  const index = new Map<string, ModProvider[]>()
  const add = (id: string | undefined, p: ModProvider) => {
    if (!id) return
    const k = id.toLowerCase()
    if (!k || NOT_A_MOD.has(k)) return
    const list = index.get(k) ?? []
    if (!list.includes(p)) list.push(p)
    index.set(k, list)
  }
  // 先放文件自己的 id，保证同一个 id 既有真 mod 又有 provides 时优先用真的
  for (const mod of mods) add(mod.id, { mod, version: mod.version })
  for (const mod of mods) {
    for (const id of mod.provides ?? []) add(id, { mod, version: mod.version })
    for (const b of mod.bundled ?? []) {
      add(b.id, { mod, version: b.version ?? mod.version })
      for (const id of b.provides) add(id, { mod, version: b.version ?? mod.version })
    }
  }
  return index
}

/**
 * Mod 体检：重复 mod、加载器不匹配、缺前置、失效的 .old 残留。
 * 全部靠读 jar 内元数据，离线可跑。
 */
type InstanceInfo = NonNullable<ReturnType<typeof store.getInstance>>

/** mods 目录里要读的文件（.jar 和 .jar.disabled 都读：被禁用的可能正是别人缺的前置） */
function modFileNames(modsDir: string): string[] {
  if (!fs.existsSync(modsDir)) return []
  return fs.readdirSync(modsDir).filter((name) => /\.jar(\.disabled)?$/i.test(name))
}

export function diagnoseMods(instanceId: string): { mods: ModMeta[]; issues: ModIssue[] } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const mods: ModMeta[] = []
  for (const name of modFileNames(modsDir)) {
    const meta = parseModJar(path.join(modsDir, name))
    meta.disabled = name.toLowerCase().endsWith('.disabled')
    mods.push(meta)
  }
  return { mods, issues: analyzeMods(instance, mods) }
}

/**
 * 异步版体检：每拆十几个 jar 就让出一次事件循环，几百个 mod 的首轮扫描不会把主进程钉住
 * （首轮要拆包，同步版在冷缓存时要卡一两秒，用户感觉是「一进内容管理就卡」）。
 */
export async function diagnoseModsAsync(
  instanceId: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ mods: ModMeta[]; issues: ModIssue[] }> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const names = modFileNames(modsDir)
  onProgress?.(0, names.length)
  const mods: ModMeta[] = []
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const meta = await parseModJarAsync(path.join(modsDir, name))
    meta.disabled = name.toLowerCase().endsWith('.disabled')
    mods.push(meta)
    // 每 4 个报一次进度：进度条要动起来，用户才知道它没卡死
    if (i % 4 === 3) {
      onProgress?.(i + 1, names.length)
      await new Promise((r) => setImmediate(r))
    }
  }
  onProgress?.(names.length, names.length)
  return { mods, issues: analyzeMods(instance, mods) }
}

/** 纯算术部分：拿到已解析的 mods 之后判重复 / 加载器 / 前置，不碰磁盘 */
function analyzeMods(instance: InstanceInfo, mods: ModMeta[]): ModIssue[] {
  const active = mods.filter((m) => !m.disabled)
  const modsDir = path.join(gamePathFor(instance), 'mods')

  const issues: ModIssue[] = []

  // 1) 重复 mod（同 modId 多个文件）
  const byId = new Map<string, ModMeta[]>()
  for (const mod of active) {
    if (!mod.id) continue
    const list = byId.get(mod.id) ?? []
    list.push(mod)
    byId.set(mod.id, list)
  }
  for (const [id, list] of byId) {
    if (list.length > 1) {
      issues.push({
        level: 'error',
        title: `重复的模组：${id}`,
        explain:
          '同一个 modId 被两个不同的 jar 同时声明（常见于「装了两个版本的同一个 mod」，或整合包自带的版本和你后来手动装的版本撞车）。两个都加载时后一个会覆盖前一个的注册项，游戏通常在启动或进入世界时直接崩，报 Duplicate mod / duplicate registry 之类。这个必须处理，不能忽略。',
        detail: `检测到 ${list.length} 个文件都声明了 modId=${id}，游戏会崩。留一个版本，其余删掉。`,
        files: list.map((m) => m.file)
      })
    }
  }

  // 2) 加载器不匹配
  const expected = instance.loader === 'vanilla' ? undefined : instance.loader
  if (expected) {
    const loadersOf = (m: ModMeta): string[] => {
      const all = [...(m.loaders ?? []), ...(m.loader && m.loader !== 'unknown' ? [m.loader] : [])]
      return [...new Set(all)]
    }
    /** 这个 jar 在 expected 实例里能不能被加载（NeoForge 吃 Forge 的包，Quilt 吃 Fabric 的包） */
    const usableHere = (m: ModMeta): boolean => {
      const all = loadersOf(m)
      if (all.length === 0) return true // 没有元数据（纯库 jar）就别乱报
      if (all.includes(expected)) return true
      if (expected === 'neoforge' && all.includes('forge')) return true
      if (expected === 'quilt' && all.includes('fabric')) return true
      // Legacy Fabric 就是老版本的 Fabric，读的是同一套 fabric.mod.json
      if (expected === 'legacyfabric' && all.includes('fabric')) return true
      // Cleanroom 是 1.12.2 上的 Forge 平替，读的也是 mods.toml
      if (expected === 'cleanroom' && all.includes('forge')) return true
      return false
    }
    const mismatch = active.filter((m) => !usableHere(m))
    if (mismatch.length > 0) {
      const need = [...new Set(mismatch.flatMap((m) => loadersOf(m)))].filter((l) => l !== expected)
      issues.push({
        level: 'error',
        title: `加载器不匹配（当前 ${expected}）`,
        explain:
          '这些 jar 是给另一个模组加载器写的（Fabric 的 jar 放进 Forge 实例就属于这种）。加载器只会读自己那套元数据，另一个加载器的 jar 根本不会被加载 —— 表面上不崩，但那些 mod 的效果全都不存在，界面上还可能弹「模组被忽略」。',
        detail: `${mismatch.length} 个 mod 是给 ${need.join(' / ')} 用的，当前实例是 ${expected}，启动时它们会被直接忽略。要玩它们就点下面「换成 ${need[0]}」一键装好并切过去；不玩就把这几个文件删掉。`,
        files: mismatch.map((m) => m.file),
        fixLoader: need.length === 1 ? (need[0] as ModIssue['fixLoader']) : undefined
      })
    }
  }

  // 3) 缺前置 / 前置被禁用 / 前置版本不对
  const byModId = buildProviderIndex(mods)

  const missing = new Map<string, { files: string[]; range?: string }>()
  const disabledDeps = new Map<string, { files: string[]; jars: string[]; range?: string }>()
  const tooOld = new Map<string, { files: string[]; range?: string; have: string }>()
  const forgeFamily = expected === 'forge' || expected === 'neoforge' || expected === 'cleanroom'
  for (const mod of active) {
    // 通用包（双元数据）：Forge 实例只看 mods.toml 那侧，别拿 Fabric 的依赖报警
    const useForge = forgeFamily && mod.forgeDepends !== undefined
    const depIds = useForge ? mod.forgeDepends! : (mod.depends ?? [])
    const depRanges = useForge ? (mod.forgeDepRanges ?? {}) : (mod.depRanges ?? {})
    for (const dep of depIds) {
      const key = dep.toLowerCase()
      const range = depRanges[dep] ?? depRanges[key] ?? ''
      const providers = lookupProviders(byModId, key)
      const usable = providers.filter((p) => !p.mod.disabled)
      // 装了但被禁用：最常见的就是 fabric-api（modId 叫 fabric）被关掉，
      // 游戏里直接弹「有些模组不兼容」，而界面上还写着「缺前置」
      if (providers.length > 0 && usable.length === 0) {
        const cur = disabledDeps.get(key) ?? { files: [], jars: [], range: range || undefined }
        cur.files.push(mod.file)
        for (const p of providers) if (!cur.jars.includes(p.mod.file)) cur.jars.push(p.mod.file)
        if (!cur.range && range) cur.range = range
        disabledDeps.set(key, cur)
        continue
      }
      if (usable.length === 0) {
        const cur = missing.get(key) ?? { files: [], range: range || undefined }
        cur.files.push(mod.file)
        if (!cur.range && range) cur.range = range
        missing.set(key, cur)
        continue
      }
      if (!range) continue
      // 同一个 id 可能有多个提供者：文件自己 + 各 jar 内嵌的同名模块（版本常常不一样旧），
      // 只要有一个满足就算满足，别拿最旧的那个报「版本对不上」
      const withVer = usable.filter((p) => p.version && !hasPlaceholder(p.version))
      if (withVer.length === 0) continue
      if (withVer.some((p) => satisfiesRange(p.version!, range))) continue
      let best = withVer[0]
      for (const p of withVer) if (cmpVersion(p.version!, best.version!) > 0) best = p
      const cur = tooOld.get(key) ?? { files: [], range, have: best.version! }
      cur.files.push(mod.file)
      tooOld.set(key, cur)
    }
  }
  for (const [dep, info] of tooOld) {
    const label = depLabel(dep)
    issues.push({
      level: 'warn',
      title: `前置版本对不上：${label}`,
      explain:
        '前置装了，但版本不在这些 mod 要求的范围内。轻的是某些功能默默失效（配方不显示、界面点不动），重的是启动时直接崩在缺方法/缺类上。注意：模组圈的版本号后缀（-264、+1.20.1）只是打包号，体检已经忽略它们，这里报的是真·主版本不符。',
      detail: `下面这些 mod 要 ${label} ${info.range || '其它版本'}，你装的是 ${info.have}。版本不匹配时轻则功能缺失，重则进游戏就崩。去「Mod 更新 / 资源」页把 ${label} 换成合适的版本。`,
      files: [...new Set(info.files)]
    })
  }
  for (const [dep, info] of disabledDeps) {
    const label = depLabel(dep)
    issues.push({
      level: 'error',
      title: `前置被禁用了：${label}`,
      explain:
        '文件就在 mods 目录里，只是名字结尾多了 .disabled，加载器会跳过它。于是依赖它的 mod 全都拿不到前置：轻则功能缺一半、界面点不动，重则启动直接报「模组不兼容 / 缺少前置」。把 .disabled 去掉就能用，不需要重新下载，也不会丢配置。',
      detail: `${[...new Set(info.files)].length} 个 mod 要它才生效，但它现在是「已禁用」状态（文件名带 .disabled），游戏不会加载 —— 典型现象就是进游戏弹「有些不兼容的模组」或者那个模组功能缺一半。点下面「启用 ${label}」改回可用就行，文件已经在本机，不用重新下载。`,
      files: info.jars,
      enableFiles: info.jars
    })
  }
  // 这里的 id 是「加载器自己」，不是要装的前置模组
  const LOADER_WORDS = new Set([
    'fabricloader',
    'fabric-loader',
    'fabric_loader',
    'forge',
    'neoforge',
    'quilt_loader',
    'quilted_fabric_loader',
    'quilt-loader'
  ])
  for (const [dep, info] of missing) {
    if (LOADER_WORDS.has(dep)) {
      issues.push({
        level: 'warn',
        title: `这些 mod 需要 ${dep} 加载器`,
        explain:
          '加载器（Fabric / Forge / NeoForge / Quilt）是 mod 的底层运行时，装错了整套 mod 都不会生效 —— 游戏能开进原版，但界面上什么 mod 都没有。这不是「缺个前置」，是整套运行时不对，要么换加载器，要么把这几个 mod 删掉。',
        detail: `它们依赖 ${dep}，当前实例是 ${expected ?? '原版（没装加载器）'}，加载器不对装进去也不会被加载。想用就到「加载器」面板装 ${dep} 再启动。`,
        files: [...new Set(info.files)]
      })
      continue
    }
    const label = depLabel(dep)
    const rangeText = info.range ? ` ${info.range}` : ''
    issues.push({
      level: 'warn',
      title: `缺前置：${label}${rangeText}`,
      explain: `前置（Library / API）是别的 mod 依赖的公共库，比如 Fabric API、Cloth Config、Architectury。缺了它，依赖它的 mod 通常不会让游戏崩，但会「静悄悄地坏」：物品没配方、界面按钮点不动、存档里的方块变成空气。所以看到这条最好装上，它不会影响你现有的存档。`,
      detail: `${[...new Set(info.files)].length} 个 mod 要它才能正常工作，但 mods 目录里没有（或只有被禁用的版本）。缺前置时游戏可能不崩，但那个模组的功能会缺一半（物品没配方、界面点不动之类），有的加载器还会直接弹「模组不兼容」。点下面「装上 ${label}」自动从 Modrinth 找并安装。`,
      files: [...new Set(info.files)],
      fixDep: depProjectId(dep),
      depRange: info.range
    })
  }

  // 4) 残留 .old / .disabled
  const neededDisabled = new Set([...disabledDeps.values()].flatMap((v) => v.jars))
  const stale = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((n) => (n.endsWith('.old') || n.endsWith('.disabled')) && !neededDisabled.has(n))
    : []
  if (stale.length > 0) {
    issues.push({
      level: 'info',
      title: `有 ${stale.length} 个未启用的残留文件`,
      explain:
        '这些是更新模组时留下的旧版本（.old）或被手动禁用的文件（.disabled）。它们不会被加载，不影响游戏，只是占空间 —— 通常是你更新过模组、或是为了排查问题临时禁用过。确认游戏能正常启动后，删掉就干净了。',
      detail: '这些文件（.old / .disabled）不会加载，确认没问题后可以删掉省空间。',
      files: stale
    })
  }

  // 5) 版本读不出来的：明确说出来，而不是让版本比对静默跳过
  //    典型来源：Forge 的 mods.toml 把 version 写成 ${file.jarVersion} 这种占位符，
  //    jar 里也没有 MANIFEST、文件名里也没有版本号。这类 jar 不参与「前置版本对不上」判断，
  //    与其默默放过（用户以为体检过了），不如列出来告诉他「这几个没查版本」。
  const unversioned = active.filter((m) => m.id && (!m.version || hasPlaceholder(m.version)))
  if (unversioned.length > 0) {
    issues.push({
      level: 'info',
      title: `${unversioned.length} 个模组的版本读不出来（已跳过版本比对）`,
      explain:
        '模组把自己的版本号写成了占位符（比如 Forge 的 ${file.jarVersion}），真实版本要游戏启动时才填进去；jar 里既没有 MANIFEST、文件名里也没有版本号，所以体检读不到。这不代表有问题 —— 只是这几个模组的「版本对不对得上」没法验证，其它检查照常。',
      detail: '下面这些 jar 的版本号读不到，体检没拿它们去比对前置版本要求。游戏能正常启动就不用管它们。',
      files: unversioned.map((m) => m.file)
    })
  }

  if (issues.length === 0) {
    issues.push({
      level: 'info',
      title: '没发现问题',
      detail: `扫描了 ${active.length} 个启用中的 mod，重复/加载器/前置都正常。`
    })
  }

  return issues
}

/** 计算 jar 的 sha1（导出 mrpack 用） */
export function sha1Of(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}
