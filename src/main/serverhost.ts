import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { startManifestServer, stopManifestServer } from './serversync'
import { downloadAll, downloadFile, fetchJson, fetchText, sources } from './net'
import { ensureJava, requiredJavaMajor } from './java'
import { listRemoteVersions } from './minecraft'
import { collectDirFiles, extractZipPrefixes, readFileInsideZip, writeZip } from './zip'

export type ServerKind = 'vanilla' | 'paper' | 'fabric' | 'forge' | 'neoforge'

export interface HostedServer {
  id: string
  name: string
  kind: ServerKind
  mcVersion: string
  build?: number
  memoryMb: number
  port: number
  eulaAccepted: boolean
  createdAt: number
  /** jar 文件名 */
  jarFile: string
  /** Forge/NeoForge 那种用 args 文件启动的服务器 */
  launchArgs?: string[]
  /** 加载器版本（fabric 用） */
  loaderVersion?: string
}

interface RunningServer {
  proc: ChildProcess
  startedAt: number
  logs: string[]
}

/** 版本列表缓存：进页面秒开，10 分钟内不重复请求 */
const versionCache = new Map<string, { at: number; data: unknown }>()

const runningHosted = new Map<string, RunningServer>()
const hostedLogs = new Map<string, string[]>()

function serversRoot() {
  return path.join(store.dataDir, 'servers')
}

function serverDir(id: string) {
  return path.join(serversRoot(), id)
}

function metaFile(id: string) {
  return path.join(serverDir(id), 'hosted-server.json')
}

export function listHostedServers(): HostedServer[] {
  const root = serversRoot()
  if (!fs.existsSync(root)) return []
  const out: HostedServer[] = []
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, 'hosted-server.json')
    if (!fs.existsSync(file)) continue
    try {
      out.push(JSON.parse(fs.readFileSync(file, 'utf-8')))
    } catch {
      /* 跳过损坏项 */
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

function saveHosted(server: HostedServer) {
  fs.mkdirSync(serverDir(server.id), { recursive: true })
  fs.writeFileSync(metaFile(server.id), JSON.stringify(server, null, 2), 'utf-8')
}

export function getHosted(id: string): HostedServer | undefined {
  return listHostedServers().find((s) => s.id === id)
}

/**
 * Paper 支持的 MC 版本。
 * 用的是 PaperMC 新版 v3 API（老的 /v2 已经返回 410 Gone）。
 */
export async function listPaperVersions(): Promise<string[]> {
  const cachedPaper = versionCache.get('p:all')
  if (cachedPaper && Date.now() - cachedPaper.at < 10 * 60 * 1000) return cachedPaper.data as string[]
  try {
    const res = await fetchJson<{ versions: Record<string, string[]> }>(
      'https://fill.papermc.io/v3/projects/paper',
      { headers: { 'User-Agent': 'WFMC/1.0 (Minecraft Launcher)' } } as never
    )
    // versions 是按大版本分组的对象，拍平后按数值倒序
    const flat = Object.values(res.versions ?? {}).flat()
    return flat.sort((a, b) => {
      const pa = a.split(/[.-]/).map((n) => Number(n) || 0)
      const pb = b.split(/[.-]/).map((n) => Number(n) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0)
        if (d !== 0) return d
      }
      return 0
    })
  } catch {
    return []
  }
}

async function downloadVanillaServer(mcVersion: string, dest: string, onProgress?: ProgressFn) {
  const mirror = store.settings.downloadSource === 'mirror'
  const src = sources(mirror)
  const versions = await listRemoteVersions()
  const meta = versions.find((v) => v.id === mcVersion)
  if (!meta) throw new Error(`没有 ${mcVersion} 这个版本`)
  const json = await fetchJson<{ downloads?: { server?: { url: string } } }>(meta.url)
  const official = json.downloads?.server?.url
  const urls = [
    ...(mirror ? [`https://bmclapi2.bangbang93.com/version/${mcVersion}/server`] : []),
    ...(official ? [official] : [])
  ]
  if (urls.length === 0) throw new Error('该版本没有官方服务端（太老的版本需要用 Forge/第三方服务端）')
  onProgress?.({ key: 'server-jar', phase: '下载服务端 server.jar', current: 0, total: 1 })
  await downloadFile(urls, dest, (cur, total) =>
    onProgress?.({ key: 'server-jar', phase: '下载服务端 server.jar', current: cur, total })
  )
  void src
}

