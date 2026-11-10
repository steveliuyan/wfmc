/**
 * MCP stdio 端：AI 客户端（Claude Desktop 等）spawn 的就是这个文件。
 *
 * 为什么单独成一个文件、而且**不 import 任何 electron**：
 *   Electron 主进程在 Windows 上被 spawn 时 stdin 是关的（拿不到管道数据），
 *   所以这个进程必须以 `ELECTRON_RUN_AS_NODE=1` 跑成「纯 Node」才能读 stdin。
 *   代价是这里没有 app / store 可用，只能自己按同样的规则把 dataDir 推出来。
 *
 * 它只做协议翻译，真正干活的是正在运行的启动器（主进程 mcp.ts 里的 HTTP 桥）。
 * 工具清单也不在这里维护：直接问桥要 `GET /tools`，清单只有一份。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import readline from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'wfmc'

interface Endpoint {
  port?: number
  token?: string
}

/** 客户端可能带 `--user-data-dir=`（测试用）；否则按 Electron 的惯例推 */
function userDataDir(): string {
  const arg = process.argv.find((a) => a.startsWith('--user-data-dir='))
  if (arg) return arg.slice('--user-data-dir='.length)
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (portable) return path.join(portable, 'WFMC-Data')
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
  return path.join(appData, 'WFMC')
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf-8')) }
  } catch {
    return fallback
  }
}

/**
 * 和主进程 store.ts 的 readOnlyDataDir() 规矩一致（**只读，绝不写 settings.json**，
 * 否则第二个进程会把正在运行的启动器的设置覆盖掉）。
 */
function dataDir(): string {
  const ud = userDataDir()
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  const raw = readJson<{ dataDir?: string; dataDirCustom?: boolean; useSharedData?: boolean }>(
    path.join(ud, 'settings.json'),
    {}
  )
  if (portable && !raw.dataDirCustom) {
    if (raw.useSharedData) {
      const appData = process.env.APPDATA || path.join(process.env.USERPROFILE ?? '.', 'AppData', 'Roaming')
      return path.join(appData, 'WFMC', 'data')
    }
    return path.join(portable, 'WFMC-Data', 'data')
  }
  return raw.dataDir || path.join(ud, 'data')
}

function endpoint(): Endpoint | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'mcp-endpoint.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

const NOT_RUNNING =
  '没连上启动器：找不到 mcp-endpoint.json。请先打开 WFMC（设置 → AI 助手(MCP) 里要开着），而且要和启动器用同一个数据目录。'

function request(method: string, urlPath: string, body?: unknown, timeout = 15 * 60 * 1000): Promise<any> {
  return new Promise((resolve, reject) => {
    const ep = endpoint()
    if (!ep?.port || !ep.token) return reject(new Error(NOT_RUNNING))
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: ep.port,
        path: urlPath,
        method,
        timeout,
        headers: {
          authorization: `Bearer ${ep.token}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error(`启动器回了看不懂的内容（HTTP ${res.statusCode}）`))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('等启动器太久了（15 分钟），可能是确认弹窗一直没人点')))
    req.on('error', (e) => reject(new Error(`连不上启动器：${e.message}`)))
    if (payload) req.write(payload)
    req.end()
  })
}

const write = (msg: unknown) => {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`)
  } catch {
    /* 客户端断了 */
  }
}

const reply = (id: unknown, result: unknown) => write({ jsonrpc: '2.0', id, result })
const fail = (id: unknown, code: number, message: string) => write({ jsonrpc: '2.0', id, error: { code, message } })

async function handle(msg: { id?: unknown; method?: string; params?: any }): Promise<void> {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: String(params?.protocolVersion ?? PROTOCOL_VERSION),
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, title: 'WFMC 启动器', version: process.env.WFMC_VERSION ?? '' }
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return reply(id, {})

  if (method === 'tools/list') {
    try {
      const res = await request('GET', '/tools')
      const tools = Array.isArray(res?.tools) ? res.tools : []
      return reply(id, {
        tools: tools.map((t: any) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations
        }))
      })
    } catch (e) {
      return fail(id, -32000, (e as Error).message)
    }
  }

  if (method === 'tools/call') {
    const name = String(params?.name ?? '')
    const args = (params?.arguments ?? {}) as Record<string, unknown>
    try {
      const res = await request('POST', '/rpc', { tool: name, args })
      if (res?.denied) {
        return reply(id, {
          content: [{ type: 'text', text: res?.error?.message ?? '用户拒绝了这次操作' }],
          isError: true
        })
      }
      if (!res?.ok) {
        return reply(id, {
          content: [{ type: 'text', text: res?.error?.message ?? '调用失败' }],
          isError: true
        })
      }
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }] })
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: (e as Error).message }], isError: true })
    }
  }

  // 通知（没有 id）不回；未知方法才报错
  if (id === undefined || id === null) return
  return fail(id, -32601, `不认识的方法：${String(method)}`)
}

export function runMcpStdio(): void {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let msg: { id?: unknown; method?: string; params?: any }
    try {
      msg = JSON.parse(text)
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
    }
    void handle(msg).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) fail(msg.id, -32000, String((e as Error)?.message ?? e))
    })
  })
  // 客户端关掉 stdin = 让我退出，别留着占内存
  rl.on('close', () => process.exit(0))
}

runMcpStdio()
