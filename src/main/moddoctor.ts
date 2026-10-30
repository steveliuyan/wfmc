import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { listZipEntries, readZipEntry } from './zip'
import { store } from './store'
import { gamePathFor } from './paths'

export interface ModIssue {
  level: 'error' | 'warn' | 'info'
  title: string
  detail: string
  files?: string[]
  /** 这条问题的「一键修复」= 给实例装这个加载器（模组要它，而实例装的不是它） */
  fixLoader?: 'fabric' | 'forge' | 'neoforge' | 'quilt'
  /** 这条问题的「一键修复」= 去 Modrinth 把这个前置模组装上 */
  fixDep?: string
  /** 前置要求的版本范围（展示用，例如 >=1.0.0） */
  depRange?: string
}

interface ModMeta {
  file: string
  path: string
  id?: string
  name?: string
  version?: string
  loader?: 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'unknown'
  depends?: string[]
  /** 依赖 id → 版本要求（Fabric 的 >=1.0.0、Forge 的 [1.0,) 都在这里） */
  depRanges?: Record<string, string>
}

/** 不算「要装的前置」的那些 id：游戏本体、Java、加载器自己 */
const NOT_A_MOD = new Set([
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

/** 版本号比较：只比数字段，`1.2.3-beta` 当 1.2.3，够用且不会因为后缀乱报 */
function cmpVersion(a: string, b: string): number {
  const seg = (v: string) =>
    v
      .split(/[.+\-_ ]/)
      .map((x) => Number.parseInt(x.replace(/[^\d]/g, ''), 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const x = seg(a)
  const y = seg(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
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

/** 从 jar 里读 mod 元数据（Fabric 的 fabric.mod.json / Forge 的 mods.toml） */
function parseModJar(file: string): ModMeta {
  const meta: ModMeta = { file: path.basename(file), path: file, loader: 'unknown' }
  let buf: Buffer
  try {
    buf = fs.readFileSync(file)
  } catch {
    return meta
  }
  let entries: ReturnType<typeof listZipEntries>
  try {
    entries = listZipEntries(buf)
  } catch {
    return meta
  }

  const fabric = readText(buf, entries, 'fabric.mod.json')
  if (fabric) {
    try {
      const json = JSON.parse(fabric) as {
        id?: string
        name?: string
        version?: string
        depends?: Record<string, string | string[]>
      }
      meta.loader = 'fabric'
      meta.id = json.id
      meta.name = json.name ?? json.id
      meta.version = typeof json.version === 'string' ? json.version : json.version ? String(json.version) : undefined
      const ranges: Record<string, string> = {}
      for (const [k, v] of Object.entries(json.depends ?? {})) {
        if (NOT_A_MOD.has(k.toLowerCase())) continue
        ranges[k] = Array.isArray(v) ? v.join(' ') : String(v ?? '')
      }
      meta.depRanges = ranges
      meta.depends = Object.keys(ranges)
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
      meta.version = q.version
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
    meta.version = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(modsToml)?.[1]
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
      const range = /^\s*versionRange\s*=\s*["']([^"']*)["']/m.exec(body)?.[1] ?? ''
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
    meta.version = /"version"\s*:\s*"([^"]+)"/.exec(mcmod)?.[1]
  }
  return meta
}

/**
 * Mod 体检：重复 mod、加载器不匹配、缺前置、失效的 .old 残留。
 * 全部靠读 jar 内元数据，离线可跑。
 */
export function diagnoseMods(instanceId: string): { mods: ModMeta[]; issues: ModIssue[] } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const mods: ModMeta[] = []
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      mods.push(parseModJar(path.join(modsDir, name)))
    }
  }

  const issues: ModIssue[] = []

  // 1) 重复 mod（同 modId 多个文件）
  const byId = new Map<string, ModMeta[]>()
  for (const mod of mods) {
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
        detail: `检测到 ${list.length} 个文件都声明了 modId=${id}，游戏会崩。留一个版本，其余删掉。`,
        files: list.map((m) => m.file)
      })
    }
  }

  // 2) 加载器不匹配
  const expected = instance.loader === 'vanilla' ? undefined : instance.loader
  if (expected) {
    const mismatch = mods.filter(
      (m) => m.loader && m.loader !== 'unknown' && m.loader !== expected && !(expected === 'neoforge' && m.loader === 'forge')
    )
    if (mismatch.length > 0) {
      const need = [...new Set(mismatch.map((m) => String(m.loader)))]
      issues.push({
        level: 'error',
        title: `加载器不匹配（当前 ${expected}）`,
        detail: `${mismatch.length} 个 mod 是给 ${need.join(' / ')} 用的，当前实例是 ${expected}，启动时它们会被直接忽略。要玩它们就点下面「换成 ${need[0]}」一键装好并切过去；不玩就把这几个文件删掉。`,
        files: mismatch.map((m) => m.file),
        fixLoader: need.length === 1 ? (need[0] as ModIssue['fixLoader']) : undefined
      })
    }
  }

  // 3) 缺前置 / 前置版本不对
  const byModId = new Map<string, ModMeta[]>()
  for (const mod of mods) if (mod.id) byModId.set(mod.id.toLowerCase(), [...(byModId.get(mod.id.toLowerCase()) ?? []), mod])

  const missing = new Map<string, { files: string[]; range?: string }>()
  const tooOld = new Map<string, { files: string[]; range?: string; have: string }>()
  for (const mod of mods) {
    for (const dep of mod.depends ?? []) {
      const key = dep.toLowerCase()
      const range = mod.depRanges?.[dep] ?? mod.depRanges?.[key] ?? ''
      const installed = byModId.get(key)
      if (!installed || installed.length === 0) {
        const cur = missing.get(key) ?? { files: [], range: range || undefined }
        cur.files.push(mod.file)
        if (!cur.range && range) cur.range = range
        missing.set(key, cur)
        continue
      }
      if (!range) continue
      const have = installed.find((i) => i.version)?.version
      if (!have) continue
      if (!satisfiesRange(have, range)) {
        const cur = tooOld.get(key) ?? { files: [], range, have }
        cur.files.push(mod.file)
        tooOld.set(key, cur)
      }
    }
  }
  for (const [dep, info] of tooOld) {
    issues.push({
      level: 'warn',
      title: `前置版本对不上：${dep}`,
      detail: `下面这些 mod 要 ${dep} ${info.range || '其它版本'}，你装的是 ${info.have}。版本不匹配时轻则功能缺失，重则进游戏就崩。去「Mod 更新 / 资源」页把 ${dep} 换成合适的版本。`,
      files: [...new Set(info.files)]
    })
  }
  const LOADER_WORDS = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'fabricloader','fabric-loader'])
  for (const [dep, info] of missing) {
    if (LOADER_WORDS.has(dep)) {
      // 声明依赖 fabric 意思是「这是个 Fabric mod」，不是真缺一个前置模组
      issues.push({
        level: 'warn',
        title: `这些 mod 需要 ${dep} 加载器`,
        detail: `它们依赖 ${dep}，当前实例是 ${expected ?? '原版（没装加载器）'}，加载器不对装进去也不会被加载。想用就到「加载器」面板装 ${dep} 再启动。`,
        files: [...new Set(info.files)]
      })
      continue
    }
    const rangeText = info.range ? ` ${info.range}` : ''
    issues.push({
      level: 'warn',
      title: `缺前置：${dep}${rangeText}`,
      detail: `${[...new Set(info.files)].length} 个 mod 要它才能正常工作，但 mods 目录里没有。缺前置时游戏可能不崩，但那个模组的功能会缺一半（物品没配方、界面点不动之类）。点下面「装上 ${dep}」自动从 Modrinth 找并安装。`,
      files: [...new Set(info.files)],
      fixDep: dep,
      depRange: info.range
    })
  }

  // 4) 残留 .old / .disabled
  const stale = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((n) => n.endsWith('.old') || n.endsWith('.disabled'))
    : []
  if (stale.length > 0) {
    issues.push({
      level: 'info',
      title: `有 ${stale.length} 个未启用的残留文件`,
      detail: '这些文件（.old / .disabled）不会加载，确认没问题后可以删掉省空间。',
      files: stale
    })
  }

  if (issues.length === 0) {
    issues.push({ level: 'info', title: '没发现问题', detail: `扫描了 ${mods.length} 个 mod，重复/加载器/前置都正常。` })
  }

  return { mods, issues }
}

/** 计算 jar 的 sha1（导出 mrpack 用） */
export function sha1Of(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}
