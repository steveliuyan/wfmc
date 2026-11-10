import { app, BrowserWindow } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Instance, LaunchStatePayload } from '../shared/types'
import type { ResourceType } from './modrinth'
import { store } from './store'
import { clearLaunchLog, getLaunchLog, isRunning, killGame, launchInstance } from './launch'
import { instanceDetail } from './instances'
import { installResource, searchResources } from './modrinth'
import { installMrpackFromUrl } from './modpack'
import { listServers, queryServer } from './servers'
import { exportDiagnostics } from './content'
import { refreshAccount } from './accounts'
import { runTask } from './tasks'
import { logError } from './errlog'

/**
 * 启动器 MCP（Model Context Protocol）—— 让 AI 助手直接操作 WFMC。
 *
 * 结构（三个进程/角色）：
 *   1. AI 客户端（Claude Desktop / Cursor …）按 MCP 标准 spawn 一个 `WFMC.exe --mcp-stdio`
 *   2. 那个进程只做 MCP 协议翻译（本文件的 runMcpStdio），它不碰数据文件，只把工具调用
 *      转给正在运行的启动器主进程
 *   3. 启动器主进程在本机回环地址上开一个带随机令牌的小 HTTP 接口（startMcpBridge），
 *      收到调用就直接调内部函数（和界面走的是同一套 launchInstance / installResource…）
 *
 * 为什么绕这么一圈：AI 客户端 spawn 的是**另一个进程**，它要是自己开 store 去写
 * instances / accounts.json，就会和正在跑的启动器抢文件；所以真正的动作用主进程做，
 * stdio 那端只当传话筒。
 *
 * 安全：只监听 127.0.0.1、令牌每次启动重新生成、写在数据目录的 mcp-endpoint.json（含端口），
 * 写操作默认要用户在界面上点「允许」。
 */

// ---------------------------------------------------------------- 令牌与端点文件

let server: http.Server | undefined
let token = ''
let listenPort = 0

/** 端点文件路径（stdio 进程和设置页都用它） */
export function mcpEndpointPath(dataDir?: string) {
  return path.join(dataDir ?? store.dataDir, 'mcp-endpoint.json')
}

function writeEndpointFile() {
  try {
    const file = mcpEndpointPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          port: listenPort,
          token,
          pid: process.pid,
          version: app.getVersion(),
          url: `http://127.0.0.1:${listenPort}/rpc`
        },
        null,
        2
      ),
      'utf-8'
    )
  } catch (e) {
    logError('mcp:endpoint', String((e as Error)?.message ?? e))
  }
}

function removeEndpointFile() {
  try {
    fs.rmSync(mcpEndpointPath(), { force: true })
  } catch {
    /* 删不掉就算了，下次启动会覆盖 */
  }
}

// ---------------------------------------------------------------- 用户确认（写操作）

export interface ConsentRequest {
  id: string
  tool: string
  title: string
  summary: string
  args: unknown
  at: number
}

const pendingConsent = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>()
/** 本会话内「一直允许」过的工具（进程退出即失效，不写盘） */
const sessionAllowed = new Set<string>()
/** 每个待确认请求是哪个工具（「本会话都允许」要用） */
const lastRequests = new Map<string, ConsentRequest>()

function broadcast(channel: string, payload: unknown) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 问用户「AI 想干这件事，允许吗」。
 * 免确认（设置里打开了 trustAll）或者本会话允许过同名工具 → 直接放行。
 * 界面上没人应答（关窗了 / 超过 3 分钟）→ 一律当拒绝，宁可不做。
 */
async function askConsent(tool: ToolDef, args: Record<string, unknown>): Promise<boolean> {
  if (store.settings.mcp?.trustAll) return true
  if (sessionAllowed.has(tool.name)) return true
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return false

  const id = crypto.randomUUID()
  const req: ConsentRequest = {
    id,
    tool: tool.name,
    title: tool.title,
    summary: tool.describe ? tool.describe(args) : JSON.stringify(args),
    args,
    at: Date.now()
  }
  lastRequests.set(id, req)
  const answer = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConsent.delete(id)
      lastRequests.delete(id)
      resolve(false)
    }, 180_000)
    pendingConsent.set(id, { resolve, timer })
  })
  // 窗口可能在托盘里 / 最小化：先把它叫出来，否则用户根本不知道有人在等
  try {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } catch {
    /* 叫不出来也照发，界面上有监听就能弹 */
  }
  win.webContents.send('event:mcp-consent', req)
  return answer
}

