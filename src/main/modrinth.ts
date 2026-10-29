import fs from 'node:fs'
import path from 'node:path'
import { ModrinthV2Client, type ProjectVersion, type SearchResult } from '@xmcl/modrinth'
import type { ProgressFn, ResourceHit, ResourceVersion, InstallPlan, DepItem, PlanInstallResult } from '../shared/types'
import { downloadFile } from './net'
import { store } from './store'
import { gamePathFor, ensureGamePath } from './paths'
import { expandCnQuery, hasChinese } from './cnname'

const client = new ModrinthV2Client()

export type ResourceType = 'mod' | 'modpack' | 'shader' | 'resourcepack' | 'datapack'

const typeFacet: Record<ResourceType, string> = {
  mod: 'mod',
  modpack: 'modpack',
  shader: 'shader',
  resourcepack: 'resourcepack',
  datapack: 'datapack'
}

/** 资源类型对应实例里的目标文件夹 */
export const targetFolder: Record<ResourceType, string> = {
  mod: 'mods',
  modpack: '',
  shader: 'shaderpacks',
  resourcepack: 'resourcepacks',
  datapack: 'datapacks'
}

export interface SearchParams {
  type: ResourceType
  query?: string
  mcVersion?: string
  loader?: string
  index?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  offset?: number
  limit?: number
}

export async function searchResources(
  params: SearchParams
): Promise<{ hits: ResourceHit[]; total: number; cn?: { matched: boolean; used: string[] } }> {
  const facets: string[][] = [[`project_type:${typeFacet[params.type]}`]]
  if (params.mcVersion) facets.push([`versions:${params.mcVersion}`])
  if (params.loader) facets.push([`categories:${params.loader}`])

  const base = {
    facets: JSON.stringify(facets),
    index: params.index ?? 'relevance',
    offset: params.offset ?? 0,
    limit: params.limit ?? 20
  }

  // Modrinth 只认项目原名（基本是英文），中文先按词表翻成英文再搜
  const cn = expandCnQuery(params.query ?? '')
  const queries = cn.matched ? cn.used : [params.query ?? '']

  const toHit = (h: SearchResult['hits'][number]): ResourceHit => ({
    projectId: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    follows: h.follows,
    iconUrl: h.icon_url,
    categories: h.categories,
    versions: h.versions,
    projectType: h.project_type,
    pageUrl: h.page_url
  })

  const merged: ResourceHit[] = []
  const seen = new Set<string>()
  let total = 0

  for (let i = 0; i < queries.length; i++) {
    const result: SearchResult = await client.searchProjects({ ...base, query: queries[i] })
    if (i === 0) total = result.total_hits
    for (const h of result.hits) {
      if (seen.has(h.project_id)) continue
      seen.add(h.project_id)
      merged.push(toHit(h))
    }
  }

  // 翻译后一个都没搜到，退回原词再试（别让中文查询直接空手而归）
  if (cn.matched && merged.length === 0 && params.query) {
    const raw: SearchResult = await client.searchProjects({ ...base, query: params.query })
    total = raw.total_hits
    for (const h of raw.hits) {
      if (seen.has(h.project_id)) continue
      seen.add(h.project_id)
      merged.push(toHit(h))
    }
  }

  return {
    hits: merged.slice(0, params.limit ?? 20),
    total: Math.max(total, merged.length),
    cn: params.query && hasChinese(params.query) ? cn : undefined
  }
}

export async function listResourceVersions(
  projectId: string,
  opts: { mcVersion?: string; loader?: string } = {}
): Promise<ResourceVersion[]> {
  const versions = await client.getProjectVersions(projectId, {
    gameVersions: opts.mcVersion ? [opts.mcVersion] : undefined,
    loaders: opts.loader ? [opts.loader] : undefined
  })
  return versions.map(toResourceVersion)
}

function toResourceVersion(v: ProjectVersion): ResourceVersion {
  return {
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    versionType: v.version_type,
    downloads: v.downloads,
    datePublished: v.date_published,
    files: (v.files ?? []).map((f) => ({
      url: f.url,
      filename: f.filename,
      primary: !!f.primary,
      size: f.size
    })),
    dependencies: (v.dependencies ?? []).map((d) => ({
      project_id: d.project_id ?? undefined,
      version_id: d.version_id ?? undefined,
      dependency_type: d.dependency_type
    }))
  }
}

function primaryFile(v: ResourceVersion) {
  return v.files.find((f) => f.primary) ?? v.files[0]
}

/**
 * 自动挑最合适的版本（优先 release）。
 * 关键：给了 MC 版本就绝不跨版本兜底 —— 否则会给 1.20.4 实例挑到 26.3 的快照，
 * 装完直接崩。先用「版本 + 加载器」找，找不到再放宽加载器但仍锁死 MC 版本，
 * 还找不到就返回 undefined，由上层报「这个实例没有可用版本」。
 */
