import { net, session } from 'electron'

/**
 * 应用代理设置。
 * 支持 http://host:port、socks5://host:port；
 * 留空 = 跟随系统代理（Windows「Internet 选项」/ VPN 客户端设置的代理）；
 * 填 direct = 强制直连（并清掉旧代理）。
 *
 * 注意：以前「留空」是强制直连，结果用户开了系统代理（VPN）也没生效，
 * 表现为元数据接口一直超时。改成跟随系统更符合直觉。
 */
export async function applyProxy(proxy: string): Promise<void> {
  const value = (proxy ?? '').trim()
  try {
    const ses = session.defaultSession
    if (!value) {
      await ses.setProxy({ mode: 'system' })
      return
    }
    if (/^direct$/i.test(value)) {
      await ses.setProxy({ mode: 'direct' })
      return
    }
    // 允许用户只填 127.0.0.1:7890
    const rules = /^[a-z0-9+]+:\/\//i.test(value) ? value : `http://${value}`
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
  } catch {
    /* 代理设置失败不影响启动器本体 */
  }
}

/**
 * 文件下载专用的「直连」会话。
 *
 * 为什么要单独一路：实测这台机器上
 *   · 元数据（launchermeta / api.modrinth）直连会超时，必须走代理；
 *   · 文件（piston-data / cdn.modrinth）走代理只有 20~60KB/s，直连 32 并发能到 2MB/s。
 * 所以元数据走代理、文件走直连才是最快的。这里固定 direct，不受系统代理影响。
 */
let directSessionRef: Electron.Session | undefined

function directSession(): Electron.Session {
  if (!directSessionRef) {
    directSessionRef = session.fromPartition('wfmc-direct-dl', { cache: false })
    // 用 setProxy 固定直连；失败也无所谓，最差是继承系统代理
    void directSessionRef.setProxy({ mode: 'direct' }).catch(() => undefined)
  }
  return directSessionRef
}

/** 走直连（忽略系统代理）的 fetch，只用于下载文件本体 */
export function directFetch(input: string, init?: RequestInit): Promise<Response> {
  const opts = { ...(init ?? {}), session: directSession() } as unknown as Parameters<typeof net.fetch>[1]
  return net.fetch(input, opts) as unknown as Promise<Response>
}

/**
 * 下载用的 fetch：按域名分流「直连」还是「走代理」。
 *
 * 实测（这台机器，同一条宽带，同一个 7.2MB 文件）：
 *   · cdn.modrinth.com   直连 8 线程 38KB/s（单线程 19KB/s），走代理 8 线程 ~180KB/s；
 *   · piston-data.mojang 直连 32 线程 2.1MB/s，走代理 8 线程只有 491KB/s；
 *   · launchermeta / api.modrinth 直连直接超时（connect ETIMEDOUT），只能走代理。
 * 所以是「按域名分流」而不是全局一刀切：被墙/被限速的站点走代理，Mojang 文件走直连。
 * 留空代理时系统本身直连，走代理 = 直连，不会多绕一圈。
 */
const PROXY_HOSTS = [
  /(^|\.)modrinth\.com$/,
  /(^|\.)forgecdn\.net$/,
  /(^|\.)curseforge\.com$/,
  /(^|\.)github\.com$/,
  /(^|\.)githubusercontent\.com$/,
  /(^|\.)gitlab\.com$/,
  // 这几个只提供元数据，直连在墙内是不通的
  /^launchermeta\.mojang\.com$/,
  /^launcher\.mojang\.com$/,
  /^piston-meta\.mojang\.com$/,
  /^launchercontent\.mojang\.com$/
]

let preferProxy = process.env.WFMC_FORCE_PROXY === '1'
/** 直连失败过的域名 → 之后直接走代理，别每条连接都去撞一次 */
const directFails = new Map<string, number>()
/**
 * 直连失败的「惩罚期」：只在这段时间内强制走代理。
 * 不能永久记住 —— 实测过一次网络拥堵（同时跑了好几个测试进程），
 * piston-data 直连连续超时被永久拉黑，结果后面整个客户端下载都去挤代理的
 * 50KB/s，明明直连能跑到 500KB/s。所以给个有效期，过期重新试直连。
 */
const PROXY_ONLY_TTL_MS = 900_000
const proxyOnlyHosts = new Map<string, number>()

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function proxyOnly(host: string): boolean {
  const until = proxyOnlyHosts.get(host)
  if (!until) return false
  if (until > Date.now()) return true
  proxyOnlyHosts.delete(host)
  directFails.delete(host)
  return false
}

function needsProxy(url: string): boolean {
  const h = hostOf(url)
  return h !== '' && PROXY_HOSTS.some((re) => re.test(h))
}

/**
 * 传输层「这条线路不行」的反馈：连接建立成功、但读 body 卡住/极慢。
 * 这种情况 dlFetch 的 catch 是看不到的（请求已经成功返回 206 了），
 * 所以要由调用方（fastdl）在掐断连接后显式上报 —— 否则会反复去撞同一条死路。
 */
export function noteTransferProblem(url: string): void {
  const host = hostOf(url)
  if (!host) return
  if (proxyOnly(host)) return
  const n = (directFails.get(host) ?? 0) + 1
  directFails.set(host, n)
  if (n >= 2) proxyOnlyHosts.set(host, Date.now() + PROXY_ONLY_TTL_MS)
}

export async function dlFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const host = hostOf(url)
  if (preferProxy || needsProxy(url) || (host !== '' && proxyOnly(host))) return fetch(url, init)
  try {
    const r = await directFetch(url, init)
    if (host) directFails.set(host, 0)
    return r
  } catch (e) {
    if (init.signal?.aborted) throw e
    const n = (directFails.get(host) ?? 0) + 1
    directFails.set(host, n)
    if (n >= 2 && host) proxyOnlyHosts.set(host, Date.now() + PROXY_ONLY_TTL_MS)
    throw e
  }
}

/**
 * 把主进程里的全局 fetch 换成 Electron 的网络栈（Chromium）。
 *
 * 为什么要换：Node 自带（undici）的 fetch 只认 HTTP_PROXY / HTTPS_PROXY 这类
 * 环境变量，不认「设置 - 代理」里填的代理，也不认 Windows 系统代理。用户机器上
 * 只要残留了 *_proxy 环境变量（VPN、旧代理工具、某些加速器都会留），所有
 * Modrinth / CurseForge 请求都会去连那个早就关掉的本地端口，界面上的表现就是
 * 「网络连不上（可能被墙或超时）」——但浏览器明明打得开。
 *
 * 换成 Chromium 之后：设置里的代理（applyProxy）、Windows 系统代理、系统证书全都
 * 生效，AbortSignal、Range 分片、流式读取也都支持。启动后（app ready）调一次即可。
 */
export function installChromiumFetch(): void {
  const g = globalThis as unknown as { fetch: typeof fetch }
  g.fetch = ((input: unknown, init?: unknown) => net.fetch(input as never, init as never)) as typeof fetch
}