/** 渲染层点了「允许 / 拒绝」之后调这个 */
export function settleConsent(id: string, allow: boolean, remember: boolean): boolean {
  const entry = pendingConsent.get(id)
  if (!entry) return false
  pendingConsent.delete(id)
  clearTimeout(entry.timer)
  const req = lastRequests.get(id)
  if (allow && remember && req) sessionAllowed.add(req.tool)
  lastRequests.delete(id)
  entry.resolve(allow)
  return true
}

// ---------------------------------------------------------------- 工具表

interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  /** 会改动用户的东西（启动游戏 / 装文件 / 删东西）→ 需要确认 */
  write?: boolean
  /** 确认弹窗里给用户看的一句话（默认直接甩 JSON） */
  describe?: (args: Record<string, unknown>) => string
  run: (args: Record<string, unknown>) => Promise<unknown>
}

/** 把带 base64 图标的字段剔掉再返回——AI 不需要那几万个字符 */
function slim<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (/^(icon|iconData|iconUrl|favicon|faviconUrl|wallpaper|background)$/i.test(k)) continue
    if (typeof v === 'string' && v.length > 600) out[k] = `${v.slice(0, 600)}…(${v.length} 字符已省略)`
    else out[k] = v
  }
  return out
}

function instanceBrief(i: Instance) {
  return {
    id: i.id,
    name: i.name,
    mcVersion: i.mcVersion,
    loader: i.loader,
    loaderVersion: i.loaderVersion,
    versionId: i.versionId,
    running: isRunning(i.id),
    playTimeMinutes: Math.round((i.playTimeMs ?? 0) / 60000),
    lastPlayed: i.lastPlayed ?? null,
    memoryMb: { min: i.minMemory ?? store.settings.minMemory, max: i.maxMemory ?? store.settings.maxMemory }
  }
}

const RESOURCE_TYPES: ResourceType[] = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack']

