import type { ProgressFn } from '../shared/types'
import { installResource } from './modrinth'
import { store } from './store'

const API = 'https://api.modrinth.com/v2'
const UA = { 'User-Agent': 'WFMC-Launcher/1.0 (Minecraft launcher)' }

interface MrProject {
  id: string
  slug?: string
  title?: string
  project_type?: string
  loaders?: string[]
}

async function getJson<T>(url: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

/**
 * 把一个 modid（fabric.mod.json / mods.toml 里那个 id）翻成 Modrinth 项目。
 * 顺序：① 直接拿 slug 试一次（大多数模组 slug 就等于 modid）② 搜索并挑 slug 完全一致的 ③ 挑第一个候选。
 */
export async function resolveProjectId(
  modid: string,
  mcVersion?: string,
  loader?: string
): Promise<{ projectId?: string; title?: string; note?: string }> {
  const direct = await getJson<MrProject>(`${API}/project/${encodeURIComponent(modid)}`)
  if (direct?.id && (direct.project_type ?? 'mod') === 'mod') {
    return { projectId: direct.id, title: direct.title }
  }

  const facetSets: string[][] = []
  const base = ['project_type:mod']
  facetSets.push(loader ? [...base, `versions:${mcVersion ?? ''}`, `categories:${loader}`] : mcVersion ? [...base, `versions:${mcVersion}`] : base)
  facetSets.push(loader ? [...base, `categories:${loader}`] : base)
  facetSets.push(base)

  for (const facets of facetSets) {
    const url = `${API}/search?query=${encodeURIComponent(modid)}&limit=8&facets=${encodeURIComponent(
      JSON.stringify(facets.filter(Boolean).map((f) => [f]))
    )}`
    const res = await getJson<{ hits?: MrProject[] }>(url)
    const hits = res?.hits ?? []
    if (hits.length === 0) continue
    const exact = hits.find((h) => (h.slug ?? '').toLowerCase() === modid.toLowerCase())
    const pick = exact ?? hits[0]
    return { projectId: pick.id, title: pick.title, note: exact ? undefined : '按名字搜到的，可能不是同一个模组' }
  }
  return { note: 'Modrinth 上没搜到，可能只在 CurseForge 或没公开' }
}

export interface FixDepItem {
  modid: string
  projectId?: string
  title?: string
  status: 'installed' | 'skipped' | 'failed'
  detail?: string
}

export interface FixDepsResult {
  items: FixDepItem[]
  installed: string[]
  failed: number
}

/** 把一串缺失的前置 modid 全装上（各自连带把自己的前置也补齐） */
export async function fixMissingDeps(
  instanceId: string,
  modids: string[],
  onProgress?: ProgressFn
): Promise<FixDepsResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const loader = instance.loader === 'vanilla' ? undefined : instance.loader
  const items: FixDepItem[] = []
  const installed: string[] = []

  for (const modid of modids) {
    onProgress?.({ key: `deps-${instanceId}`, phase: `找前置 ${modid}`, current: 0, total: modids.length })
    const found = await resolveProjectId(modid, instance.mcVersion, loader)
    if (!found.projectId) {
      items.push({ modid, status: 'failed', detail: found.note })
      continue
    }
    try {
      const res = await installResource(instanceId, 'mod', found.projectId, undefined, onProgress)
      installed.push(...res.installed)
      if (res.failed.length > 0 && res.installed.length === 0) {
        items.push({ modid, projectId: found.projectId, title: found.title, status: 'failed', detail: res.failed[0]?.error })
      } else {
        items.push({
          modid,
          projectId: found.projectId,
          title: found.title,
          status: res.installed.length > 0 ? 'installed' : 'skipped',
          detail: res.installed.length === 0 ? '已经装过了' : `${res.installed.length} 个文件`
        })
      }
    } catch (e) {
      items.push({ modid, projectId: found.projectId, title: found.title, status: 'failed', detail: (e as Error).message })
    }
  }

  onProgress?.({ key: `deps-${instanceId}`, phase: '前置处理完成', current: modids.length, total: modids.length, done: true })
  return { items, installed, failed: items.filter((i) => i.status === 'failed').length }
}
