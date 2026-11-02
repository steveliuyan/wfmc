import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { store } from './store'
import { gamePathFor } from './paths'
import type { ProgressFn } from '../shared/types'

/**
 * 局域网「整包直传」：
 *
 * 房主开房间时，把「进这个房间需要的所有东西」——游戏版本文件（versions / libraries /
 * assets / natives）、模组、以及房主正在用的那个 Java 运行时——列成一份索引挂在同一个
 * HTTP 服务上。好友进服时如果本地缺东西，直接从房主机器拷，不走外网、不重新下载。
 *
 * 为什么值得做：版本文件和 Java 运行时都很大，国内直连 Mojang / 各种镜像经常断，
 * 而同一个路由器下互拷是最稳的。
 *
 * 只传「跑起来必需」的东西，日志 / 存档 / 截图 / 资源包一律不传。
 */

export interface PackEntry {
  /** 相对路径（game = 实例的 minecraft 目录，java = Java 运行时目录） */
  rel: string
  size: number
  /** 文件属于哪一侧 */
  src: 'game' | 'java'
}

export interface PackIndex {
  instanceId: string
  name: string
  mcVersion: string
  versionId: string
  loader: string
  loaderVersion?: string
  /** 房主用的 Java 运行时（可选） */
  java?: { component: string; major: number }
  files: PackEntry[]
  /** 所有文件大小之和 */
  total: number
  at: number
}

/** 白名单：只有这些一级目录里的东西才值得传 */
const GAME_DIRS = ['versions', 'libraries', 'assets', 'mods', 'natives', 'config', 'defaultconfigs']
/**
 * 这几个目录永远在**实例根目录**（`<实例>/minecraft/`）下面，不跟着「隔离存档」搬。
 * 开了隔离的实例，mods / config 在 `versions/<版本>/game/` 里，但
 * versions / libraries / assets 还在根上 —— 一律按 gamePathFor 取的话，
 * 房主的版本文件一个都进不了索引，好友那边就「游戏传不过来」。
 */
const ROOT_DIRS = new Set(['versions', 'libraries', 'assets'])

/** 索引里一条 rel 实际落在哪个根目录（房主侧打包、好友侧落盘、发送文件三处共用一套规则） */
function packRootFor(rel: string, sharedRoot: string, dataRoot: string) {
  const top = rel.split(/[\\/]/)[0]
  return ROOT_DIRS.has(top) ? sharedRoot : dataRoot
}
/** 黑名单：存档 / 日志 / 截图之类绝对不传 */
const SKIP_DIRS = new Set([
  'logs',
  'crash-reports',
  'saves',
  'screenshots',
  'shaderpacks',
  'resourcepacks',
  'backups',
  '.cache',
  'temp'
])

function walk(root: string, relBase: string, out: { rel: string; size: number }[], depth = 0) {
  if (depth > 8) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, relBase), { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const rel = relBase ? path.join(relBase, ent.name) : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name.toLowerCase())) continue
      walk(root, rel, out, depth + 1)
      continue
    }
    if (!ent.isFile()) continue
    try {
      const st = fs.statSync(path.join(root, rel))
      if (st.size <= 0) continue
      out.push({ rel, size: st.size })
    } catch {
      /* 读不到就跳过 */
    }
  }
}

/** 找这个实例用的 Java 运行时目录（在 <dataDir>/java 下面才算「我们能整包搬」的） */
function javaRuntimeOf(instance: { javaPath?: string }): { component: string; dir: string } | undefined {
  const javaDir = store.javaDir
  const candidates: string[] = []
  if (instance.javaPath) {
    const rel = path.relative(javaDir, instance.javaPath)
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) candidates.push(rel.split(/[\\/]/)[0])
  }
  try {
    for (const name of fs.readdirSync(javaDir)) {
      const full = path.join(javaDir, name)
      if (fs.statSync(full).isDirectory()) candidates.push(name)
    }
  } catch {
    /* 没有 java 目录 */
  }
  for (const component of candidates) {
    const dir = path.join(javaDir, component)
    const exe = process.platform === 'win32' ? path.join(dir, 'bin', 'java.exe') : path.join(dir, 'bin', 'java')
    if (fs.existsSync(exe)) return { component, dir }
  }
  return undefined
}

/** Mojang 的运行时组件名 → 大版本号 */
function javaMajorOf(component: string, mcVersion: string): number {
  if (component.includes('delta')) return 21
  if (component.includes('gamma')) return 17
  if (component.includes('beta')) return 16
  if (component.includes('legacy')) return 8
  const m = /^1\.(\d+)/.exec(mcVersion)
  return m ? Number(m[1]) : 21
}

