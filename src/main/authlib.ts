import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { YggdrasilThirdPartyClient } from '@xmcl/user'
import type { Account, ProgressFn } from '../shared/types'
import { net } from 'electron'
import { store } from './store'
import { downloadFile, fetchJson } from './net'

/**
 * 外置登录（authlib-injector / Yggdrasil 协议，如 LittleSkin、皮肤站）。
 * 登录拿 token 之外，启动时还要把 authlib-injector.jar 作为 javaagent 注进去，
 * 否则游戏连不上第三方验证服务器。
 */

function injectorPath() {
  return path.join(store.dataDir, 'tools', 'authlib-injector.jar')
}

export interface InjectorInfo {
  path: string
  version?: string
}

/** 下载/复用最新版 authlib-injector */
export async function ensureInjector(onProgress?: ProgressFn): Promise<InjectorInfo> {
  const dest = injectorPath()
  if (fs.existsSync(dest) && fs.statSync(dest).size > 50_000) return { path: dest }

  onProgress?.({ key: 'injector', phase: '获取 authlib-injector 版本信息', current: 0, total: 1 })
  const meta = await fetchJson<{ version: string; download_url: string }>(
    'https://authlib-injector.yushi.moe/artifact/latest.json'
  )
  onProgress?.({ key: 'injector', phase: `下载 authlib-injector ${meta.version}`, current: 0, total: 1 })
  await downloadFile(
    [meta.download_url, `https://bmclapi2.bangbang93.com/mirror/authlib-injector/artifact/${meta.version}.jar`],
    dest,
    (cur, total) => onProgress?.({ key: 'injector', phase: '下载 authlib-injector', current: cur, total })
  )
  return { path: dest, version: meta.version }
}

/** 用第三方 Yggdrasil 服务登录（返回账号 + 该账号下的角色列表） */
export async function loginThirdParty(input: {
  apiRoot: string
  username: string
  password: string
}): Promise<{ account: Account; profiles: { id: string; name: string }[] }> {
  const api = normalizeApi(input.apiRoot)

  const client = new YggdrasilThirdPartyClient(api)
  const auth = await client.login({
    username: input.username,
    password: input.password,
    clientToken: randomUUID(),
    requestUser: true
  })

  const profiles = (auth.availableProfiles ?? []).map((p) => ({ id: p.id, name: p.name }))
  const selected = auth.selectedProfile ?? profiles[0]
  if (!selected) throw new Error('这个服务器没有返回角色（先去它的网站创建角色）')

  const account: Account = {
    id: randomUUID(),
    type: 'yggdrasil',
    name: selected.name,
    uuid: selected.id,
    accessToken: auth.accessToken,
    server: api
  }

  store.setAccounts([
    ...store.accounts.filter((a) => !(a.type === 'yggdrasil' && a.server === api && a.uuid === account.uuid)),
    account
  ])
  return { account, profiles }
}

function normalizeApi(apiRoot: string): string {
  const api = apiRoot.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(api)) throw new Error('API 根地址要以 http(s):// 开头')
  return api
}

/** 拉取某个外置账号下的角色列表 */
export async function listProfiles(accountId: string): Promise<{ id: string; name: string }[]> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'yggdrasil' || !account.server) return []
  const res = await fetch(`${account.server}/authserver/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, clientToken: randomUUID(), requestUser: true })
  })
  if (!res.ok) return [{ id: account.uuid, name: account.name }]
  const data = (await res.json()) as { availableProfiles?: { id: string; name: string }[] }
  return data.availableProfiles ?? [{ id: account.uuid, name: account.name }]
}

/** 切换角色：用 refresh + selectedProfile 换一个绑定到目标角色的令牌 */
export async function selectProfile(accountId: string, profile: { id: string; name: string }): Promise<Account> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'yggdrasil' || !account.server) throw new Error('不是外置登录账号')

  const clientToken = randomUUID()
  const res = await fetch(`${account.server}/authserver/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: account.accessToken, clientToken, selectedProfile: profile, requestUser: true })
  })
  if (!res.ok) throw new Error(`切换角色失败（HTTP ${res.status}）`)
  const data = (await res.json()) as { accessToken: string; selectedProfile?: { id: string; name: string } }

  const updated: Account = {
    ...account,
    accessToken: data.accessToken,
    uuid: data.selectedProfile?.id ?? profile.id,
    name: data.selectedProfile?.name ?? profile.name
  }
  store.setAccounts(store.accounts.map((a) => (a.id === account.id ? updated : a)))
  return updated
}

function describe(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } }
  return (err?.message ?? String(e)) + (err?.cause?.code ? ' ' + err.cause.code : '')
}

export interface SkinInfo {
  uuid: string
  name: string
  skinUrl?: string
  capeUrl?: string
  model?: 'slim' | 'steve'
  /** 查不到时的原因，界面直接显示 */
  error?: string
}

/** 查角色当前皮肤 / 披风（authlib-injector 的 sessionserver） */
interface RawProfile {
  id: string
  name: string
  /** 各家实现不一样：有的是 [{name,value}]，有的是 { textures: base64 } */
  properties?: { name: string; value: string }[] | Record<string, string>
}

/** 取出 textures 的 base64 值（兼容两种 properties 形态） */
function texturesValue(profile: RawProfile): string | undefined {
  const p = profile.properties
  if (Array.isArray(p)) return p.find((x) => x?.name === 'textures')?.value
  if (p && typeof p === 'object') return (p as Record<string, string>).textures
  return undefined
}