export const TOOLS: ToolDef[] = [
  {
    name: 'launcher_status',
    title: '看启动器状态',
    description: '启动器的版本、数据目录、正在跑哪些实例、MCP 接口是否在线。先调这个确认连上了。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const running = store.listInstances().filter((i) => isRunning(i.id)).map((i) => i.id)
      return {
        name: 'WFMC',
        version: app.getVersion(),
        dataDir: store.dataDir,
        runningInstances: running,
        endpoint: `http://127.0.0.1:${listenPort}/rpc`,
        trustAll: !!store.settings.mcp?.trustAll
      }
    }
  },
  {
    name: 'list_instances',
    title: '列出所有实例',
    description: '列出版本实例（名称、游戏版本、加载器、是否在运行、游玩时长）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return store.listInstances().map(instanceBrief)
    }
  },
  {
    name: 'get_instance',
    title: '看一个实例的详情',
    description: '某个实例的详细信息：游戏目录、已装版本、模组/资源包/光影/存档数量、占用空间。',
    inputSchema: {
      type: 'object',
      properties: { instanceId: { type: 'string', description: '实例 id（list_instances 里的 id）' } },
      required: ['instanceId'],
      additionalProperties: false
    },
    async run(args) {
      const id = String(args.instanceId ?? '')
      const detail = instanceDetail(id)
      if (!detail) throw new Error(`没有这个实例：${id}（先用 list_instances 看看有哪些）`)
      return slim({ ...detail, running: isRunning(id) } as unknown as Record<string, unknown>)
    }
  },
  {
    name: 'get_launch_log',
    title: '读启动日志',
    description:
      '读某实例最近一次启动的日志尾部（默认 120 行）。游戏起不来、模组报错、Java 版本不对，答案通常都在这。',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
        lines: { type: 'number', description: '要多少行（1-600，默认 120）' }
      },
      required: ['instanceId'],
      additionalProperties: false
    },
    async run(args) {
      const id = String(args.instanceId ?? '')
      const lines = Number(args.lines ?? 120)
      return { instanceId: id, running: isRunning(id), lines: getLaunchLog(id, lines) }
    }
  },
  {
    name: 'list_accounts',
    title: '列出账号',
    description: '列出登录信息（名字、类型、是不是当前使用中的）。不会返回令牌。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const activeId = store.activeAccount?.id
      return store.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        active: a.id === activeId
      }))
    }
  },
  {
    name: 'list_servers',
    title: '列出收藏的服务器',
    description: '列出「服务器列表」里收藏的服务器（地址、备注、上次查到的在线状态）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return listServers().map((s) => ({
        id: s.id,
        name: s.name,
        address: s.address,
        port: s.port ?? null,
        note: s.note ?? '',
        lastOnline: s.lastStatus?.online ?? null,
        lastChecked: s.lastChecked ?? null
      }))
    }
  },
  {
    name: 'server_ping',
    title: '测服务器在线状态',
    description: '按 Minecraft 服务器列表协议问一次某个地址：在不在线、版本、人数、MOTD、延迟。',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '域名或 IP，可带 :端口' },
        port: { type: 'number' }
      },
      required: ['address'],
      additionalProperties: false
    },
    async run(args) {
      const [host, inlinePort] = String(args.address ?? '').split(':')
      const port = Number(args.port ?? (inlinePort ? Number(inlinePort) : undefined)) || undefined
      const st = await queryServer(host, port)
      return slim({ ...st } as unknown as Record<string, unknown>)
    }
  },
  {
    name: 'search_resources',
    title: '搜模组 / 资源包 / 光影',
    description:
      '在 Modrinth 上搜资源（中文关键词会自动翻成英文再搜）。type 可选 mod / modpack / resourcepack / shader / datapack。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: RESOURCE_TYPES, description: '默认 mod' },
        query: { type: 'string' },
        mcVersion: { type: 'string', description: '例如 1.20.1' },
        loader: { type: 'string', description: 'fabric / forge / neoforge / quilt' },
        limit: { type: 'number', description: '1-30，默认 10' }
      },
      additionalProperties: false
    },
    async run(args) {
      const type = (RESOURCE_TYPES as string[]).includes(String(args.type)) ? (args.type as ResourceType) : 'mod'
      const res = await searchResources({
        type,
        query: args.query ? String(args.query) : undefined,
        mcVersion: args.mcVersion ? String(args.mcVersion) : undefined,
        loader: args.loader ? String(args.loader) : undefined,
        limit: Math.max(1, Math.min(Number(args.limit ?? 10) || 10, 30))
      })
      return {
        total: res.total,
        hits: res.hits.map((h) => ({
          projectId: h.projectId,
          title: h.title,
          description: h.description,
          author: h.author,
          downloads: h.downloads,
          categories: h.categories,
          versions: h.versions?.slice(-8)
        }))
      }
    }
  },
  {
    name: 'export_diagnostics',
    title: '导出诊断包',
    description:
      '把某个实例的日志、模组清单、配置打成一个 zip，返回文件路径。排错时让用户把这个文件发过来最省事。',
    inputSchema: {
      type: 'object',
      properties: { instanceId: { type: 'string' } },
      required: ['instanceId'],
      additionalProperties: false
    },
    async run(args) {
      const id = String(args.instanceId ?? '')
      if (!store.getInstance(id)) throw new Error(`没有这个实例：${id}`)
      const file = exportDiagnostics(id)
      return { file }
    }
  },
  {
    name: 'launch_instance',
    title: '启动游戏',
    description: '启动某个实例（用当前账号）。日志会推到界面上，启动完可以用 get_launch_log 看。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
        accountId: { type: 'string', description: '用哪个账号（默认当前账号）' }
      },
      required: ['instanceId'],
      additionalProperties: false
    },
    describe: (a) => `启动实例 ${a.instanceId}`,
    async run(args) {
      const id = String(args.instanceId ?? '')
      const instance = store.getInstance(id)
      if (!instance) throw new Error(`没有这个实例：${id}`)
      if (isRunning(id)) return { ok: true, alreadyRunning: true, instanceId: id }
      const accountId = args.accountId ? String(args.accountId) : store.activeAccount?.id
      const account = store.accounts.find((a) => a.id === accountId)
      if (account?.type === 'microsoft') await refreshAccount(account.id)
      clearLaunchLog(id)
      // 界面上也要看得见这次启动（AI 触发的启动如果只写终端，用户会一头雾水）
      await launchInstance(
        { instanceId: id, accountId },
        (iid, line) => broadcast('event:launch-log', { instanceId: iid, line }),
        (payload: LaunchStatePayload) => broadcast('event:launch-state', payload)
      )
      return { ok: true, instanceId: id, running: isRunning(id) }
    }
  },
  {
    name: 'kill_instance',
    title: '关闭游戏',
    description: '结束某个实例正在跑的游戏进程（等于界面上点「结束游戏」）。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: { instanceId: { type: 'string' } },
      required: ['instanceId'],
      additionalProperties: false
    },
    describe: (a) => `结束实例 ${a.instanceId} 的游戏进程`,
    async run(args) {
      const id = String(args.instanceId ?? '')
      return { ok: killGame(id), instanceId: id }
    }
  },
  {
    name: 'install_modpack',
    title: '装一个整合包',
    description:
      '按链接装整合包（.mrpack 或整合包 zip 的直链），装完返回新实例的 id。界面上会出现在任务队列里。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '直链地址' },
        name: { type: 'string', description: '实例名（默认取链接里的文件名）' }
      },
      required: ['url'],
      additionalProperties: false
    },
    describe: (a) => `从链接安装整合包：${a.url}`,
    async run(args) {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) throw new Error('不是 http(s) 链接')
      const name = String(args.name ?? '') || decodeURIComponent(url.split('/').pop() || 'AI 装的整合包')
      const instanceId = await runTask('modpack', `安装整合包 ${name}`, async (ctx) =>
        installMrpackFromUrl(url, name, (p) => ctx.report({ phase: p.phase, current: p.current, total: p.total }), ctx.signal, ctx.spawn)
      )
      return { ok: true, instanceId, name }
    }
  },
  {
    name: 'install_resource',
    title: '装模组 / 资源包 / 光影',
    description:
      '把某个 Modrinth 项目装进指定实例（projectId 从 search_resources 拿）。会自动带前置模组，进度在任务队列里。',
    write: true,
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
        type: { type: 'string', enum: RESOURCE_TYPES, description: '默认 mod' },
        projectId: { type: 'string' },
        versionId: { type: 'string', description: '指定版本（默认自动挑适配的那个）' },
        includeOptional: { type: 'array', items: { type: 'string' }, description: '要一起装的可选前置的 projectId' }
      },
      required: ['instanceId', 'projectId'],
      additionalProperties: false
    },
    describe: (a) => `往实例 ${a.instanceId} 里装 ${a.projectId}`,
    async run(args) {
      const instanceId = String(args.instanceId ?? '')
      if (!store.getInstance(instanceId)) throw new Error(`没有这个实例：${instanceId}`)
      const type = (RESOURCE_TYPES as string[]).includes(String(args.type)) ? (args.type as ResourceType) : 'mod'
      const projectId = String(args.projectId ?? '')
      const result = await runTask('resource', `安装 ${projectId}`, async (ctx) =>
        installResource(
          instanceId,
          type,
          projectId,
          args.versionId ? String(args.versionId) : undefined,
          (p) => ctx.report({ phase: p.phase, current: p.current, total: p.total }),
          { includeOptional: Array.isArray(args.includeOptional) ? (args.includeOptional as string[]) : [] }
        )
      )
      return result
    }
  }
]

