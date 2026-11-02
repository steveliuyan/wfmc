import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { downloadFile } from './net'
import { buildPackIndex, servePack, type PackIndex } from './lanshare'

/**
 * 服务端环境同步：
 * 主机侧开一个极小的 HTTP 服务，暴露「这个服需要哪些 mod」（sha1 + 文件名），
 * 并允许直接下载 mod 文件；客户端进服前先对比，缺什么自动补什么。
 */

export interface ModRef {
  file: string
  sha1: string
  size: number
}

export interface ServerManifest {
  name: string
  mcVersion: string
  loader: string
  loaderVersion?: string
  gamePort: number
  /** 服务端 mods 清单 */
  mods: ModRef[]
  /** 清单生成时间 */
  at: number
  /** 客户端可用这个前缀直接下 mod */
  base?: string
  /** 房主是否开了「整包直传」（游戏文件 + 模组 + Java 运行时，好友可以直接拷贝） */
  pack?: boolean
}

function serverDir(id: string): string {
  return path.join(store.dataDir, 'servers', id)
}

function sha1File(file: string): { sha1: string; size: number } {
  const buf = fs.readFileSync(file)
  return { sha1: crypto.createHash('sha1').update(buf).digest('hex'), size: buf.length }
}

/** 读服务端自己目录生成清单 */
export function buildManifest(id: string): ServerManifest | undefined {
  const metaFile = path.join(serverDir(id), 'hosted-server.json')
  if (!fs.existsSync(metaFile)) return undefined
  const server = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as {
    name: string
    mcVersion: string
    kind: string
    loaderVersion?: string
    port: number
  }
  const modsDir = path.join(serverDir(id), 'mods')
  const mods: ModRef[] = []
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      const full = path.join(modsDir, name)
      try {
        const { sha1, size } = sha1File(full)
        mods.push({ file: name, sha1, size })
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  return {
    name: server.name,
    mcVersion: server.mcVersion,
    loader: server.kind,
    loaderVersion: server.loaderVersion,
    gamePort: server.port,
    mods,
    at: Date.now()
  }
}

const running = new Map<string, { server: http.Server; port: number }>()

/** 清单 HTTP 处理器：暴露 /manifest.json、/mods/<文件名>、/pack/*（整包直传），其它 404（每次请求重算，改了 mod 立刻生效） */
function manifestHandler(
  getManifest: () => ServerManifest | undefined,
  getModsDir: () => string,
  getPack?: () => PackIndex | undefined
): http.RequestListener {
  return (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (getPack && url.startsWith('/pack/') && servePack(req, res, url, getPack)) return
    const fresh = getManifest()
    if (!fresh) {
      res.writeHead(500).end('no manifest')
      return
    }
    if (url === '/manifest.json' || url === '/') {
      const body = JSON.stringify({ ...fresh, base: `http://${req.headers.host ?? ''}` })
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' })
      res.end(body)
      return
    }
    if (url.startsWith('/mods/')) {
      const name = path.basename(url.slice('/mods/'.length))
      const full = path.join(getModsDir(), name)
      if (!fs.existsSync(full)) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fs.statSync(full).size,
        'Access-Control-Allow-Origin': '*'
      })
      fs.createReadStream(full).pipe(res)
      return
    }
    res.writeHead(404).end('not found')
  }
}

/** 依次在这些端口上试监听，全占用就用系统分配（0） */
async function listenFirst(
  candidates: number[],
  handler: http.RequestListener
): Promise<{ server: http.Server; port: number } | undefined> {
  for (const port of candidates) {
    const server = http.createServer(handler)
    const ok = await new Promise<number | undefined>((resolve) => {
      server.once('error', () => resolve(undefined))
      server.listen(port, '0.0.0.0', () => {
        const addr = server.address() as AddressInfo
        resolve(addr.port)
      })
    })
    if (ok) return { server, port: ok }
    server.close()
  }
  return undefined
}

/**
 * 起清单服务：优先用「游戏端口 + 1」，被占用就往后试几个。
 * 只暴露 manifest.json 与 mods/ 下的文件，其它一律 404。
 */
export async function startManifestServer(id: string): Promise<{ port: number; mods: number } | undefined> {
  if (running.has(id)) {
    const cur = running.get(id)!
    return { port: cur.port, mods: buildManifest(id)?.mods.length ?? 0 }
  }
  const manifest = buildManifest(id)
  if (!manifest) return undefined

  const handler = manifestHandler(
    () => buildManifest(id),
    () => path.join(serverDir(id), 'mods')
  )
  const started = await listenFirst([manifest.gamePort + 1, manifest.gamePort + 2, manifest.gamePort + 3, 0], handler)
  if (!started) return undefined
  running.set(id, started)
  return { port: started.port, mods: manifest.mods.length }
}

