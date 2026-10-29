import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveJava } from '@xmcl/installer'
import type { JavaInfo } from '../shared/types'
import { store } from './store'
import { runProcess } from './proc'

/** 把「Java 安装目录」或「java.exe 路径」统一成真实可执行文件路径；不存在则丢弃 */
function normalizeJavaPath(p?: string): string | undefined {
  if (!p) return undefined
  const lower = p.toLowerCase()
  const candidates: string[] = []
  if (lower.endsWith('java.exe') || lower.endsWith(`${path.sep}java`)) {
    candidates.push(p)
  } else {
    candidates.push(path.join(p, 'bin', 'java.exe'), path.join(p, 'bin', 'java'), p)
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c
    } catch {
      /* 不存在 */
    }
  }
  return undefined
}

/** 扫描系统里所有可用 Java（PATH、JAVA_HOME、常见安装目录） */
export async function scanJava(): Promise<JavaInfo[]> {
  const { getPotentialJavaLocations, scanLocalJava } = await import('@xmcl/installer')
  const found = new Map<string, JavaInfo>()

  const add = (info?: JavaInfo) => {
    if (!info) return
    const exe = normalizeJavaPath(info.path)
    if (!exe) return
    found.set(exe.toLowerCase(), { ...info, path: exe })
  }

  // 1. 扫描环境变量与常见目录
  const homes: string[] = []
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME)
  for (const root of [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\Microsoft\\jdk',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Amazon Corretto'
  ]) {
    try {
      for (const name of fs.readdirSync(root)) homes.push(path.join(root, name))
    } catch {
      /* 目录不存在 */
    }
  }
  // 2. 已安装的 Mojang 运行时
  try {
    for (const name of fs.readdirSync(store.javaDir)) {
      homes.push(path.join(store.javaDir, name))
    }
  } catch {
    /* 还没装过 */
  }

  for (const info of await scanLocalJava(homes)) add(info)

  // 2b. 我们自己的运行时目录：直接跑 java -version 实测。
  // scanLocalJava 认不出时会把装好的运行时漏掉（列表为空），坏文件也可能被当成好的。
  try {
    for (const name of fs.readdirSync(store.javaDir)) {
      const exe = normalizeJavaPath(path.join(store.javaDir, name))
      if (!exe || found.has(exe.toLowerCase())) continue
      const probe = await probeJava(exe)
      if (probe.ok && probe.major) add({ path: exe, version: String(probe.major), majorVersion: probe.major })
    }
  } catch {
    /* 还没装过 */
  }

  // 3. PATH 里的 java
  for (const exe of await getPotentialJavaLocations().catch(() => [] as string[])) {
    const info = await resolveJava(exe).catch(() => undefined)
    add(info)
  }

  if (store.settings.javaPath) {
    const info = await resolveJava(store.settings.javaPath).catch(() => undefined)
    add(info)
  }

  return [...found.values()].sort((a, b) => b.majorVersion - a.majorVersion)
}

/** 根据版本要求的 Java 主版本挑一个最合适的本地 Java（找不到匹配的就返回 undefined，让上层去下载） */
export function pickJava(list: JavaInfo[], requiredMajor?: number): JavaInfo | undefined {
  if (list.length === 0) return undefined
  if (requiredMajor) {
    const exact = list.filter((j) => j.majorVersion === requiredMajor)
    if (exact.length) return exact[0]
    // 更高版本通常能跑低版本，但没有"更低凑合"这回事：MC 21 → Java 17 必炸
    const higher = list.filter((j) => j.majorVersion > requiredMajor).sort((a, b) => a.majorVersion - b.majorVersion)
    if (higher.length) return higher[0]
    return undefined
  }
  return list[0]
}

/**
 * 真的跑一次 java -version。
 * 我们自己的运行时下载可能只下到一半（比如缺 bin/server/jvm.dll），
 * 光看 release 文件会以为它是好的，启动游戏才炸，所以这里实测。
 */