export async function pickVersion(
  projectId: string,
  opts: { mcVersion?: string; loader?: string } = {}
): Promise<ResourceVersion | undefined> {
  let versions = await listResourceVersions(projectId, opts)
  if (versions.length === 0 && opts.mcVersion && opts.loader) {
    versions = await listResourceVersions(projectId, { mcVersion: opts.mcVersion })
  }
  if (versions.length === 0 && !opts.mcVersion) {
    versions = await listResourceVersions(projectId)
  }
  if (versions.length === 0) return undefined
  const release = versions.filter((v) => v.versionType === 'release')
  return release[0] ?? versions[0]
}

/** 解析完整依赖树（根 + 必需 + 可选 + 冲突），只查不下载 */
interface TreeItem {
  projectId: string
  version?: ResourceVersion
  kind: 'required' | 'optional' | 'incompatible'
  error?: string
}

async function resolveTree(
  instanceId: string,
  type: ResourceType,
  projectId: string,
  versionId?: string
): Promise<{ root: ResourceVersion; items: TreeItem[] }> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const loaderName = instance.loader === 'vanilla' ? undefined : instance.loader
  // 模组必须跟加载器对得上（fabric 的 jar 丢进 forge 只会崩），光影 / 资源包不看这个
  const needLoader = type === 'mod' || type === 'datapack'
  const loaderMiss = (v: ResourceVersion) =>
    needLoader && !!loaderName && v.loaders.length > 0 && !v.loaders.includes(loaderName)

  let root: ResourceVersion | undefined
  if (versionId) root = toResourceVersion(await client.getProjectVersion(versionId))
  else root = await pickVersion(projectId, { mcVersion: instance.mcVersion, loader: loaderName })
  if (!root) {
    throw new Error(
      `这个项目没有适配 ${instance.mcVersion}${loaderName ? ' / ' + loaderName : ''} 的版本，点「选版本」看看有没有能用的`
    )
  }
  if (loaderMiss(root)) {
    throw new Error(
      `这个版本是给 ${root.loaders.join(' / ')} 用的，当前实例是 ${loaderName}，装进去也起不来。去「选版本」找 ${loaderName} 版`
    )
  }

  const items: TreeItem[] = []
  const seen = new Set([projectId])
  const queue: { v: ResourceVersion; depth: number }[] = [{ v: root, depth: 0 }]
  while (queue.length) {
    const cur = queue.shift() as { v: ResourceVersion; depth: number }
    if (cur.depth >= 4) continue
    for (const d of cur.v.dependencies ?? []) {
      const pid = d.project_id
      if (!pid) continue
      if (d.dependency_type === 'incompatible') {
        if (!seen.has(pid)) {
          seen.add(pid)
          items.push({ projectId: pid, kind: 'incompatible' })
        }
        continue
      }
      if (d.dependency_type !== 'required' && d.dependency_type !== 'optional') continue
      if (seen.has(pid)) continue
      seen.add(pid)
      let version: ResourceVersion | undefined
      let error: string | undefined
      try {
        version = d.version_id
          ? toResourceVersion(await client.getProjectVersion(d.version_id))
          : await pickVersion(pid, { mcVersion: instance.mcVersion, loader: loaderName })
        if (!version) error = '没有适配当前实例的版本'
        else if (loaderMiss(version)) error = `只有 ${version.loaders.join(' / ')} 版，跟 ${loaderName} 不兼容`
      } catch (e) {
        error = (e as Error).message
      }
      items.push({ projectId: pid, version: error ? undefined : version, kind: d.dependency_type, error })
      if (version && !error) queue.push({ v: version, depth: cur.depth + 1 })
    }
  }
  return { root, items }
}

/** 批量取项目标题 / 图标，失败就退回 id，不让标题拖垮整个流程 */
async function projectMeta(ids: string[]): Promise<Record<string, { title: string; slug?: string; iconUrl?: string }>> {
  const out: Record<string, { title: string; slug?: string; iconUrl?: string }> = {}
  const uniq = [...new Set(ids.filter(Boolean))]
  if (uniq.length === 0) return out
  try {
    const list = await client.getProjects(uniq)
    for (const p of list as (typeof list[number] & { icon_url?: string })[]) {
      out[p.id] = { title: p.title, slug: p.slug, iconUrl: p.icon_url }
    }
  } catch {
    /* 拿不到标题就用 id 顶上 */
  }
  return out
}