/** 直接打 Yggdrasil 的 profile 接口（不走库，失败原因能拿到） */
async function fetchProfile(apiRoot: string, uuid: string): Promise<RawProfile> {
  const id = uuid.replace(/-/g, '')
  const base = apiRoot.replace(/\/+$/, '')
  const url = `${base}/sessionserver/session/minecraft/profile/${id}`
  const res = await net.fetch(url, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as RawProfile
}

/**
 * 查皮肤：先走库（兼容更多第三方实现），失败再用原始接口兜底。
 * 这次不吞错误了——查不到就把原因带回去，界面能显示「没设皮肤」还是「查询失败」。
 */
export async function lookupSkin(accountId: string, uuid?: string): Promise<SkinInfo | undefined> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || !account.server) return undefined
  try {
    return await lookupSkinInner(account, uuid)
  } catch (e) {
    return { uuid: uuid || account.uuid, name: account.name, error: '查询皮肤失败：' + describe(e) }
  }
}

async function lookupSkinInner(account: Account, uuid?: string): Promise<SkinInfo> {
  const server = account.server as string
  const target = uuid || account.uuid
  const errors: string[] = []

  let profile: RawProfile | undefined
  try {
    const client = new YggdrasilThirdPartyClient(server)
    const p = (await client.lookup(target, true)) as unknown as RawProfile
    if (p?.id) profile = p
  } catch (e) {
    errors.push('库查询失败：' + describe(e))
  }
  if (!profile) {
    try {
      profile = await fetchProfile(server, target)
    } catch (e) {
      errors.push('接口查询失败：' + describe(e))
    }
  }
  if (!profile) {
    return { uuid: target, name: account.name, error: errors.join(' / ') || '查询不到角色信息' }
  }

  const texturesB64 = texturesValue(profile)
  if (!texturesB64) {
    return { uuid: profile.id, name: profile.name, error: '这个角色在皮肤站没有设置皮肤' }
  }
  try {
    const decoded = JSON.parse(Buffer.from(texturesB64, 'base64').toString('utf-8')) as {
      textures?: {
        SKIN?: { url: string; metadata?: { model?: string } }
        CAPE?: { url: string }
      }
    }
    const skinUrl = decoded.textures?.SKIN?.url
    if (!skinUrl) {
      return { uuid: profile.id, name: profile.name, capeUrl: decoded.textures?.CAPE?.url, error: '这个角色没有皮肤（只有披风）' }
    }
    return {
      uuid: profile.id,
      name: profile.name,
      skinUrl,
      capeUrl: decoded.textures?.CAPE?.url,
      model: decoded.textures?.SKIN?.metadata?.model === 'slim' ? 'slim' : 'steve'
    }
  } catch (e) {
    return { uuid: profile.id, name: profile.name, error: '皮肤数据解析失败：' + describe(e) }
  }
}

/** 上传 / 更换皮肤（filePath 指向本地 png） */
export async function uploadSkin(
  accountId: string,
  filePath: string,
  model: 'slim' | 'steve'
): Promise<void> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'yggdrasil' || !account.server) throw new Error('先登录外置账号')
  const data = new Uint8Array(fs.readFileSync(filePath))
  const client = new YggdrasilThirdPartyClient(account.server)
  await client.setTexture({
    accessToken: account.accessToken,
    uuid: account.uuid,
    type: 'skin',
    texture: { data, metadata: { model } }
  })
}

/** 上传 / 更换披风 */
export async function uploadCape(accountId: string, filePath: string): Promise<void> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'yggdrasil' || !account.server) throw new Error('先登录外置账号')
  const data = new Uint8Array(fs.readFileSync(filePath))
  const client = new YggdrasilThirdPartyClient(account.server)
  await client.setTexture({
    accessToken: account.accessToken,
    uuid: account.uuid,
    type: 'cape',
    texture: { data }
  })
}

/** 删除皮肤 / 披风 */
export async function clearTexture(accountId: string, type: 'skin' | 'cape'): Promise<void> {
  const account = store.accounts.find((a) => a.id === accountId)
  if (!account || account.type !== 'yggdrasil' || !account.server) throw new Error('先登录外置账号')
  const client = new YggdrasilThirdPartyClient(account.server)
  await client.setTexture({ accessToken: account.accessToken, uuid: account.uuid, type })
}

/** 解析 LittleSkin 那种「拖拽卡片」协议：authlib-injector:yggdrasil-server:<urlencoded> */
export function parseInjectorCard(text: string): string | undefined {
  const match = /authlib-injector:yggdrasil-server:(\S+)/i.exec(text.trim())
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

/** 刷新第三方登录令牌（过期时启动前调用） */
export async function refreshThirdParty(account: Account): Promise<Account | undefined> {
  if (account.type !== 'yggdrasil' || !account.server) return account
  try {
    const client = new YggdrasilThirdPartyClient(account.server)
    const auth = await client.refresh({ accessToken: account.accessToken, clientToken: randomUUID() })
    const updated: Account = {
      ...account,
      accessToken: auth.accessToken,
      name: auth.selectedProfile?.name ?? account.name,
      uuid: auth.selectedProfile?.id ?? account.uuid
    }
    store.setAccounts(store.accounts.map((a) => (a.id === account.id ? updated : a)))
    return updated
  } catch {
    return account
  }
}