export async function probeJava(exe: string): Promise<{ ok: boolean; major?: number; error?: string }> {
  try {
    const r = await runProcess(exe, ['-version'], { timeoutMs: 10_000 })
    const text = `${r.stdout}\n${r.stderr}`
    if (r.code !== 0) {
      return { ok: false, error: text.trim().split(/\r?\n/)[0] || 'java -version 退出码 ' + r.code }
    }
    const m = text.match(/version "(\d+)/)
    const major = m ? Number(m[1]) : undefined
    return { ok: true, major }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}

/** 一个 Java 是否在我们自己的运行时目录里（坏掉的话自己删掉重下） */
function ownedRuntimeDir(exe: string): string | undefined {
  try {
    const rel = path.relative(store.javaDir, exe)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
    const first = rel.split(/[\\/]/)[0]
    return path.join(store.javaDir, first)
  } catch {
    return undefined
  }
}

/** 用 Mojang 官方运行时安装包安装指定 Java 组件（jre-legacy / java-runtime-alpha / gamma / delta） */
interface RuntimeFile {
  type: string
  executable?: boolean
  downloads?: { raw?: { url: string; sha1?: string; size?: number } }
}
interface RuntimeManifest {
  files: Record<string, RuntimeFile>
}

/**
 * 用 Electron 的 net.fetch（Chromium 网络栈）取元数据：
 * 本机 Node 的 fetch 在这几个域名上会被 DNS 污染/超时，Chromium 走同样的系统解析却更稳。
 */
async function fetchJsonRetry<T>(url: string, tries = 4, timeoutMs = 30_000): Promise<T> {
  let lastErr: unknown
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      lastErr = e
      if (i < tries) await new Promise((r) => setTimeout(r, 800 * i))
    }
  }
  throw new Error(`拉取失败：${(lastErr as Error)?.message ?? '网络错误'}（${url}）`)
}

/** 流式算 sha1，避免大文件一次读进内存 */
function sha1Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    const s = fs.createReadStream(file)
    s.on('data', (c) => h.update(c as Buffer))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/**
 * 单文件下载 + 断点续传 + 完整性校验。
 *
 * 本机到 piston-data 的链路经常在中途被重置：流"正常"结束但只下到一半，
 * 以前直接 rename 当成功 —— 结果就是「提示装好了，java 却起不来（Failed to load jvm.dll）」。
 * 所以这里必须比 size 和 sha1（Mojang 清单里两者都有），不符就丢掉重下。
 */
export async function fetchToFile(
  url: string,
  dest: string,
  expect: { size?: number; sha1?: string } = {},
  maxAttempts = 20,
  onRetry?: (msg: string) => void
): Promise<number> {
  const part = `${dest}.part`
  let lastErr: unknown
  let prevSize = -1
  let stalls = 0
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      let start = 0
      const st = await fs.promises.stat(part).catch(() => undefined)
      if (st && st.size > 0) start = st.size
      const res = await fetch(url, {
        headers: start ? { Range: `bytes=${start}-` } : undefined,
        signal: AbortSignal.timeout(180_000)
      })
      if (res.status === 416 && start > 0) start = 0
      if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const append = res.status === 206 && start > 0
      const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' })
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!out.write(Buffer.from(value))) {
            await new Promise<void>((r) => out.once('drain', () => r()))
          }
        }
      }
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve()))
      )
      const got = (await fs.promises.stat(part)).size
      if (expect.size && got !== expect.size) throw new Error(`断流（${got} / ${expect.size} 字节）`)
      if (expect.sha1) {
        const h = await sha1Of(part)
        if (h.toLowerCase() !== expect.sha1.toLowerCase()) throw new Error('校验不过（文件不完整）')
      }
      await fs.promises.rename(part, dest)
      return got
    } catch (e) {
      lastErr = e
      const msg = (e as Error).message
      const broken = /校验不过/.test(msg)
      // 校验不过 / 大小已超：整份丢掉从头来；只是断流则留着 .part 下一轮续传
      const cur = await fs.promises.stat(part).then((s) => s.size).catch(() => 0)
      if (broken || (expect.size && cur >= expect.size)) await fs.promises.rm(part, { force: true }).catch(() => undefined)
      // 无线续传靠"这轮有没有比上一轮更长"判断：连续两轮没进度就放弃，别死循环
      if (cur > prevSize) {
        prevSize = cur
        stalls = 0
      } else {
        stalls++
      }
      if (stalls >= 3) break
      onRetry?.(
        `${path.basename(dest)} 第 ${i} 次没下完（${msg}），${
          cur > 0 && !broken ? '从 ' + (cur / 1048576).toFixed(1) + ' MB 续传' : '重试'
        }`
      )
      await new Promise((r) => setTimeout(r, 600 + 400 * Math.min(i, 5)))
    }
  }
  throw lastErr ?? new Error('下载失败')
}

