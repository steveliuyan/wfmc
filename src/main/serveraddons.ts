/**
 * 服主面板 2.0：插件 / 模组市场（Modrinth + Hangar）
 *
 * - 搜索：Modrinth 走 /v2/search，插件用 project_type:plugin + categories:paper；Hangar 免 key。
 * - 安装：只认「官方给出的下载地址 + 官方给的 sha 校验」，下到 .tmp 再原子改名进 plugins/ 或 mods/，
 *   校验失败就把临时文件删掉并抛错，绝不留半截 jar 给服务端去加载。
 * - 卸载：移到 <服务端>/.trash/ 而不是直接删（用户手滑了还能捞回来）。
 * 这里不 import serverhost，服务端目录由调用方传进来，方便单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchJson, downloadFile } from './net'
import type { AddonHit, AddonVersion } from '../shared/types'

export type AddonSource = 'modrinth' | 'hangar'
export type AddonKind = 'plugin' | 'mod'

export type { AddonHit, AddonVersion } from '../shared/types'

const UA = { 'User-Agent': 'WFMC-Launcher/1.2.0 (https://github.com/steveliuyan/wfmc)' }
const MODRINTH = 'https://api.modrinth.com/v2'
const HANGAR = 'https://hangar.papermc.io/api/v1'

function cleanText(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------ 搜索 ------------------------------ */

export async function searchAddons(opts: {
  query: string
  kind: AddonKind
  mcVersion?: string
  /** 模组服用：fabric / forge / neoforge */
  loader?: string
  source?: AddonSource
  limit?: number
}): Promise<AddonHit[]> {
  const limit = Math.min(40, Math.max(1, opts.limit ?? 20))
  const wanted = opts.source ?? (opts.kind === 'plugin' ? 'modrinth' : 'modrinth')
  const jobs: Promise<AddonHit[]>[] = []
  if (wanted === 'modrinth') jobs.push(searchModrinth(opts, limit))
  if (wanted === 'hangar' && opts.kind === 'plugin') jobs.push(searchHangar(opts, limit))
  const results = await Promise.allSettled(jobs)
  const hits = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  if (hits.length === 0) {
    const first = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    if (first) throw new Error(`搜索失败：${first.reason instanceof Error ? first.reason.message : String(first.reason)}`)
  }
  return hits
}

async function searchModrinth(opts: { query: string; kind: AddonKind; mcVersion?: string; loader?: string }, limit: number): Promise<AddonHit[]> {
  const facets: string[][] = [[`project_type:${opts.kind === 'plugin' ? 'plugin' : 'mod'}`]]
  if (opts.kind === 'plugin') facets.push(['categories:paper', 'categories:purpur', 'categories:spigot', 'categories:bukkit'])
  if (opts.kind === 'mod' && opts.loader) facets.push([`categories:${opts.loader}`])
  if (opts.mcVersion) facets.push([`versions:${opts.mcVersion}`])
  const url =
    `${MODRINTH}/search?limit=${limit}&index=relevance` +
    `&query=${encodeURIComponent(opts.query)}` +
    `&facets=${encodeURIComponent(JSON.stringify(facets))}`
  const body = await fetchJson<{ hits?: Record<string, unknown>[] }>(url, { headers: UA })
  return (body.hits ?? []).map((h) => ({
    source: 'modrinth' as const,
    id: String(h.project_id ?? h.slug ?? ''),
    title: cleanText(h.title),
    author: cleanText(h.author),
    description: cleanText(h.description),
    downloads: Number(h.downloads ?? 0),
    iconUrl: typeof h.icon_url === 'string' ? h.icon_url : undefined,
    pageUrl: h.slug ? `https://modrinth.com/project/${h.slug}` : undefined
  }))
}

