import fs from 'node:fs'
import path from 'node:path'
import type { CrashDiagnosis } from '../shared/types'
import { store } from './store'

interface Rule {
  match: RegExp
  title: string
  advice: string
}

/** 常见崩溃原因 → 人话建议（照 Daybreak 那套思路做的规则表） */
const RULES: Rule[] = [
  {
    match: /java\.lang\.OutOfMemoryError|GC overhead limit exceeded|Java heap space/i,
    title: '内存不够',
    advice: '把最大内存（-Xmx）调大，1.20+ 加光影/mod 建议 6–8 GB；同时确认系统虚拟内存没被占满。'
  },
  {
    match: /UnsupportedClassVersionError|class file version (\d+)|requires at least Java|仅支持 \d+|Java 版本过低/i,
    title: 'Java 版本不匹配',
    advice: '启动器里换对应版本的 Java：1.20.5+ 用 Java 21，1.18–1.20.4 用 17，1.17 用 16，1.16 及更老用 8。'
  },
  {
    match: /NoClassDefFoundError|ClassNotFoundException|NoSuchMethodError|NoSuchFieldError/i,
    title: '缺类 / 类版本冲突',
    advice: '通常是 mod 与游戏版本不匹配，或缺前置（Fabric API / Cloth Config / Architectury）。检查 mods 目录里是否有错版本。'
  },
  {
    match: /DuplicateModsFoundException|duplicate mod|两个同名 mod/i,
    title: '模组重复',
    advice: 'mods 目录里有同一个 mod 的两个文件（比如 sodium 装了两份），删掉旧的那个。'
  },
  {
    match: /ModResolutionException|Incompatible mod set|requires .* which is missing|depends on/i,
    title: '模组依赖不满足',
    advice: '按日志里提示的缺失项补前置，或把不兼容的 mod 移出 mods 目录逐个排查。'
  },
  {
    match: /Mixin apply failed|MixinTransformerError|mixin.*failed/i,
    title: 'Mixin 注入失败',
    advice: 'mod 与游戏/加载器版本不匹配，或者两个 mod 改了同一处代码。先只留一个可疑 mod 试。'
  },
  {
    match: /org\.lwjgl\.LWJGLException|Pixel format not accelerated|GLFW error|Failed to create window|OpenGL/i,
    title: '显卡 / 图形驱动问题',
    advice: '更新显卡驱动；核显机器可试着调低分辨率或关掉光影；远程桌面/虚拟机会缺 OpenGL 支持。'
  },
  {
    match: /java\.net\.ConnectException|UnknownHostException|Failed to download|Connection reset|SSLHandshakeException/i,
    title: '网络连接失败',
    advice: '下载源切到 BMCLAPI 镜像，或检查代理设置；公司/校园网可能拦了 mojang 域名。'
  },
  {
    match: /AccessDeniedException|Permission denied|拒绝访问/i,
    title: '权限不足',
    advice: '启动器或游戏目录在受保护路径（如 C:\\Program Files），把数据目录换到用户目录下。'
  },
  {
    match: /java\.io\.FileNotFoundException.*(versions|\.jar)|ZipException|invalid LOC header|Error:\s*Invalid or corrupt jarfile/i,
    title: '版本文件损坏',
    advice: '点「校验文件」重新补全，或删掉该版本目录重装；磁盘空间不足也会导致文件写坏。'
  },
  {
    match: /The game crashed whilst|exit code: -?\d+|EXCEPTION_ACCESS_VIOLATION|0xc0000005/i,
    title: '游戏进程崩溃',
    advice: '先看上面几行具体异常；若是 EXCEPTION_ACCESS_VIOLATION，多为驱动/优化 mod（如 OptiFine + 光影）冲突。'
  },
  {
    match: /You need to agree to the EULA|Failed to load eula/i,
    title: 'EULA 未同意（服务端）',
    advice: '这是服务端才有的提示：把 eula.txt 里的 eula=false 改成 true。'
  }
]

/** 拿实例里最新的崩溃报告 / 最新日志做诊断 */
export function analyzeLatest(instanceId: string): CrashDiagnosis | undefined {
  const gameDir = store.instanceGameDir(instanceId)
  const candidates: { file: string; mtime: number }[] = []

  const crashDir = path.join(gameDir, 'crash-reports')
  try {
    for (const name of fs.readdirSync(crashDir)) {
      const full = path.join(crashDir, name)
      if (!/\.(txt|log)$/i.test(name)) continue
      candidates.push({ file: full, mtime: fs.statSync(full).mtimeMs })
    }
  } catch {
    /* 没有崩溃报告 */
  }

  const latestLog = path.join(gameDir, 'logs', 'latest.log')
  if (fs.existsSync(latestLog)) candidates.push({ file: latestLog, mtime: fs.statSync(latestLog).mtimeMs })

  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.mtime - a.mtime)
  const target = candidates[0]

  const content = fs.readFileSync(target.file, 'utf-8')
  const allLines = content.split(/\r?\n/)
  const lines = allLines.length

  // 只看最后 6000 行，避免超大日志卡住
  const tail = allLines.slice(-6000)
  const issues: { title: string; advice: string; evidence: string }[] = []

  for (const rule of RULES) {
    const hit = tail.find((line) => rule.match.test(line))
    if (!hit) continue
    if (issues.some((i) => i.title === rule.title)) continue
    issues.push({ title: rule.title, advice: rule.advice, evidence: hit.trim().slice(0, 220) })
    if (issues.length >= 6) break
  }

  const summary = allLines
    .slice(0, 18)
    .filter((l) => l.trim())
    .join('\n')
    .slice(0, 1200)

  return {
    file: target.file,
    generatedAt: target.mtime,
    lines,
    issues,
    summary
  }
}
