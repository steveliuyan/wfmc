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
}

interface ModMeta {
  file: string
  path: string
  id?: string
  name?: string
  version?: string
  loader?: 'fabric' | 'forge' | 'neoforge' | 'quilt' | 'unknown'
  depends?: string[]
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
      meta.depends = Object.keys(json.depends ?? {}).filter((d) => d !== 'minecraft' && d !== 'java' && d !== 'fabricloader')
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
    const deps = [...modsToml.matchAll(/^\s*modId\s*=\s*["']([^"']+)["']/gm)].map((m) => m[1])
    meta.depends = [...new Set(deps)].filter((d) => d !== meta.id && d !== 'minecraft' && d !== 'forge' && d !== 'neoforge')
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
      issues.push({
        level: 'error',
        title: `加载器不匹配（当前 ${expected}）`,
        detail: `${mismatch.length} 个 mod 是给其它加载器用的，装在这个实例里会报错或被忽略。`,
        files: mismatch.map((m) => m.file)
      })
    }
  }

  // 3) 缺前置
  const ids = new Set(mods.map((m) => m.id).filter(Boolean) as string[])
  const missing = new Map<string, string[]>()
  for (const mod of mods) {
    for (const dep of mod.depends ?? []) {
      if (ids.has(dep)) continue
      const list = missing.get(dep) ?? []
      list.push(mod.file)
      missing.set(dep, list)
    }
  }
  for (const [dep, files] of missing) {
    issues.push({
      level: 'warn',
      title: `可能缺前置：${dep}`,
      detail: `下面这些 mod 声明依赖 ${dep}，但 mods 目录里没找到。去 Modrinth 搜 ${dep} 补上。`,
      files: [...new Set(files)]
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