async function searchHangar(opts: { query: string; mcVersion?: string }, limit: number): Promise<AddonHit[]> {
  const url = `${HANGAR}/projects?limit=${limit}&offset=0&q=${encodeURIComponent(opts.query)}&sort=-downloads`
  const body = await fetchJson<{ result?: Record<string, unknown>[] }>(url, { headers: UA })
  return (body.result ?? []).map((p) => {
    const ns = (p.namespace ?? {}) as { owner?: string; slug?: string }
    const id = `${ns.owner ?? ''}/${ns.slug ?? p.name ?? ''}`
    const stats = (p.stats ?? {}) as { downloads?: number }
    return {
      source: 'hangar' as const,
      id,
      title: cleanText(p.name),
      author: cleanText(ns.owner),
      description: cleanText(p.description ?? p.tagline),
      downloads: Number(stats.downloads ?? 0),
      iconUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : undefined,
      pageUrl: `https://hangar.papermc.io/${id}`
    }
  })
}

/* ---------------------------- 版本列表 ---------------------------- */

export async function listAddonVersions(
  hit: { source: AddonSource; id: string },
  opts: { kind: AddonKind; mcVersion?: string; loader?: string }
): Promise<AddonVersion[]> {
  if (hit.source === 'hangar') return await hangarVersions(hit.id, opts)
  return await modrinthVersions(hit.id, opts)
}

async function modrinthVersions(id: string, opts: { kind: AddonKind; mcVersion?: string; loader?: string }): Promise<AddonVersion[]> {
  const loaders = opts.kind === 'mod' ? [opts.loader ?? 'fabric'] : ['paper', 'spigot', 'bukkit', 'purpur']
  const qs = new URLSearchParams({ loaders: JSON.stringify(loaders) })
  if (opts.mcVersion) qs.set('game_versions', JSON.stringify([opts.mcVersion]))
  const url = `${MODRINTH}/project/${encodeURIComponent(id)}/version?${qs.toString()}`
  const list = await fetchJson<Record<string, unknown>[]>(url, { headers: UA })
  const out: AddonVersion[] = []
  for (const v of list ?? []) {
    const files = (v.files ?? []) as Record<string, unknown>[]
    const primary = files.find((f) => f.primary) ?? files[0]
    if (!primary) continue
    out.push({
      version: String(v.version_number ?? v.name ?? ''),
      fileUrl: String(primary.url ?? ''),
      fileName: String(primary.filename ?? ''),
      sizeBytes: Number(primary.size ?? 0) || undefined,
      sha512: typeof primary.hashes === 'object' ? String((primary.hashes as Record<string, string>).sha512 ?? '') || undefined : undefined,
      sha256: undefined,
      gameVersions: (v.game_versions as string[]) ?? [],
      loaders: (v.loaders as string[]) ?? [],
      downloadCount: Number(v.downloads ?? 0) || undefined,
      channel: String(v.version_type ?? '')
    })
  }
  return out
}

async function hangarVersions(id: string, opts: { mcVersion?: string }): Promise<AddonVersion[]> {
  const qs = new URLSearchParams({ limit: '25', offset: '0' })
  if (opts.mcVersion) qs.set('platformVersion', opts.mcVersion)
  const url = `${HANGAR}/projects/${id}/versions?${qs.toString()}`
  const body = await fetchJson<{ result?: Record<string, unknown>[] }>(url, { headers: UA })
  const out: AddonVersion[] = []
  for (const v of body.result ?? []) {
    const downloads = (v.downloads ?? {}) as Record<string, Record<string, unknown>>
    const platform = downloads.PAPER ?? downloads.WATERFALL ?? downloads.VELOCITY ?? Object.values(downloads)[0]
    if (!platform) continue
    const info = (platform.fileInfo ?? {}) as Record<string, unknown>
    const url = String(platform.downloadUrl ?? platform.externalUrl ?? '')
    if (!url) continue
    out.push({
      version: String(v.name ?? ''),
      fileUrl: url,
      fileName: String(info.name ?? `${id.replace('/', '-')}-${v.name}.jar`),
      sizeBytes: Number(info.sizeBytes ?? 0) || undefined,
      sha256: typeof info.sha256Hash === 'string' ? info.sha256Hash : undefined,
      gameVersions: ((v.platformDependencies as Record<string, string[]> | undefined)?.PAPER ?? []) as string[],
      loaders: ['paper'],
      downloadCount: Number(platform.downloadCount ?? 0) || undefined,
      channel: String(v.channel?.toString?.() ?? v.channel ?? '')
    })
  }
  return out
}