/** 装之前先算出「要装哪些东西」，交给界面展示/勾选 */
export async function planInstall(
  instanceId: string,
  type: ResourceType,
  projectId: string,
  versionId?: string
): Promise<InstallPlan> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const { root, items } = await resolveTree(instanceId, type, projectId, versionId)
  const meta = await projectMeta([projectId, ...items.map((i) => i.projectId)])
  const dir = path.join(gamePathFor(instance), targetFolder[type])
  const exists = (name?: string) => !!name && fs.existsSync(path.join(dir, name))

  const loaderName = instance.loader === 'vanilla' ? undefined : instance.loader
  let mismatch: string | undefined
  if (root.gameVersions.length > 0 && !root.gameVersions.includes(instance.mcVersion)) {
    mismatch = `这个版本标注支持 ${root.gameVersions.slice(0, 6).join(' / ')}，不是当前实例的 ${instance.mcVersion}`
  } else if (loaderName && root.loaders.length > 0 && !root.loaders.includes(loaderName)) {
    mismatch = `这个版本是给 ${root.loaders.join(' / ')} 用的，当前实例是 ${loaderName}`
  }

  const toItem = (pid: string, kind: DepItem['dependencyType'], version?: ResourceVersion, error?: string): DepItem => {
    const f = version ? primaryFile(version) : undefined
    const m = meta[pid]
    return {
      projectId: pid,
      versionId: version?.id,
      title: m?.title ?? pid,
      slug: m?.slug,
      iconUrl: m?.iconUrl,
      dependencyType: kind,
      filename: f?.filename,
      size: f?.size,
      versionName: version?.versionNumber,
      alreadyInstalled: exists(f?.filename),
      error
    }
  }

  const rootFile = primaryFile(root)
  return {
    root: {
      projectId,
      versionId: root.id,
      title: meta[projectId]?.title ?? projectId,
      iconUrl: meta[projectId]?.iconUrl,
      versionName: root.versionNumber,
      filename: rootFile?.filename,
      size: rootFile?.size,
      gameVersions: root.gameVersions,
      loaders: root.loaders,
      mismatch
    },
    required: items.filter((i) => i.kind === 'required').map((i) => toItem(i.projectId, 'required', i.version, i.error)),
    optional: items.filter((i) => i.kind === 'optional').map((i) => toItem(i.projectId, 'optional', i.version, i.error)),
    incompatible: items.filter((i) => i.kind === 'incompatible').map((i) => toItem(i.projectId, 'incompatible'))
  }
}

export interface InstallOptions {
  /** 用户勾选的可选前置（projectId 列表） */
  includeOptional?: string[]
  onItem?: (title: string, state: 'start' | 'done' | 'skip' | 'fail', detail?: string) => void
}

/**
 * 把资源装进实例：先装主文件，再按依赖树补前置。
 * 必需前置一律补，可选只看用户勾选，冲突项只报告不安装。
 */
export async function installResource(
  instanceId: string,
  type: ResourceType,
  projectId: string,
  versionId?: string,
  onProgress?: ProgressFn,
  opts: InstallOptions = {}
): Promise<PlanInstallResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const { root, items } = await resolveTree(instanceId, type, projectId, versionId)
  const meta = await projectMeta([projectId, ...items.map((i) => i.projectId)])
  const dir = path.join(ensureGamePath(instance), targetFolder[type])
  const key = `res-${instanceId}`
  const includeOptional = new Set(opts.includeOptional ?? [])
  const result: PlanInstallResult = { installed: [], skipped: [], failed: [] }

  const titleOf = (pid: string) => meta[pid]?.title ?? pid

  const installOne = async (pid: string, version: ResourceVersion, title: string) => {
    const file = primaryFile(version)
    if (!file) {
      result.failed.push({ title, error: '该版本没有可下载文件' })
      return
    }
    const dest = path.join(dir, file.filename)
    if (fs.existsSync(dest)) {
      const st = fs.statSync(dest)
      if (!file.size || st.size === file.size) {
        result.skipped.push(file.filename)
        opts.onItem?.(title, 'skip', file.filename)
        return
      }
    }
    onProgress?.({ key, phase: `下载 ${file.filename}`, current: 0, total: file.size || 1 })
    opts.onItem?.(title, 'start', file.filename)
    await downloadFile(file.url, dest)
    result.installed.push(file.filename)
    onProgress?.({ key, phase: `${file.filename} 已安装`, current: file.size || 1, total: file.size || 1 })
    opts.onItem?.(title, 'done', file.filename)
  }

  await installOne(projectId, root, titleOf(projectId))

  for (const it of items) {
    const title = titleOf(it.projectId)
    if (it.kind === 'incompatible') {
      result.failed.push({ title, error: '与已选内容冲突，已跳过' })
      opts.onItem?.(title, 'fail', '与已选内容冲突')
      continue
    }
    if (it.kind === 'optional' && !includeOptional.has(it.projectId)) continue
    if (!it.version) {
      result.failed.push({ title, error: it.error ?? '没有适配版本' })
      opts.onItem?.(title, 'fail', it.error ?? '没有适配版本')
      continue
    }
    try {
      await installOne(it.projectId, it.version, title)
    } catch (e) {
      result.failed.push({ title, error: (e as Error).message })
      opts.onItem?.(title, 'fail', (e as Error).message)
    }
  }
  return result
}

/** 列出实例本地已装的光影 / 资源包 */
export function listLocalPacks(instanceId: string, type: 'shaderpack' | 'resourcepack') {
  const instance = store.getInstance(instanceId)
  if (!instance) return []
  const dir = path.join(gamePathFor(instance), type === 'shaderpack' ? 'shaderpacks' : 'resourcepacks')
  try {
    return fs.readdirSync(dir).map((name) => ({ name, path: path.join(dir, name) }))
  } catch {
    return []
  }
}