/** Mojang 官方的「Java 运行时索引」：平台 → 组件 → 清单地址 */
const JAVA_RUNTIME_INDEX =
  'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'

function platformKey(): string {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64'
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os'
  return 'linux'
}

export async function installJavaRuntime(component: string, log?: (line: string) => void): Promise<string> {
  const dest = path.join(store.javaDir, component)
  const jvmLib = path.join(dest, 'bin', 'server', process.platform === 'win32' ? 'jvm.dll' : 'libjvm.so')
  // 上次下到一半被打断（有 .wfmc-partial 标记）就接着下；没标记又缺 jvm 库的，是老版本留下的坏目录，删掉重来
  const marker = path.join(dest, '.wfmc-partial')
  if (fs.existsSync(dest) && !fs.existsSync(jvmLib)) {
    if (fs.existsSync(marker)) {
      log?.(`[WFMC] 接着上次没下完的 ${component} 继续（已下好的文件会跳过）`)
    } else {
      log?.(`[WFMC] 发现 ${component} 的旧文件不完整（缺 jvm 库），先清理再重下`)
      fs.rmSync(dest, { recursive: true, force: true })
    }
  }
  const mb = (n: number) => (n / 1048576).toFixed(1)

  log?.(`[WFMC] 正在读取 ${component} 的文件清单…`)
  const index = await fetchJsonRetry<Record<string, Record<string, { manifest?: { url?: string } }[]>>>(
    JAVA_RUNTIME_INDEX
  )
  const bucket = index[platformKey()]?.[component]
  const manifestUrl = Array.isArray(bucket) ? bucket[0]?.manifest?.url : undefined
  if (!manifestUrl) throw new Error(`官方清单里没有 ${component}（${platformKey()}）`)
  const manifest = await fetchJsonRetry<RuntimeManifest>(manifestUrl, 4, 60_000)

  const files = Object.entries(manifest.files ?? {}).filter(
    ([, f]) => f.type === 'file' && f.downloads?.raw?.url
  )
  if (!files.length) throw new Error(`${component} 清单里没有可下载文件`)

  const total = files.reduce((n, [, f]) => n + (f.downloads?.raw?.size ?? 0), 0)
  let done = 0
  let finished = 0
  const started = Date.now()
  await fs.promises.mkdir(dest, { recursive: true }).catch(() => undefined)
  await fs.promises.writeFile(marker, String(started)).catch(() => undefined)

  // 进度写进日志（有变化才写，最多每 3 秒一行），避免刷屏又不至于让用户以为卡死
  let lastLog = 0
  let lastDone = -1
  const timer = log
    ? setInterval(() => {
        const now = Date.now()
        if (now - lastLog < 3000 || done === lastDone) return
        lastLog = now
        lastDone = done
        const pct = total ? Math.min(99, Math.round((done / total) * 100)) : 0
        const secs = Math.round((now - started) / 1000)
        log(`[WFMC] 下载 Java 运行时 ${mb(done)} / ${mb(total)} MB（${pct}%，已等 ${secs}s）`)
      }, 1000)
    : undefined

  try {
    // 分轮下载：一轮里个别文件实在下不动就先记下来，整轮结束后接着补，
    // 断网/抖动时不会因为一两个小文件把整份 94MB 判死（已下好的文件下一轮直接跳过）
    let pending = [...files]
    for (let round = 1; round <= 4 && pending.length; round++) {
      const queue = pending.splice(0)
      const failed: typeof files = []
      const worker = async () => {
        for (;;) {
          const item = queue.shift()
          if (!item) return
          const [rel, f] = item
          const raw = f.downloads?.raw
          if (!raw) continue
          const target = path.join(dest, rel.replace(/[\\/]+/g, path.sep))
          const size = raw.size ?? 0
          // 已下好的文件跳过——但要连 sha1 一起验：只比大小会把上次断流的坏文件永久跳过
          const stat = await fs.promises.stat(target).catch(() => undefined)
          const sameSize = !!stat && (!size || stat.size === size)
          const sameHash = !!stat && sameSize && (!raw.sha1 || (await sha1Of(target).catch(() => '')) === raw.sha1.toLowerCase())
          if (stat && sameSize && sameHash) {
            done += stat.size
            finished++
            continue
          }
          if (stat && !sameHash) await fs.promises.rm(target, { force: true }).catch(() => undefined)
          try {
            const got = await fetchToFile(raw.url, target, { size, sha1: raw.sha1 }, 20, (m) => log?.(`[WFMC] ${m}`))
            done += got
            finished++
            if (f.executable) {
              try {
                fs.chmodSync(target, 0o755)
              } catch {
                /* Windows 不需要 */
              }
            }
          } catch (e) {
            failed.push(item)
            log?.(`[WFMC] ${path.basename(target)} 这一轮没下来（${(e as Error).message}），下一轮再补`)
          }
        }
      }
      // 并发别开太大：这台机器到 piston-data 的链路一挤就断流，4 路反而更稳
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
      pending = failed
      if (pending.length && round < 4) {
        log?.(`[WFMC] 还有 ${pending.length} 个文件没下完，继续第 ${round + 1} 轮…`)
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
  } finally {
    if (timer) clearInterval(timer)
  }

  log?.(`[WFMC] Java 运行时文件就绪：${finished} 个文件 / ${mb(total)} MB`)

  // 少下文件时不能算装好：缺 jvm 库是最典型的（游戏启动时会报 Failed to load jvm.dll）
  if (!fs.existsSync(jvmLib)) {
    fs.rmSync(dest, { recursive: true, force: true })
    throw new Error('下载完成后缺少 jvm 库，已清空，重试一次即可（一直失败就检查磁盘空间或杀软拦截）')
  }
  if (finished < files.length) {
    throw new Error(`只下到 ${finished} / ${files.length} 个文件，重试一次即可（已下好的会跳过）`)
  }
  const entryFile = Object.keys(manifest.files ?? {}).find((p) => /bin[\\/]java(\.exe)?$/i.test(p))
  if (!entryFile) throw new Error('运行时安装完成但没找到 java 可执行文件')
  const exe = path.join(dest, entryFile.replace(/[\\/]+/g, path.sep))

  // 光看文件齐了不算数：真跑一次 java -version（断流的文件 sha1 会露馅，但再兜一层）
  log?.(`[WFMC] 正在自检 java -version…`)
  const probe = await probeJava(exe)
  if (!probe.ok) {
    fs.rmSync(dest, { recursive: true, force: true })
    throw new Error(
      `装好的 Java 起不来（${probe.error ?? '未知原因'}），已清空重来。网络不稳时多点两次；一直不行就到「设置 → Java 运行时」手动指定本机的 java.exe。`
    )
  }
  log?.(`[WFMC] Java ${probe.major ?? '?'} 自检通过`)
  await fs.promises.rm(marker, { force: true }).catch(() => undefined)
  return exe
}

/** 根据版本号映射 Java 主版本 */
export function requiredJavaMajor(mcVersion: string): number {
  const v = mcVersion.trim()
  // 新版是年份式版本号（26.3 = 2026 年 3 月），这类一律要 Java 21+
  if (!/^1\./.test(v)) return 21
  const parts = v.replace(/^.*?(1\.\d+(?:\.\d+)?).*$/, '$1').split('.').map((n) => Number(n))
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  if (minor > 20) return 21
  if (minor === 20) return patch >= 5 ? 21 : 17
  if (minor >= 18) return 17
  if (minor === 17) return 16
  return 8
}

/** 确保有可用 Java：本地有匹配版本就用，没有就下官方的 */
export async function ensureJava(
  mcVersion: string,
  preferred?: string,
  log?: (line: string) => void,
  majorOverride?: number
): Promise<string> {
  const major = majorOverride && majorOverride > 0 ? majorOverride : requiredJavaMajor(mcVersion)
  if (preferred) {
    const exe = normalizeJavaPath(preferred)
    if (exe) {
      const info = await resolveJava(exe).catch(() => undefined)
      // 用户手动指定的 Java 也要够新：17 跑不了 1.21（class 65.0）
      // 而且要真的能跑起来（运行时缺 jvm.dll 时 resolveJava 依然会报 21）
      if (info && info.majorVersion >= major) {
        const alive = await probeJava(exe)
        if (alive.ok) return normalizeJavaPath(info.path) ?? exe
        log?.(`[WFMC] 指定的 Java 起不来（${alive.error ?? '未知原因'}），改用自动挑选`)
      }
      if (info) {
        log?.(
          `[WFMC] 指定的 Java ${info.majorVersion} 太旧（${mcVersion} 需要 Java ${major}），改用自动挑选`
        )
      }
    }
  }
  const list = await scanJava()
  const found = pickJava(list, major)
  if (found) {
    const exe = normalizeJavaPath(found.path)
    if (exe) {
      const alive = await probeJava(exe)
      if (alive.ok) {
        log?.(`[WFMC] 选用 Java ${found.majorVersion}（${mcVersion} 需要 ${major}）`)
        return exe
      }
      // 我们自己下坏的运行时：删掉，下面重新下
      const owned = ownedRuntimeDir(exe)
      log?.(`[WFMC] Java ${found.majorVersion} 起不来（${alive.error ?? '未知原因'}）` + (owned ? `，这个运行时是残缺的，重新下载` : `,换成别的 Java`))
      if (owned) {
        try {
          fs.rmSync(owned, { recursive: true, force: true })
        } catch {
          /* 删不掉就算了 */
        }
      }
    }
  }

  const component =
    major >= 21 ? 'java-runtime-delta' : major >= 17 ? 'java-runtime-gamma' : major >= 16 ? 'java-runtime-beta' : 'jre-legacy'
  log?.(`[WFMC] 本机没有 Java ${major}，开始下载官方运行时（${component}，约 40MB）…`)
  // 偶尔会有单个文件下载失败整批回滚，自动重试一次（已下好的文件会跳过）
  let installed = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      installed = await installJavaRuntime(component, log)
      break
    } catch (e) {
      if (attempt === 2) {
        log?.(`[WFMC] Java ${major} 下载失败：${(e as Error).message}。可以到设置里手动指定一个 Java ${major}。`)
        throw e
      }
      log?.(`[WFMC] Java ${major} 下载中断，重试一次…`)
    }
  }
  log?.(`[WFMC] Java ${major} 装好了：${installed}`)
  return installed
}

/** 把网络类异常翻成人话，别把 AggregateError 这种原始报错甩给用户 */
export function friendlyJavaError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string } }
  const msg = err?.message ?? String(e)
  const code = err?.cause?.code ?? ''
  const joined = `${msg} ${code}`
  if (/AggregateError|fetch failed|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TimeoutError|EAI_AGAIN|aborted/i.test(joined)) {
    return '连不上下载服务器（网络或 DNS 问题）。点一次重试；还不行就到「Java 运行时」里手动指定本机的 java.exe。'
  }
  const http = msg.match(/HTTP (\d+)/)
  if (http) return `下载服务器返回 HTTP ${http[1]}，稍后重试。`
  return msg
}