/** 生成「这个实例进服所需要的文件」索引（房主侧调用） */
export function buildPackIndex(instanceId: string): PackIndex | undefined {
  const instance = store.getInstance(instanceId)
  if (!instance) return undefined
  const gameDir = gamePathFor(instance)
  if (!fs.existsSync(gameDir)) return undefined
  const rootDir = store.instanceGameDir(instanceId)

  const files: PackEntry[] = []
  for (const dir of GAME_DIRS) {
    const root = ROOT_DIRS.has(dir) ? rootDir : gameDir
    if (!fs.existsSync(path.join(root, dir))) continue
    const rows: { rel: string; size: number }[] = []
    walk(root, dir, rows)
    for (const r of rows) files.push({ rel: r.rel, size: r.size, src: 'game' })
  }

  let java: PackIndex['java']
  const rt = javaRuntimeOf(instance)
  if (rt) {
    const rows: { rel: string; size: number }[] = []
    walk(rt.dir, '', rows)
    for (const r of rows) files.push({ rel: r.rel, size: r.size, src: 'java' })
    java = { component: rt.component, major: javaMajorOf(rt.component, instance.mcVersion) }
  }

  const total = files.reduce((n, f) => n + f.size, 0)
  return {
    instanceId,
    name: instance.name,
    mcVersion: instance.mcVersion,
    versionId: instance.versionId || instance.mcVersion,
    loader: instance.loader ?? 'vanilla',
    loaderVersion: instance.loaderVersion,
    java,
    files,
    total,
    at: Date.now()
  }
}

/* ------------------------------------------------------------------ *
 * 房主侧：把索引和文件挂到 HTTP 上
 * ------------------------------------------------------------------ */

function sendJson(res: http.ServerResponse, code: number, body: unknown) {
  const text = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  })
  res.end(text)
}

/**
 * 处理 /pack/* 请求；返回 false 表示「不是我的路由」。
 * 用索引下标取文件（不拼路径），天然免疫目录穿越。
 */
