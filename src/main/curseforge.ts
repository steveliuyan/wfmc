import fs from 'node:fs'
import path from 'node:path'
import { CurseforgeV1Client } from '@xmcl/curseforge'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { downloadFile } from './net'
import { ensureGamePath } from './paths'
import { expandCnQuery, hasChinese } from './cnname'

/**
 * CurseForge 搜索 / 安装（要自备 API Key，设置里填）。
 * CurseForge 对第三方客户端要求 key，这里只做「搜 + 装一个文件」。
 */

function clientOrThrow(): CurseforgeV1Client {
  const key = store.settings.curseforgeApiKey?.trim()
  if (!key) throw new Error('先去设置里填 CurseForge API Key（console.curseforge.com 免费申请）')
  return new CurseforgeV1Client(key)
}

export interface CfMod {
  id: number
  name: string
  summary: string
  downloadCount: number
  logoUrl?: string
  url?: string
}

function logoUrl(mod: { logo?: { thumbnailUrl?: string; url?: string } }): string | undefined {
  return mod.logo?.thumbnailUrl ?? mod.logo?.url
}

export async function searchCurseforge(input: {
  query: string
  mcVersion?: string
  loader?: string
  pageSize?: number
}): Promise<{ hits: CfMod[]; cn?: { matched: boolean; used: string[] } }> {
  const client = clientOrThrow()
  const raw = (input.query ?? '').trim()
  // 中文名先翻成英文再搜（CurseForge 同样只认英文原名）
  const cn = hasChinese(raw) ? expandCnQuery(raw) : undefined
  const queries = cn?.matched && cn.used.length ? cn.used : [raw]

  const seen = new Set<number>()
  const hits: CfMod[] = []
  for (const q of queries) {
    try {
      const result = await client.searchMods({
        gameId: 432, // Minecraft
        classId: 6, // Mods
        searchFilter: q || undefined,
        gameVersion: input.mcVersion,
        modLoaderType: input.loader ? modLoaderTypeOf(input.loader) : undefined,
        sortField: 2, // 2 = popularity
        sortOrder: 'desc',
        pageSize: input.pageSize ?? 20
      })
      for (const mod of result.data ?? []) {
        if (seen.has(mod.id)) continue
        seen.add(mod.id)
        hits.push({
          id: mod.id,
          name: mod.name,
          summary: mod.summary,
          downloadCount: mod.downloadCount,
          logoUrl: logoUrl(mod),
          url: mod.links?.websiteUrl
        })
      }
    } catch (e) {
      if (hits.length === 0 && q === queries[queries.length - 1]) throw e
    }
  }
  // 翻译后没结果就用原词再试一次
  if (hits.length === 0 && cn?.matched) {
    const result = await client.searchMods({
      gameId: 432,
      classId: 6,
      searchFilter: raw || undefined,
      sortField: 2,
      sortOrder: 'desc',
      pageSize: input.pageSize ?? 20
    })
    for (const mod of result.data ?? []) {
      if (seen.has(mod.id)) continue
      seen.add(mod.id)
      hits.push({
        id: mod.id,
        name: mod.name,
        summary: mod.summary,
        downloadCount: mod.downloadCount,
        logoUrl: logoUrl(mod),
        url: mod.links?.websiteUrl
      })
    }
  }
  return { hits, cn: cn ? { matched: cn.matched, used: cn.used } : undefined }
}

function modLoaderTypeOf(loader: string): number | undefined {
  // CurseForge: 1=Forge 4=Fabric 5=Quilt 6=NeoForge
  if (loader === 'forge') return 1
  if (loader === 'fabric') return 4
  if (loader === 'quilt') return 5
  if (loader === 'neoforge') return 6
  return undefined
}

/** 装最新匹配版本到实例的 mods */
export async function installCurseforgeMod(
  instanceId: string,
  modId: number,
  onProgress?: ProgressFn
): Promise<string> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const client = clientOrThrow()

  const files = await client.getModFiles({
    modId,
    gameVersion: instance.mcVersion,
    modLoaderType: instance.loader !== 'vanilla' ? modLoaderTypeOf(instance.loader) : undefined,
    pageSize: 20
  })
  const file = files.data?.[0]
  if (!file) throw new Error('这个模组没有适配当前版本/加载器的文件')

  const modsDir = path.join(ensureGamePath(instance), 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const dest = path.join(modsDir, file.fileName)
  onProgress?.({ key: `cf-${modId}`, phase: `下载 ${file.displayName}`, current: 0, total: 1 })
  await downloadFile(
    file.downloadUrl ?? '',
    dest,
    (cur, total) => onProgress?.({ key: `cf-${modId}`, phase: `下载 ${file.displayName}`, current: cur, total }),
    { skipIfExists: false }
  )
  return dest
}

/** 自检：拿 key 打一次真实请求，把状态码翻译成人话 */
export async function testCurseforgeKey(key: string): Promise<string> {
  const k = key.trim()
  if (!k) throw new Error('先填 Key')
  const r = await fetch('https://api.curseforge.com/v1/mods/search?gameId=432&classId=6&pageSize=1', {
    headers: { 'x-api-key': k, Accept: 'application/json' }
  })
  if (r.ok) {
    const json = (await r.json()) as { pagination?: { totalCount?: number } }
    return `Key 可用（CurseForge 返回 ${json.pagination?.totalCount ?? '?'} 个模组）`
  }
  if (r.status === 403) throw new Error('Key 无效或还没被 CurseForge 激活（403）。新申请的 key 有时要等几分钟')
  if (r.status === 401) throw new Error('Key 格式不对（401），检查是不是复制多了空格')
  if (r.status === 429) throw new Error('这条 key 请求太频繁（429），等一分钟再试')
  throw new Error(`CurseForge 返回 ${r.status}：${(await r.text()).slice(0, 120)}`)
}