export function stopManifestServer(id: string): void {
  const cur = running.get(id)
  if (!cur) return
  try {
    cur.server.close()
  } catch {
    /* 忽略 */
  }
  running.delete(id)
}

export function manifestPort(id: string): number | undefined {
  return running.get(id)?.port
}

/* ------------------------------------------------------------------ *
 * 房主侧（客户端实例）：在游戏里「对局域网开放」之后，
 * 立刻用「局域网端口 + 1」把这个实例的 mod 清单也发出去，
 * 好友在联机页就能看到版本/加载器，点「进入」还能自动补齐 mod。
 * ------------------------------------------------------------------ */

const runningInstances = new Map<string, { server: http.Server; port: number }>()

/** 用客户端实例（不是服务端）生成清单 */
export function buildInstanceManifest(instanceId: string): ServerManifest | undefined {
  const instance = store.getInstance(instanceId)
  if (!instance) return undefined
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const mods: ModRef[] = []
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      try {
        const full = path.join(modsDir, name)
        const { sha1, size } = sha1File(full)
        mods.push({ file: name, sha1, size })
      } catch {
        /* 读不了就跳过 */
      }
    }
  }
  return {
    name: instance.name,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    loaderVersion: instance.loaderVersion,
    gamePort: 0,
    mods,
    at: Date.now(),
    // 本地有游戏目录就能整包直传（好友缺版本文件 / Java 时直接从这里拷）
    pack: fs.existsSync(gamePathFor(instance))
  }
}

/**
 * 给「对局域网开放」的房间发布清单。
 * preferredPort 一般是游戏局域网端口 + 1（主机侧探测规则就是 +1/+2/+3）。
 *
 * 注意：端口变了要真的搬过去。原来「已经在跑就直接返回旧端口」，结果游戏换了个
 * 端口开房间后，好友按新端口探过来永远探不到清单。
 */
export async function startInstanceManifest(
  instanceId: string,
  preferredPort: number
): Promise<{ port: number; mods: number } | undefined> {
  if (runningInstances.has(instanceId)) {
    const cur = runningInstances.get(instanceId)!
    const want = preferredPort || 0
    if (!want || cur.port === want) {
      return { port: cur.port, mods: buildInstanceManifest(instanceId)?.mods.length ?? 0 }
    }
    stopInstanceManifest(instanceId)
  }
  const manifest = buildInstanceManifest(instanceId)
  if (!manifest) return undefined
  const instance = store.getInstance(instanceId)!
  // 整包索引比较重（要走一遍几十万个文件），一次请求算一次太浪费：缓存 60 秒
  let cached: { index?: PackIndex; at: number } = { at: 0 }
  const getPack = () => {
    const now = Date.now()
    if (now - cached.at > 60_000) {
      cached = { index: buildPackIndex(instanceId), at: now }
    }
    return cached.index
  }
  const handler = manifestHandler(
    () => buildInstanceManifest(instanceId),
    () => path.join(gamePathFor(instance), 'mods'),
    () => getPack()
  )
  const started = await listenFirst([preferredPort, preferredPort + 1, preferredPort + 2, 0], handler)
  if (!started) return undefined
  runningInstances.set(instanceId, started)
  return { port: started.port, mods: manifest.mods.length }
}

export function stopInstanceManifest(instanceId: string): void {
  const cur = runningInstances.get(instanceId)
  if (!cur) return
  try {
    cur.server.close()
  } catch {
    /* 忽略 */
  }
  runningInstances.delete(instanceId)
}

export function instanceManifestPort(instanceId: string): number | undefined {
  return runningInstances.get(instanceId)?.port
}

/* ------------------------------------------------------------------ *
 * 客户端：拉清单 + 对比 + 补齐
 * ------------------------------------------------------------------ */

export async function fetchManifest(baseUrl: string): Promise<ServerManifest> {
  const url = baseUrl.replace(/\/+$/, '') + '/manifest.json'
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as ServerManifest
}

/** 猜清单地址：游戏端口 +1 / +2 / +3 都试一遍（主机侧就是这么挑端口的） */
export async function discoverManifest(
  host: string,
  gamePort: number
): Promise<{ manifest: ServerManifest; base: string } | undefined> {
  // 三个端口并发试：串行最坏要 3×6 秒，联机页探一排世界会等到天荒地老
  const ports = [gamePort + 1, gamePort + 2, gamePort + 3].filter((p) => p > 0 && p <= 65535)
  const results = await Promise.all(
    ports.map(async (p) => {
      const base = `http://${host}:${p}`
      try {
        const manifest = await fetchManifest(base)
        if (manifest && Array.isArray(manifest.mods)) return { manifest, base }
      } catch {
        /* 这个端口没服务 */
      }
      return undefined
    })
  )
  return results.find((r) => r !== undefined)
}