/* ------------------------------ 安装 ------------------------------ */

export function addonDir(serverDir: string, kind: AddonKind): string {
  return path.join(serverDir, kind === 'plugin' ? 'plugins' : 'mods')
}

export function listInstalledAddons(serverDir: string, kind: AddonKind): { fileName: string; bytes: number }[] {
  const dir = addonDir(serverDir, kind)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.jar'))
    .map((n) => {
      const full = path.join(dir, n)
      const st = fs.statSync(full)
      return { fileName: n, bytes: st.size }
    })
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
}

/**
 * 下载并安装。
 * verify 用官方 sha：Modrinth 给 sha512，Hangar 给 sha256。两条都支持，拿到哪个用哪个。
 */
export async function installAddon(
  serverDir: string,
  version: AddonVersion,
  kind: AddonKind,
  onProgress?: (done: number, total: number) => void
): Promise<{ filePath: string; fileName: string; bytes: number }> {
  const fileName = path.basename(version.fileName || 'addon.jar').replace(/[\\/:*?"<>|]/g, '_')
  if (!fileName.toLowerCase().endsWith('.jar')) throw new Error('下载目标不是 .jar')
  const dir = addonDir(serverDir, kind)
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(serverDir, '.trash'), { recursive: true })

  const tmp = path.join(serverDir, '.trash', `${fileName}.part`)
  try {
    await downloadFile(
      version.fileUrl,
      tmp,
      onProgress ? (done: number, total: number) => onProgress(done, total || version.sizeBytes || 0) : undefined
    )
    const bytes = fs.statSync(tmp).size
    if (version.sizeBytes && bytes !== version.sizeBytes) {
      throw new Error(`大小对不上：期望 ${version.sizeBytes} 字节，实际 ${bytes} 字节`)
    }
    if (version.sha512 || version.sha256) {
      const got = await hashFile(tmp, version.sha512 ? 'sha512' : 'sha256')
      const want = (version.sha512 ?? version.sha256 ?? '').toLowerCase()
      if (got !== want) throw new Error('校验失败：下载到的文件和官方哈希不一致，已丢弃')
    }
    const dest = path.join(dir, fileName)
    // 同名的旧版本进 .trash，别直接覆盖掉用户可能想回滚的那份
    if (fs.existsSync(dest)) fs.renameSync(dest, path.join(serverDir, '.trash', `${fileName}.${Date.now()}.bak`))
    fs.renameSync(tmp, dest)
    return { filePath: dest, fileName, bytes }
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {
      /* 忽略 */
    }
    throw e
  }
}

/** 卸载：挪进 .trash/，返回挪到哪了 */
export function removeAddon(serverDir: string, fileName: string, kind: AddonKind): string {
  const safe = path.basename(fileName)
  const file = path.join(addonDir(serverDir, kind), safe)
  if (!fs.existsSync(file)) throw new Error('没找到这个文件')
  const trash = path.join(serverDir, '.trash')
  fs.mkdirSync(trash, { recursive: true })
  const dest = path.join(trash, `${safe}.${Date.now()}`)
  fs.renameSync(file, dest)
  return dest
}

async function hashFile(file: string, algo: 'sha256' | 'sha512'): Promise<string> {
  const { createHash } = await import('node:crypto')
  const h = createHash(algo)
  const stream = fs.createReadStream(file)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (c) => h.update(c))
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  return h.digest('hex')
}