async function downloadPaperServer(
  mcVersion: string,
  dest: string,
  onProgress?: ProgressFn
): Promise<number> {
  const url = `https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`
  const builds = await fetchJson<{ id: number; channel: string; downloads?: Record<string, { url: string; name: string }> }[]>(
    url,
    { headers: { 'User-Agent': 'WFMC/1.0 (Minecraft Launcher)' } } as never
  )
  if (!Array.isArray(builds) || builds.length === 0) throw new Error(`Paper 没有 ${mcVersion} 的构建`)

  // 优先稳定版通道的最新构建
  const stable = builds.filter((b) => b.channel === 'STABLE')
  const pick = (stable.length ? stable : builds).sort((a, b) => b.id - a.id)[0]
  const download = pick.downloads?.['server:default'] ?? Object.values(pick.downloads ?? {})[0]
  if (!download?.url) throw new Error('这个 Paper 构建没有可下载的服务端文件')

  onProgress?.({ key: 'server-jar', phase: `下载 Paper ${mcVersion} build ${pick.id}`, current: 0, total: 1 })
  await downloadFile(download.url, dest, (cur, total) =>
    onProgress?.({ key: 'server-jar', phase: `下载 Paper ${mcVersion} build ${pick.id}`, current: cur, total })
  )
  return pick.id
}

/** 新建一个服务端实例并下载 jar（eula 仍需要用户确认） */
export async function createHostedServer(input: {
  name: string
  kind: ServerKind
  mcVersion: string
  memoryMb?: number
  port?: number
  loaderVersion?: string
}, onProgress?: ProgressFn): Promise<HostedServer> {
  const id = `${input.kind}-${input.mcVersion.replace(/\./g, '-')}-${randomUUID().slice(0, 6)}`
  const dir = serverDir(id)
  fs.mkdirSync(dir, { recursive: true })

  let jarFile = 'server.jar'
  let launchArgs: string[] | undefined
  let build: number | undefined
  let loaderVersion: string | undefined

  if (input.kind === 'paper') {
    jarFile = 'paper.jar'
    build = await downloadPaperServer(input.mcVersion, path.join(dir, jarFile), onProgress)
  } else if (input.kind === 'vanilla') {
    await downloadVanillaServer(input.mcVersion, path.join(dir, jarFile), onProgress)
  } else if (input.kind === 'fabric') {
    jarFile = 'fabric-server-launch.jar'
    loaderVersion = input.loaderVersion || (await latestFabricLoader(input.mcVersion))
    await downloadFabricServer(input.mcVersion, loaderVersion, path.join(dir, jarFile), onProgress, dir)
  } else {
    // Forge / NeoForge：跑官方 installer 的 --installServer
    const installed = await installForgeServer(input.kind, input.mcVersion, input.loaderVersion, dir, onProgress)
    jarFile = installed.jarFile
    launchArgs = installed.launchArgs
    build = installed.build
  }

  const server: HostedServer = {
    id,
    name: input.name || `${input.kind} ${input.mcVersion}`,
    kind: input.kind,
    mcVersion: input.mcVersion,
    build,
    memoryMb: input.memoryMb ?? 2048,
    port: input.port ?? 25565,
    eulaAccepted: false,
    createdAt: Date.now(),
    jarFile,
    launchArgs,
    loaderVersion
  }

  fs.writeFileSync(path.join(dir, 'eula.txt'), '# 同意 Mojang EULA 后改成 true\neula=false\n', 'utf-8')
  const props = path.join(dir, 'server.properties')
  if (!fs.existsSync(props)) {
    fs.writeFileSync(
      props,
      [
        `server-port=${server.port}`,
        'motd=WFMC 开服 · 欢迎来玩',
        'online-mode=true',
        'max-players=20',
        'view-distance=8',
        'enable-command-block=true',
        'spawn-protection=0',
        ''
      ].join('\n'),
      'utf-8'
    )
  }
  saveHosted(server)
  return server
}