/** 给 MCP 客户端的工具清单（不含函数） */
export function toolSummaries() {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !t.write }
  }))
}

// ---------------------------------------------------------------- 回环 HTTP 桥

function readBody(req: http.IncomingMessage, limit = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const send = (code: number, obj: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  const auth = String(req.headers.authorization ?? '')
  if (auth !== `Bearer ${token}`) return send(401, { ok: false, error: { message: '令牌不对' } })

  const url = req.url ?? ''
  if (req.method === 'GET' && url === '/health') return send(200, { ok: true, name: 'WFMC', port: listenPort })
  if (req.method === 'GET' && url === '/tools') return send(200, { ok: true, tools: toolSummaries() })
  if (req.method !== 'POST' || url !== '/rpc') return send(404, { ok: false, error: { message: '没有这个地址' } })

  let payload: { tool?: string; args?: Record<string, unknown> }
  try {
    payload = JSON.parse(await readBody(req))
  } catch (e) {
    return send(400, { ok: false, error: { message: `请求体不是合法 JSON：${(e as Error).message}` } })
  }
  const def = TOOLS.find((t) => t.name === payload.tool)
  if (!def) return send(404, { ok: false, error: { message: `没有这个工具：${String(payload.tool)}` } })

  const args = payload.args && typeof payload.args === 'object' ? payload.args : {}
  try {
    if (def.write) {
      const allowed = await askConsent(def, args)
      if (!allowed) return send(200, { ok: false, denied: true, error: { message: '用户拒绝了这次操作' } })
    }
    const result = await def.run(args)
    return send(200, { ok: true, result })
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    logError(`mcp:${def.name}`, msg)
    return send(200, { ok: false, error: { message: msg } })
  }
}

/** 起桥（幂等）。设置里关掉 MCP 就不起，也不写端点文件。 */
export async function startMcpBridge(): Promise<void> {
  if (server) return
  if (store.settings.mcp?.enabled === false) {
    removeEndpointFile()
    return
  }
  token = crypto.randomBytes(24).toString('hex')
  server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((e) => {
      logError('mcp:http', String((e as Error)?.message ?? e))
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: { message: '启动器内部错误' } }))
      } catch {
        /* 连接可能已经断了 */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    const s = server!
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      s.removeListener('error', reject)
      resolve()
    })
  })
  listenPort = (server.address() as AddressInfo).port
  writeEndpointFile()
}

