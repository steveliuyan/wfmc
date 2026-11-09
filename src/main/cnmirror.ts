import type { MirrorHit, MirrorSearchResult, MirrorSite } from '../shared/types'

/**
 * 国内资源站镜像（搜索 + 跳浏览器）。
 *
 * 为什么只有「搜」没有「装」：
 *  - BBSMC（bbsmc.net）的 API 是 Modrinth 兼容的开放接口，但自家 CDN 对大文件挂了
 *    CC LOCK 人机验证（/bbsmc/data/... 恒返回 55 字节的验证码页），整合包头部还大量
 *    指向夸克网盘；能自动下的只有回链 Modrinth / CurseForge 的那部分。
 *  - XyeBBS（xyebbs.com）的下载接口要 POST 一道 4 位图形验证码换 token，同样没法自动化。
 * 所以这两条线统一做成：中文搜到 → 打开网页让用户点下载，能自动装的那部分仍在 Modrinth / CurseForge 那条链上。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function getJson<T>(url: string, timeout = 12000): Promise<T> {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout)
  })
  if (!r.ok) throw new Error(`接口返回 ${r.status}（${new URL(url).host}）`)
  return (await r.json()) as T
}

function clip(s: unknown, n = 260): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 网盘域名 → 中文名，卡片上直接告诉用户「得手动去网盘下」 */
function panLabel(url: string | null | undefined): string {
  if (!url) return ''
  const u = url.toLowerCase()
  if (u.includes('pan.quark.cn') || u.includes('quark')) return '夸克网盘'
  if (u.includes('pan.baidu.com')) return '百度网盘'
  if (u.includes('123pan')) return '123 网盘'
  if (u.includes('lanzou')) return '蓝奏云'
  if (u.includes('aliyundrive') || u.includes('alipan')) return '阿里云盘'
  if (u.includes('cloud.189.cn')) return '天翼云盘'
  if (u.includes('caiyun')) return '移动云盘'
  return ''
}

// ---------------- BBSMC ----------------

const BBSMC_API = 'https://api.bbsmc.net'

interface BbsmcHit {
  project_id?: string
  project_type?: string
  slug?: string
  title?: string
  description?: string
  author?: string
  categories?: string[]
  versions?: string[]
  downloads?: number
  follows?: number
  icon_url?: string | null
  page_url?: string
}

/** BBSMC 的 index 只认这几个值，别把 'newest' 之类写错 */
function bbsmcIndex(sort?: string): string {
  switch (sort) {
    case 'follows':
      return 'follows'
    case 'newest':
      return 'newest'
    case 'updated':
      return 'updated'
    case 'relevance':
      return 'relevance'
    default:
      return 'downloads'
  }
}

async function searchBbsmc(input: {
  type: string
  query?: string
  mcVersion?: string
  loader?: string
  page?: number
  sort?: string
}): Promise<MirrorSearchResult> {
  const limit = 20
  const page = Math.max(1, Math.floor(input.page ?? 1))
  // facets 是 Modrinth 那套：project_type / versions / categories 各一组，组间与、组内或
  const facets: string[][] = [[`project_type:${input.type}`]]
  if (input.mcVersion?.trim()) facets.push([`versions:${input.mcVersion.trim()}`])
  if (input.loader?.trim()) facets.push([`categories:${input.loader.trim()}`])
  const qs = new URLSearchParams({
    query: input.query?.trim() ?? '',
    facets: JSON.stringify(facets),
    index: bbsmcIndex(input.sort),
    limit: String(limit),
    offset: String((page - 1) * limit)
  })
  const data = await getJson<{ hits?: BbsmcHit[]; total_hits?: number }>(`${BBSMC_API}/v2/search?${qs.toString()}`)
  const hits: MirrorHit[] = (data.hits ?? []).map((h) => {
    const ptype = h.project_type || input.type
    return {
      site: 'bbsmc' as MirrorSite,
      id: String(h.project_id ?? h.slug ?? ''),
      title: h.title || h.slug || '(未命名)',
      description: clip(h.description),
      author: h.author ?? '',
      downloads: Number(h.downloads ?? 0),
      iconUrl: h.icon_url ?? '',
      categories: h.categories ?? [],
      versions: h.versions ?? [],
      pageUrl: h.page_url || `https://bbsmc.net/${ptype}/${h.slug ?? h.project_id ?? ''}`,
      note: 'BBSMC 的文件要走验证码 / 网盘，点「打开页面」去网页下'
    }
  })
  const total = Number(data.total_hits ?? hits.length)
  return { hits, total, page, hasMore: page * limit < total }
}