/** 用户确认 EULA */
export function acceptEula(id: string): HostedServer {
  const server = getHosted(id)
  if (!server) throw new Error('服务端不存在')
  fs.writeFileSync(path.join(serverDir(id), 'eula.txt'), 'eula=true\n', 'utf-8')
  const updated = { ...server, eulaAccepted: true }
  saveHosted(updated)
  return updated
}

export function readServerProperties(id: string): string {
  const file = path.join(serverDir(id), 'server.properties')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
}

export function writeServerProperties(id: string, content: string): void {
  const file = path.join(serverDir(id), 'server.properties')
  fs.writeFileSync(file, content, 'utf-8')
  // 端口同步到元数据
  const server = getHosted(id)
  const match = /^server-port=(\d+)/m.exec(content)
  if (server && match) saveHosted({ ...server, port: Number(match[1]) })
}

export function isHostedRunning(id: string): boolean {
  return runningHosted.has(id)
}

export function hostedLogsOf(id: string): string[] {
  return hostedLogs.get(id) ?? []
}

export function hostedUptime(id: string): number {
  const entry = runningHosted.get(id)
  return entry ? Date.now() - entry.startedAt : 0
}

/** 启动服务端 */
export async function startHosted(
  id: string,
  onLog: (id: string, line: string) => void,
  onExit: (id: string, code: number | null) => void
): Promise<void> {
  const server = getHosted(id)
  if (!server) throw new Error('服务端不存在')
  if (runningHosted.has(id)) throw new Error('已经在运行了')
  if (!server.eulaAccepted) throw new Error('需要先同意 Minecraft EULA')

  const java = await ensureJava(server.mcVersion)
  const dir = serverDir(id)
  const jvm = [`-Xms${Math.min(1024, server.memoryMb)}M`, `-Xmx${server.memoryMb}M`]
  const args = server.launchArgs?.length
    ? [...jvm, ...server.launchArgs, 'nogui']
    : [...jvm, '-jar', server.jarFile, 'nogui']

  const proc = spawn(java, args, { cwd: dir, windowsHide: true })
  runningHosted.set(id, { proc, startedAt: Date.now(), logs: [] })
  hostedLogs.set(id, [])

  const push = (line: string) => {
    const arr = hostedLogs.get(id) ?? []
    arr.push(line)
    hostedLogs.set(id, arr.slice(-2000))
    onLog(id, line)
  }
  push(`[WFMC] 用 Java ${requiredJavaMajor(server.mcVersion)}+ 启动，内存 ${server.memoryMb}MB`)

  const pipe = (stream: NodeJS.ReadableStream | null | undefined, prefix = '') => {
    if (!stream) return
    let buf = ''
    stream.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) push(prefix + line)
    })
  }
  pipe(proc.stdout)
  pipe(proc.stderr, '[stderr] ')

  // 模组服：顺手开一个环境清单服务，好友进服前能自动补 mod
  if (server.kind === 'fabric' || server.kind === 'forge' || server.kind === 'neoforge') {
    void startManifestServer(id).then((info) => {
      if (info) push(`[WFMC] 模组清单已就绪：http://<你的IP>:${info.port}/manifest.json（${info.mods} 个 mod）`)
    })
  }

  proc.on('exit', (code) => {
    runningHosted.delete(id)
    void stopManifestServer(id)
    push(`[WFMC] 服务端已退出，code=${code}`)
    onExit(id, code)
  })
  proc.on('error', (e) => {
    runningHosted.delete(id)
    void stopManifestServer(id)
    push(`[WFMC] 启动失败：${e.message}`)
    onExit(id, null)
  })
}