export function servePack(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  getIndex: () => PackIndex | undefined
): boolean {
  if (!pathname.startsWith('/pack/')) return false
  const index = getIndex()
  if (!index) {
    sendJson(res, 500, { error: 'no pack' })
    return true
  }
  if (pathname === '/pack/index.json' || pathname === '/pack/') {
    sendJson(res, 200, index)
    return true
  }
  const m = /^\/pack\/f\/(\d+)$/.exec(pathname)
  if (!m) {
    sendJson(res, 404, { error: 'not found' })
    return true
  }
  const entry = index.files[Number(m[1])]
  if (!entry) {
    sendJson(res, 404, { error: 'no such file' })
    return true
  }
  const instance = store.getInstance(index.instanceId)
  const root =
    entry.src === 'java'
      ? path.join(store.javaDir, index.java?.component ?? '')
      : instance
        ? packRootFor(entry.rel, store.instanceGameDir(instance.id), gamePathFor(instance))
        : ''
  if (!root) {
    sendJson(res, 500, { error: 'no root' })
    return true
  }
  const full = path.join(root, entry.rel)
  if (!fs.existsSync(full)) {
    sendJson(res, 404, { error: 'missing on host' })
    return true
  }
  const size = fs.statSync(full).size
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''))
  if (range) {
    const start = Number(range[1])
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    if (start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` })
      res.end()
      return true
    }
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*'
    })
    fs.createReadStream(full, { start, end }).pipe(res)
    return true
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  })
  fs.createReadStream(full).pipe(res)
  return true
}

/* ------------------------------------------------------------------ *
 * 好友侧：从房主机器整包拉下来
 * ------------------------------------------------------------------ */

export interface PullResult {
  ok: boolean
  message: string
  downloaded: number
  skipped: number
  failed: string[]
}

function fetchJsonTimeout<T>(url: string, ms: number): Promise<T> {
  return fetch(url, { signal: AbortSignal.timeout(ms) }).then(async (r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return (await r.json()) as T
  })
}

/** 带 Range 续传的单文件下载（.wfmcpart 临时文件，下完再改名） */
async function fetchToLocal(url: string, dest: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = dest + '.wfmcpart'
  let attempt = 0
  for (;;) {
    attempt++
    let have = 0
    try {
      have = fs.statSync(tmp).size
    } catch {
      have = 0
    }
    try {
      const headers: Record<string, string> = {}
      if (have > 0) headers.Range = 'bytes=' + have + '-'
      const res = await fetch(url, { headers, signal })
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status)
      if (have > 0 && res.status === 200) {
        have = 0 // 服务端不支持续传，从头写
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* 忽略 */
        }
      }
      const expect = Number(res.headers.get('content-length') ?? 0)
      await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(tmp, { flags: 'a' }))
      const finalSize = fs.statSync(tmp).size
      if (expect > 0 && finalSize !== have + expect) throw new Error('incomplete')
      fs.renameSync(tmp, dest)
      return
    } catch (e) {
      if (signal?.aborted) throw e
      if (attempt >= 3) {
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* 忽略 */
        }
        throw e
      }
      await new Promise((r) => setTimeout(r, 400 * attempt))
    }
  }
}

/**
 * 从房主的机器上把「版本文件 + 模组 + Java 运行时」整包拷到本地实例里。
 * 只补缺的（大小一致的直接跳过），已在本地的不重复传。
 */
export async function pullPack(opts: {
  baseUrl: string
  instanceId: string
  onProgress?: ProgressFn
  signal?: AbortSignal
}): Promise<PullResult> {
  const { baseUrl, instanceId, onProgress, signal } = opts
  const instance = store.getInstance(instanceId)
  if (!instance) return { ok: false, message: '本地没有这个实例', downloaded: 0, skipped: 0, failed: [] }

  const index = await fetchJsonTimeout<PackIndex>(baseUrl + '/pack/index.json', 8000)
  if (!index?.files?.length) return { ok: false, message: '房主没有开整包直传', downloaded: 0, skipped: 0, failed: [] }
  if (index.mcVersion !== instance.mcVersion || (index.loader ?? 'vanilla') !== (instance.loader ?? 'vanilla')) {
    return {
      ok: false,
      message: '房主的房间是 ' + index.mcVersion + ' / ' + (index.loader || 'vanilla') + '，和本地实例对不上',
      downloaded: 0,
      skipped: 0,
      failed: []
    }
  }

  const gameRoot = gamePathFor(instance)
  const sharedRoot = store.instanceGameDir(instanceId)
  const javaRoot = index.java ? path.join(store.javaDir, index.java.component) : ''
  const todo: { url: string; dest: string; size: number; rel: string }[] = []
  let skipped = 0

  index.files.forEach((f, i) => {
    // 和房主侧同一套规则：versions / libraries / assets 落实例根目录，
    // 其余（mods / config…）落 gamePathFor —— 隔离实例两边才都能对得上
    const top = f.rel.split(/[\\/]/)[0]
    const root = f.src === 'java' ? javaRoot : packRootFor(top, sharedRoot, gameRoot)
    if (!root) return
    const dest = path.join(root, f.rel)
    let same = false
    try {
      same = fs.statSync(dest).size === f.size
    } catch {
      same = false
    }
    if (same) {
      skipped++
      return
    }
    todo.push({ url: baseUrl + '/pack/f/' + i, dest, size: f.size, rel: f.rel })
  })

  const totalBytes = todo.reduce((n, t) => n + t.size, 0)
  const totalCount = todo.length
  let doneBytes = 0
  let doneCount = 0
  const failed: string[] = []
  const started = Date.now()

  const report = (detail: string) =>
    onProgress?.({
      key: 'lan-pull',
      phase: '从房主拷文件',
      current: doneBytes,
      total: totalBytes,
      detail
    })

  report('0 / ' + Math.round(totalBytes / 1048576) + ' MB')
  const queue = todo.slice()
  const worker = async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      if (signal?.aborted) return
      try {
        await fetchToLocal(item.url, item.dest, signal)
        doneCount++
        doneBytes += item.size
      } catch {
        failed.push(item.rel)
      }
      const mb = Math.round(doneBytes / 1048576)
      report(
        mb +
          ' / ' +
          Math.round(totalBytes / 1048576) +
          ' MB（' +
          doneCount +
          '/' +
          totalCount +
          ' 个文件，' +
          Math.round((Date.now() - started) / 1000) +
          's）'
      )
    }
  }
  await Promise.all([worker(), worker(), worker()])

  // Java 运行时拷过来了就把实例指过去，省得它再去 Mojang 下
  if (index.java) {
    const exe = process.platform === 'win32' ? path.join(javaRoot, 'bin', 'java.exe') : path.join(javaRoot, 'bin', 'java')
    if (fs.existsSync(exe)) {
      try {
        store.saveInstance({ ...instance, javaPath: exe })
      } catch {
        /* 忽略 */
      }
    }
  }

  // 版本 json 到位了就算装好了（和 store.listInstances 的判断保持一致）。
  // 另外把 versionId 对齐成房主用的那个：好友建实例时按「最新稳定版加载器」建的，
  // 房主那份可能是老一点的加载器版本，指错了就会启动失败。
  const vId = index.versionId || instance.versionId || instance.mcVersion
  if (fs.existsSync(path.join(sharedRoot, 'versions', vId, vId + '.json'))) {
    try {
      const cur = store.getInstance(instanceId)
      if (cur) store.saveInstance({ ...cur, versionId: vId, loaderVersion: index.loaderVersion ?? cur.loaderVersion, installed: true })
    } catch {
      /* 忽略 */
    }
  }

  return {
    ok: failed.length === 0,
    message: failed.length
      ? '有 ' + failed.length + ' 个文件没拷成功（可以在实例上点「校验文件」重试）'
      : '已从房主拷好',
    downloaded: doneCount,
    skipped,
    failed
  }
}