export interface EnvDiff {
  reachable: boolean
  manifest?: ServerManifest
  base?: string
  /** 本地缺的 mod（需要下载） */
  missing: ModRef[]
  /** 本地多出来的 mod（会导致进不去，需要提示但可一键禁用） */
  extra: string[]
  versionMismatch?: { server: string; client: string }
  loaderMismatch?: { server: string; client: string }
}

/** 对比本地实例与该服务端环境 */
export function compareEnvironment(instanceId: string, manifest: ServerManifest, base: string): EnvDiff {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const diff: EnvDiff = { reachable: true, manifest, base, missing: [], extra: [] }

  if (instance.mcVersion !== manifest.mcVersion) {
    diff.versionMismatch = { server: manifest.mcVersion, client: instance.mcVersion }
  }
  if (manifest.loader && manifest.loader !== 'vanilla' && instance.loader !== manifest.loader) {
    // Quilt 客户端可以进 Fabric 服，不当作不匹配
    if (!(instance.loader === 'quilt' && manifest.loader === 'fabric')) {
      diff.loaderMismatch = { server: manifest.loader, client: instance.loader }
    }
  }

  const modsDir = path.join(gamePathFor(instance), 'mods')
  const local = new Map<string, string>() // sha1 -> file
  if (fs.existsSync(modsDir)) {
    for (const name of fs.readdirSync(modsDir)) {
      if (!name.toLowerCase().endsWith('.jar')) continue
      try {
        local.set(sha1File(path.join(modsDir, name)).sha1, name)
      } catch {
        /* 跳过 */
      }
    }
  }

  for (const mod of manifest.mods) {
    if (!local.has(mod.sha1)) diff.missing.push(mod)
  }

  const serverHashes = new Set(manifest.mods.map((m) => m.sha1))
  for (const [hash, file] of local) {
    if (!serverHashes.has(hash)) diff.extra.push(file)
  }
  return diff
}

/** 把缺的 mod 从主机拉下来（装完就能进服） */
export async function syncEnvironment(
  instanceId: string,
  diff: EnvDiff,
  onProgress?: ProgressFn
): Promise<{ added: number; failed: string[]; stillMissing: string[] }> {
  const instance = store.getInstance(instanceId)
  if (!instance || !diff.manifest || !diff.base) throw new Error('缺少同步信息')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  fs.mkdirSync(modsDir, { recursive: true })

  const failed: string[] = []
  let added = 0
  let index = 0
  const base = diff.base

  /**
   * 下完必须验一遍 sha1/大小。
   * 以前只要 downloadFile 没抛异常就算成功 —— 但局域网里经常出现「文件写下去了、
   * 内容缺一截」（房主那边正好在改 mod、连接被掐、磁盘满）：
   * 文件躺在 mods/ 里、sha1 对不上，Fabric/Forge 会**静默跳过**它，
   * 玩家看到的就是「模组装了但游戏里不生效 / 别人的方块我这儿看不见」。
   */
  const fetchVerified = async (mod: ModRef, dest: string, attempt = 1): Promise<void> => {
    await downloadFile(`${base}/mods/${encodeURIComponent(mod.file)}`, dest, undefined, { skipIfExists: false })
    let ok = false
    try {
      const got = sha1File(dest)
      ok = got.size === mod.size && got.sha1 === mod.sha1
    } catch {
      ok = false
    }
    if (ok) return
    try {
      fs.unlinkSync(dest)
    } catch {
      /* 删不掉就覆盖写 */
    }
    if (attempt >= 2) throw new Error('文件校验不通过')
    await fetchVerified(mod, dest, attempt + 1)
  }

  for (const mod of diff.missing) {
    index++
    onProgress?.({
      key: 'env-sync',
      phase: `下载缺失模组 ${index}/${diff.missing.length}：${mod.file}`,
      current: index - 1,
      total: diff.missing.length
    })
    try {
      await fetchVerified(mod, path.join(modsDir, mod.file))
      added++
    } catch {
      failed.push(mod.file)
    }
  }

  // 再对一遍账：真的少了什么就说清楚，别拿「已自动补齐 N 个」糊弄过去
  let stillMissing: string[] = []
  try {
    stillMissing = compareEnvironment(instanceId, diff.manifest, base).missing.map((m) => m.file)
  } catch {
    stillMissing = failed.slice()
  }

  onProgress?.({
    key: 'env-sync',
    phase: stillMissing.length ? `补齐完成（还缺 ${stillMissing.length} 个）` : `补齐完成（${added} 个）`,
    current: diff.missing.length,
    total: diff.missing.length
  })
  return { added, failed, stillMissing }
}