/** 给服务端控制台发命令（stop / op xxx / list …） */
export function sendHostedCommand(id: string, command: string): boolean {
  const entry = runningHosted.get(id)
  if (!entry?.proc.stdin) return false
  entry.proc.stdin.write(command.endsWith('\n') ? command : `${command}\n`)
  const arr = hostedLogs.get(id) ?? []
  arr.push(`> ${command}`)
  hostedLogs.set(id, arr.slice(-2000))
  return true
}

/**
 * 停服：发 stop 让世界正常落盘。
 * 立刻返回（不再让调用方干等 15 秒），进程真正退出会通过 onExit 事件通知前端。
 * 如果 12 秒还没退，后台自动强杀，前端可以接「强制结束」按钮提前动手。
 */
export function stopHosted(id: string): { stopping: boolean; message: string } {
  const entry = runningHosted.get(id)
  if (!entry) return { stopping: false, message: '服务端本来就没在跑' }
  try {
    entry.proc.stdin?.write('stop\n')
  } catch {
    /* 管道断了就直接强杀 */
    try {
      entry.proc.kill()
    } catch {
      /* 忽略 */
    }
    return { stopping: true, message: '控制台已断开，正在强制结束' }
  }
  // 后台兜底：12 秒还没退就强杀
  const timer = setTimeout(() => {
    const still = runningHosted.get(id)
    if (!still) return
    try {
      still.proc.kill()
    } catch {
      /* 忽略 */
    }
  }, 12000)
  entry.proc.once('exit', () => clearTimeout(timer))
  return { stopping: true, message: '正在保存世界并关闭（最多等 12 秒，会自动强制结束）' }
}

/** 强制结束（用户不想等时点） */
export function killHosted(id: string): boolean {
  const entry = runningHosted.get(id)
  if (!entry) return false
  try {
    entry.proc.kill()
    return true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * server.properties：给图形化表单用（读成键值对，改的时候保留未知行）
 * ------------------------------------------------------------------ */

export function parseProperties(text: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    map[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
  }
  return map
}

/** 只改指定键，其余行（含注释、未知键）原样保留 */
export function patchServerProperties(id: string, patch: Record<string, string>): Record<string, string> {
  const file = path.join(serverDir(id), 'server.properties')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split(/\r?\n/) : []
  const seen = new Set<string>()
  const out = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const idx = trimmed.indexOf('=')
    if (idx <= 0) return line
    const key = trimmed.slice(0, idx).trim()
    if (!(key in patch)) return line
    seen.add(key)
    return `${key}=${patch[key]}`
  })
  for (const [key, value] of Object.entries(patch)) if (!seen.has(key)) out.push(`${key}=${value}`)
  const content = out.filter((l, i) => l !== '' || i < out.length - 1).join('\n')
  fs.writeFileSync(file, content, 'utf-8')

  // 端口变了要同步元数据
  const server = getHosted(id)
  if (server && patch['server-port']) {
    saveHosted({ ...server, port: Number(patch['server-port']) || server.port })
  }
  return parseProperties(content)
}

export function deleteHosted(id: string) {
  const entry = runningHosted.get(id)
  if (entry) {
    try {
      entry.proc.kill()
    } catch {
      /* 忽略 */
    }
    runningHosted.delete(id)
  }
  fs.rmSync(serverDir(id), { recursive: true, force: true })
  hostedLogs.delete(id)
}

export function hostedServerDir(id: string): string {
  return serverDir(id)
}

/* ------------------------------------------------------------------ *
 * Fabric / Forge / NeoForge 服务端
 * ------------------------------------------------------------------ */

async function latestFabricLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(
    `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`
  )
  const stable = list.find((l) => l.loader.stable) ?? list[0]
  if (!stable) throw new Error(`Fabric 没有 ${mcVersion} 的加载器`)
  return stable.loader.version
}

