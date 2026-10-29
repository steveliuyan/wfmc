import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { downloadFile } from './net'

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

  const handler: http.RequestListener = (req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0])
    const fresh = buildManifest(id)
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
      const full = path.join(serverDir(id), 'mods', name)
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

  const candidates = [manifest.gamePort + 1, manifest.gamePort + 2, manifest.gamePort + 3, 0]
  for (const port of candidates) {
    const server = http.createServer(handler)
    const ok = await new Promise<number | undefined>((resolve) => {
      server.once('error', () => resolve(undefined))
      server.listen(port, '0.0.0.0', () => {
        const addr = server.address() as AddressInfo
        resolve(addr.port)
      })
    })
    if (ok) {
      running.set(id, { server, port: ok })
      return { port: ok, mods: manifest.mods.length }
    }
    server.close()
  }
  return undefined
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
  for (const p of [gamePort + 1, gamePort + 2, gamePort + 3]) {
    try {
      const base = `http://${host}:${p}`
      const manifest = await fetchManifest(base)
      if (manifest && Array.isArray(manifest.mods)) return { manifest, base }
    } catch {
      /* 试下一个 */
    }
  }
  return undefined
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
): Promise<{ added: number; failed: string[] }> {
  const instance = store.getInstance(instanceId)
  if (!instance || !diff.manifest || !diff.base) throw new Error('缺少同步信息')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  fs.mkdirSync(modsDir, { recursive: true })

  const failed: string[] = []
  let added = 0
  let index = 0
  for (const mod of diff.missing) {
    index++
    onProgress?.({
      key: 'env-sync',
      phase: `下载缺失模组 ${index}/${diff.missing.length}：${mod.file}`,
      current: index - 1,
      total: diff.missing.length
    })
    try {
      await downloadFile(`${diff.base}/mods/${encodeURIComponent(mod.file)}`, path.join(modsDir, mod.file), undefined, {
        skipIfExists: false
      })
      added++
    } catch {
      failed.push(mod.file)
    }
  }
  onProgress?.({ key: 'env-sync', phase: `补齐完成（${added} 个）`, current: diff.missing.length, total: diff.missing.length })
  return { added, failed }
}