// ---------------- XyeBBS ----------------

const XYE_API = 'https://resource-api.xyeidc.com'

/** resourceTypeId：从 XyeBBS 前端 ResourceTypes 表里对出来的（顺序 2,29,4,3,30,28,31,7,34） */
const XYE_TYPE_ID: Record<string, number> = {
  modpack: 2,
  datapack: 29,
  mod: 4,
  plugin: 3,
  resourcepack: 30,
  shader: 28,
  map: 31,
  app: 7,
  language: 34
}

interface XyeItem {
  id?: number
  uuid?: string
  name?: string
  englishName?: string | null
  description?: string | null
  logoImgUuid?: string | null
  versions?: { id?: number; name?: string }[]
  stat?: { downloadCount?: number; viewCount?: number }
  owner?: { username?: string }
  meta?: { source?: string | null; sourceUrl?: string | null }
}

async function searchXyebbs(input: {
  type: string
  query?: string
  mcVersion?: string
  loader?: string
  page?: number
}): Promise<MirrorSearchResult> {
  const page = Math.max(1, Math.floor(input.page ?? 1))
  // 这家的列表接口固定每页 10 条，翻页就是 page=；也不支持按 MC 版本 / 加载器筛
  const qs = new URLSearchParams({ page: String(page) })
  const typeId = XYE_TYPE_ID[input.type]
  if (typeId) qs.set('resourceTypeId', String(typeId))
  if (input.query?.trim()) qs.set('name', input.query.trim())
  const env = await getJson<{
    data?: { data?: XyeItem[]; count?: number; totalPages?: number; currentPage?: number }
  }>(`${XYE_API}/client/resources?${qs.toString()}`)
  const list = env.data?.data ?? []
  const hits: MirrorHit[] = list.map((it) => {
    const pan = panLabel(it.meta?.sourceUrl)
    return {
      site: 'xyebbs' as MirrorSite,
      id: String(it.id ?? it.uuid ?? ''),
      title: it.name || it.englishName || '(未命名)',
      description: clip(it.description),
      author: it.owner?.username ?? '',
      downloads: Number(it.stat?.downloadCount ?? 0),
      iconUrl: it.logoImgUuid ? `${XYE_API}/client/members/pics/${it.logoImgUuid}/mini` : '',
      categories: [],
      versions: (it.versions ?? []).map((v) => v.name ?? '').filter(Boolean),
      pageUrl: `https://www.xyebbs.com/resources/${it.id}`,
      downloadUrl: `https://www.xyebbs.com/resources/${it.id}/downloads`,
      note: pan ? `文件在${pan}，得去网盘手动下` : '下载页要过一次图形验证码，点「打开下载页」在网页下'
    }
  })
  const total = Number(env.data?.count ?? hits.length)
  const totalPages = Number(env.data?.totalPages ?? 0)
  return {
    hits,
    total,
    page,
    hasMore: totalPages ? page < totalPages : hits.length > 0,
    hint: input.mcVersion || input.loader ? 'XyeBBS 不支持按 MC 版本 / 加载器筛选，这里只按关键词过滤' : undefined
  }
}

// ---------------- 统一入口 ----------------

export async function searchMirror(input: {
  site: MirrorSite
  type: string
  query?: string
  mcVersion?: string
  loader?: string
  page?: number
  sort?: string
}): Promise<MirrorSearchResult> {
  if (input.site === 'xyebbs') return await searchXyebbs(input)
  return await searchBbsmc(input)
}