async function downloadFabricServer(
  mcVersion: string,
  loaderVersion: string,
  dest: string,
  onProgress?: ProgressFn,
  dir?: string
): Promise<void> {
  // Fabric 已经撤掉了 /server/jar 接口，改用官方 installer 的 server 子命令
  const workDir = dir ?? path.dirname(dest)
  const meta = await fetchJson<{ version: string; url: string; stable: boolean }[]>(
    'https://meta.fabricmc.net/v2/versions/installer'
  )
  const installerMeta = meta.find((m) => m.stable) ?? meta[0]
  if (!installerMeta) throw new Error('拿不到 Fabric 安装器版本')

  const installer = path.join(workDir, 'fabric-installer.jar')
  onProgress?.({ key: 'server-jar', phase: `下载 Fabric 安装器 ${installerMeta.version}`, current: 0, total: 1 })
  await downloadFile(
    installerMeta.url,
    installer,
    (cur, total) => onProgress?.({ key: 'server-jar', phase: '下载 Fabric 安装器', current: cur, total }),
    { skipIfExists: false }
  )

  const java = await ensureJava(mcVersion)
  onProgress?.({ key: 'server-jar', phase: `运行安装器（server -mcversion ${mcVersion}）`, current: 0, total: 1 })
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      java,
      ['-jar', installer, 'server', '-dir', workDir, '-mcversion', mcVersion, '-loader', loaderVersion, '-downloadMinecraft'],
      { cwd: workDir, windowsHide: true }
    )
    let err = ''
    proc.stdout?.on('data', (c: Buffer) => {
      const line = c.toString('utf-8').split(/\r?\n/).filter(Boolean).pop()
      if (line) onProgress?.({ key: 'server-jar', phase: line.slice(0, 110), current: 0, total: 1 })
    })
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8')
    })
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Fabric 安装器退出码 ${code}：${err.slice(-300) || '见上'}`))
    )
    proc.on('error', reject)
  })

  const launchJar = path.join(workDir, 'fabric-server-launch.jar')
  if (!fs.existsSync(launchJar)) throw new Error('安装器跑完了，但没生成 fabric-server-launch.jar')
  if (path.resolve(launchJar) !== path.resolve(dest)) fs.copyFileSync(launchJar, dest)
  fs.rmSync(installer, { force: true })
}

/** 各加载器有哪些服务端版本 */
export async function listLoaderServerVersions(kind: 'fabric' | 'forge' | 'neoforge', mcVersion: string): Promise<string[]> {
  const cachedLoader = versionCache.get(`l:${kind}:${mcVersion}`)
  if (cachedLoader && Date.now() - cachedLoader.at < 10 * 60 * 1000) return cachedLoader.data as string[]
  if (kind === 'fabric') {
    const list = await fetchJson<{ loader: { version: string } }[]>(
      `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`
    ).catch(() => [])
    return list.map((l) => l.loader.version)
  }
  if (kind === 'forge') {
    const xml = await fetchText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml').catch(
      () => ''
    )
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((m) => m[1])
      .filter((v) => v.startsWith(`${mcVersion}-`))
      .map((v) => v.slice(mcVersion.length + 1))
      .reverse()
  }
  const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml').catch(
    () => ''
  )
  const mcShort = mcVersion.replace(/^1\./, '')
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(`${mcShort}.`))
    .reverse()
}

/** 跑官方 installer 的 --installServer，返回启动方式 */
async function installForgeServer(
  kind: 'forge' | 'neoforge',
  mcVersion: string,
  version: string | undefined,
  dir: string,
  onProgress?: ProgressFn
): Promise<{ jarFile: string; launchArgs?: string[]; build?: number }> {
  const list = await listLoaderServerVersions(kind, mcVersion)
  const pick = version || list[0]
  if (!pick) throw new Error(`${kind} 没有 ${mcVersion} 的服务端版本`)

  const fullVersion = kind === 'forge' ? `${mcVersion}-${pick}` : pick
  const base =
    kind === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullVersion}`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${fullVersion}`
  const fileName = `${kind === 'forge' ? 'forge' : 'neoforge'}-${fullVersion}-installer.jar`
  const installer = path.join(dir, 'installer.jar')

  onProgress?.({ key: 'server-jar', phase: `下载 ${kind} 安装器 ${fullVersion}`, current: 0, total: 1 })
  await downloadFile(`${base}/${fileName}`, installer, (cur, total) =>
    onProgress?.({ key: 'server-jar', phase: `下载 ${kind} 安装器`, current: cur, total }), { skipIfExists: false }
  )

  const java = await ensureJava(mcVersion)
  onProgress?.({ key: 'server-jar', phase: '运行安装器（--installServer）', current: 0, total: 1 })
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(java, ['-jar', installer, '--installServer', dir], { cwd: dir, windowsHide: true })
    let err = ''
    proc.stdout?.on('data', (c: Buffer) => {
      const text = c.toString('utf-8')
      const line = text.split(/\r?\n/).filter(Boolean).pop()
      if (line) onProgress?.({ key: 'server-jar', phase: line.slice(0, 110), current: 0, total: 1 })
    })
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8')
    })
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`安装器退出码 ${code}：${err.slice(-300)}`))))
    proc.on('error', reject)
  })

  // 找 args 文件（1.17+）或回退到 universal jar（老版本）
  const candidates: string[] = []
  const walk = (root: string, depth = 0) => {
    if (depth > 6 || !fs.existsSync(root)) return
    for (const name of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, name.name)
      if (name.isDirectory()) walk(full, depth + 1)
      else if (name.name === 'win_args.txt' || name.name === 'unix_args.txt') candidates.push(full)
    }
  }
  walk(path.join(dir, 'libraries'))

  if (candidates.length > 0) {
    const argsFile = candidates.sort((a, b) => (a.endsWith('win_args.txt') ? -1 : 1))[0]
    const rel = path.relative(dir, argsFile).replace(/\\/g, '/')
    return { jarFile: '', launchArgs: [`@${rel}`], build: pick ? Number(pick.split('.').pop()) : undefined }
  }

  const jar = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(kind === 'forge' ? 'forge-' : 'neoforge-') && n.endsWith('.jar') && !n.includes('installer'))
  if (jar.length > 0) return { jarFile: jar[0], build: undefined }
  throw new Error('安装器跑完了，但没找到可启动的 jar / args 文件')
}

/* ------------------------------------------------------------------ *
 * 服务端运维：白名单 / OP / 备份 / 在线玩家
 * ------------------------------------------------------------------ */

export interface AccessEntry {
  uuid: string
  name: string
  level?: number
}

function accessFile(id: string, type: 'whitelist' | 'ops'): string {
  return path.join(serverDir(id), type === 'ops' ? 'ops.json' : 'whitelist.json')
}

export function readAccessList(id: string, type: 'whitelist' | 'ops'): AccessEntry[] {
  const file = accessFile(id, type)
  if (!fs.existsSync(file)) return []
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as AccessEntry[]
  } catch {
    return []
  }
}

function writeAccessList(id: string, type: 'whitelist' | 'ops', list: AccessEntry[]) {
  fs.writeFileSync(accessFile(id, type), JSON.stringify(list, null, 4), 'utf-8')
}

/** 离线模式没有 uuid 也允许加名单（服务端自己会按名字认） */
export function addAccessEntry(id: string, type: 'whitelist' | 'ops', name: string, uuid?: string, level = 4): AccessEntry[] {
  const list = readAccessList(id, type)
  const clean = name.trim()
  if (!clean) throw new Error('名字为空')
  if (list.some((e) => e.name.toLowerCase() === clean.toLowerCase())) return list
  const entry: AccessEntry = {
    uuid: uuid || '00000000-0000-0000-0000-000000000000',
    name: clean
  }
  if (type === 'ops') {
    entry.level = level
    ;(entry as unknown as { bypassesPlayerLimit: boolean }).bypassesPlayerLimit = false
  }
  list.push(entry)
  writeAccessList(id, type, list)
  return list
}

export function removeAccessEntry(id: string, type: 'whitelist' | 'ops', name: string): AccessEntry[] {
  const list = readAccessList(id, type).filter((e) => e.name.toLowerCase() !== name.trim().toLowerCase())
  writeAccessList(id, type, list)
  return list
}

/** 备份世界到 dataDir/backups/servers/ */
export function backupHosted(id: string): string {
  const server = getHosted(id)
  if (!server) throw new Error('服务端不存在')
  const dir = serverDir(id)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const outDir = path.join(store.dataDir, 'backups', 'servers')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `${server.name}-${stamp}.zip`)

  const files: { name: string; full: string }[] = []
  for (const folder of ['world', 'world_nether', 'world_the_end']) {
    const full = path.join(dir, folder)
    if (!fs.existsSync(full)) continue
    for (const file of collectDirFiles(full)) files.push({ name: `${folder}/${file.name}`, full: file.full })
  }
  for (const conf of ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json']) {
    const full = path.join(dir, conf)
    if (fs.existsSync(full)) files.push({ name: conf, full })
  }
  if (files.length === 0) throw new Error('还没有世界文件（先启动过一次再备份）')
  writeZip(out, files)
  return out
}

/** 从日志里解析在线玩家与 TPS 线索 */
export function hostedStats(id: string): { players: string[]; tps?: number; done: boolean } {
  const logs = hostedLogs.get(id) ?? []
  const players = new Set<string>()
  let tps: number | undefined
  let done = false
  for (const line of logs) {
    if (/Done \([\d.]+s\)!/.test(line)) done = true
    const join = /: ([A-Za-z0-9_]{3,16}) joined the game/.exec(line)
    if (join) players.add(join[1])
    const leave = /: ([A-Za-z0-9_]{3,16}) left the game/.exec(line)
    if (leave) players.delete(leave[1])
    const tpsMatch = /TPS from last 1m, 5m, 15m: ([\d.]+)/.exec(line) ?? /Mean tick time: [\d.]+ ms\. Mean TPS: ([\d.]+)/.exec(line)
    if (tpsMatch) tps = Number(tpsMatch[1])
  }
  return { players: [...players], tps, done }
}

/* ------------------------------------------------------------------ *
 * 模组服：照实例 / 照整合包开服
 * ------------------------------------------------------------------ */

/** 服务端 mods 目录 */
function serverModsDir(id: string) {
  return path.join(serverDir(id), 'mods')
}

export function countServerMods(id: string): number {
  const dir = serverModsDir(id)
  if (!fs.existsSync(dir)) return 0
  return fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.jar')).length
}

/** 实例的加载器 → 服务端类型（Quilt 用 Fabric 服务端，原版走原版服） */
function kindFromLoader(loader: string): ServerKind {
  if (loader === 'fabric' || loader === 'quilt') return 'fabric'
  if (loader === 'forge') return 'forge'
  if (loader === 'neoforge') return 'neoforge'
  return 'vanilla'
}

/** 把一个实例的 mods / config 拷进服务端目录 */
function copyFromInstance(instanceId: string, serverId: string): { mods: number; configs: number } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const from = gamePathFor(instance)
  const to = serverDir(serverId)
  let mods = 0
  let configs = 0

  const modsSrc = path.join(from, 'mods')
  if (fs.existsSync(modsSrc)) {
    fs.mkdirSync(serverModsDir(serverId), { recursive: true })
    for (const name of fs.readdirSync(modsSrc)) {
      // 只拿启用的 mod（.disabled 跳过）
      if (!name.toLowerCase().endsWith('.jar')) continue
      fs.copyFileSync(path.join(modsSrc, name), path.join(serverModsDir(serverId), name))
      mods++
    }
  }

  for (const folder of ['config', 'defaultconfigs']) {
    const src = path.join(from, folder)
    if (!fs.existsSync(src)) continue
    for (const file of collectDirFiles(src)) {
      const dest = path.join(to, folder, file.name)
      if (fs.existsSync(dest)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(file.full, dest)
      configs++
    }
  }
  return { mods, configs }
}

/**
 * 从整合包文件（.mrpack / 打包了 mods 的 zip）把模组装进服务端。
 * mrpack 会按 index.json 里的下载地址拉依赖，并把 overrides 里的 mods/config 解出来。
 */
async function copyFromPack(
  packFile: string,
  serverId: string,
  onProgress?: ProgressFn
): Promise<{ mods: number; configs: number }> {
  const to = serverDir(serverId)
  const modsDir = serverModsDir(serverId)
  fs.mkdirSync(modsDir, { recursive: true })
  let mods = 0
  let configs = 0

  const indexBuf = readFileInsideZip(packFile, 'modrinth.index.json')
  if (indexBuf) {
    const index = JSON.parse(indexBuf.toString('utf-8')) as {
      files?: { path: string; downloads: string[] }[]
    }
    const files = (index.files ?? []).filter((f) => f.path.startsWith('mods/'))
    onProgress?.({ key: 'server-mods', phase: `下载 ${files.length} 个服务端 mod`, current: 0, total: files.length })
    const items = files.map((f) => ({
      url: f.downloads,
      dest: path.join(modsDir, path.basename(f.path)),
      skipIfExists: true
    }))
    const errors = await downloadAll(items, 6, (done, total) =>
      onProgress?.({ key: 'server-mods', phase: '下载服务端 mod', current: done, total })
    )
    mods += items.length - errors.length
  }

  // 包里的 overrides（作者自带的 mod / 配置）解到临时目录再归位
  const tmp = path.join(store.dataDir, 'temp', `srvmods-${Date.now()}`)
  try {
    const extracted = await extractZipPrefixes(packFile, ['overrides/', 'client-overrides/', 'mods/'], tmp)
    if (extracted > 0) {
      for (const folder of ['mods', 'config', 'defaultconfigs']) {
        const src = path.join(tmp, folder)
        if (!fs.existsSync(src)) continue
        for (const file of collectDirFiles(src)) {
          if (folder === 'mods' && !file.name.toLowerCase().endsWith('.jar')) continue
          const dest = path.join(to, folder, file.name)
          if (fs.existsSync(dest)) continue
          fs.mkdirSync(path.dirname(dest), { recursive: true })
          fs.copyFileSync(file.full, dest)
          if (folder === 'mods') mods++
          else configs++
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }

  return { mods, configs }
}

/** 照着现有实例开一个同版本同加载器的服务端，并把 mod 一起搬过去 */
export async function createHostedFromInstance(
  instanceId: string,
  opts: { name?: string; memoryMb?: number; port?: number },
  onProgress?: ProgressFn
): Promise<HostedServer> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')

  const kind = kindFromLoader(instance.loader)
  const server = await createHostedServer(
    {
      name: opts.name || `${instance.name} · 服务端`,
      kind,
      mcVersion: instance.mcVersion,
      loaderVersion: instance.loaderVersion,
      memoryMb: opts.memoryMb,
      port: opts.port
    },
    onProgress
  )

  if (kind !== 'vanilla') {
    const copied = copyFromInstance(instanceId, server.id)
    onProgress?.({
      key: 'server-mods',
      phase: `已搬入 ${copied.mods} 个 mod、${copied.configs} 个配置文件`,
      current: 1,
      total: 1
    })
  }
  return getHosted(server.id) ?? server
}

/** 给已有服务端导入模组：从实例 或 从整合包文件 */
export async function importServerMods(
  id: string,
  source: { instanceId?: string; packFile?: string },
  onProgress?: ProgressFn
): Promise<{ mods: number; configs: number; total: number }> {
  const server = getHosted(id)
  if (!server) throw new Error('服务端不存在')
  if (server.kind === 'vanilla' || server.kind === 'paper') {
    throw new Error('原版/Paper 服务端只能装插件，装不了 mod；要玩模组请新建 Fabric/Forge/NeoForge 服务端')
  }

  let result = { mods: 0, configs: 0 }
  if (source.packFile) result = await copyFromPack(source.packFile, id, onProgress)
  else if (source.instanceId) result = copyFromInstance(source.instanceId, id)
  else throw new Error('没指定来源')

  return { ...result, total: countServerMods(id) }
}