/** 关桥（退出 / 用户关掉开关） */
export async function stopMcpBridge(): Promise<void> {
  const s = server
  server = undefined
  listenPort = 0
  removeEndpointFile()
  if (!s) return
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

/** 设置页改完开关后调它：按当前设置重启一次 */
export async function restartMcpBridge(): Promise<McpStatus> {
  await stopMcpBridge()
  await startMcpBridge()
  return mcpStatus()
}

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  endpointFile: string
  trustAll: boolean
  pendingConsent: number
  /** 贴到 AI 客户端配置里的那段 JSON */
  clientConfig: { command: string; args: string[]; env: Record<string, string>; json: string }
}

export function mcpStatus(): McpStatus {
  return {
    enabled: store.settings.mcp?.enabled !== false,
    running: !!server,
    port: listenPort,
    endpointFile: mcpEndpointPath(),
    trustAll: !!store.settings.mcp?.trustAll,
    pendingConsent: pendingConsent.size,
    clientConfig: mcpClientConfig()
  }
}

/**
 * AI 客户端（Claude Desktop 等）该填的东西。
 *
 * 关键点：Electron 主进程在 Windows 上被 spawn 时 stdin 是关的，读不到管道数据，
 * 所以 stdio 那端必须用 **ELECTRON_RUN_AS_NODE=1** 把同一个 exe 跑成纯 Node，
 * 再去执行 `dist/main/mcp-stdio.js`（那个文件不 import electron）。
 * 打包后脚本在 app.asar.unpacked 里（electron-builder 的 asarUnpack 配了它）。
 */
export function mcpStdioScript(): string {
  const packed = path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'dist', 'main', 'mcp-stdio.js')
  if (fs.existsSync(packed)) return packed
  const loose = path.join(app.getAppPath(), 'dist', 'main', 'mcp-stdio.js')
  if (fs.existsSync(loose)) return loose
  return packed
}

export function mcpClientConfig() {
  const command = process.execPath
  const args = [mcpStdioScript()]
  const env = { ELECTRON_RUN_AS_NODE: '1', WFMC_VERSION: app.getVersion() }
  const json = JSON.stringify({ mcpServers: { wfmc: { command, args, env } } }, null, 2)
  return { command, args, env, json }
}
