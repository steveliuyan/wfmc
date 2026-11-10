import fs from 'node:fs'
import path from 'node:path'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { collectDirFiles, readFileInsideZip, writeZip } from './zip'
import { downloadFile, fetchJson } from './net'

/**
 * 导出「服务端整合包」：一个丢到服务器上一解压就能开服的 zip。
 *
 * 跟客户端 bundle 的区别只有两条，但都很致命：
 *   1. 只能带**服务端需要**的 mod。把 sodium / iris / 小地图这类纯客户端 mod 带上，
 *      服务端会直接崩在模组加载阶段（NoClassDefFoundError: net/minecraft/client/...）。
 *   2. 要带**加载器服务端本体**和启动脚本。玩家机器上只有客户端，没有这些东西。
 *
 * 判定「哪些是纯客户端 mod」按可信度从高到低：
 *   a) Modrinth 元数据（server_side === 'unsupported'）—— 最权威，覆盖绝大多数 mod
 *   b) jar 里的 fabric.mod.json / quilt.mod.json 的 `environment: "client"`
 *   c) 内置的知名纯客户端 mod id 表（sodium/iris/小地图…）
 *   d) 都没有 → 保留（宁可多带一个还能跑，也不能少带一个开不了服）
 */

export type ModSide = 'client' | 'server' | 'both' | 'unknown'

export interface ModSideInfo {
  /** 文件名（不含目录） */
  file: string
  /** 绝对路径，导出时用 */
  path: string
  id?: string
  name?: string
  side: ModSide
  /** 判定依据，直接展示给人看 */
  why: string
}

export interface ServerPackPreview {
  mcVersion: string
  loader: string
  loaderVersion?: string
  totalMods: number
  /** 会被剔除的纯客户端 mod */
  clientOnly: ModSideInfo[]
  /** 其余全部保留 */
  keep: number
}

export interface ServerPackResult extends ServerPackPreview {
  path: string
  removed: { file: string; id?: string; why: string }[]
  /** 包里加载器相关文件的名字 */
  loaderFiles: string[]
}

/** 兜底的知名纯客户端 mod id（小写）；Modrinth 与 jar 元数据都查不到时才用 */
const CLIENT_ONLY_IDS = new Set([
  'sodium',
  'sodium-extra',
  'iris',
  'oculus',
  'embeddium',
  'rubidium',
  'optifine',
  'optifabric',
  'entityculling',
  'immediatelyfast',
  'dynamic-fps',
  'fpsdisplay',
  'betterfps',
  'zoomify',
  'ok-zoomer',
  'logic-zoom',
  'controlling',
  'mousetweaks',
  'mouse-tweaks',
  'toast-control',
  'betterf3',
  'better-third-person',
  'shoulder-surfing-reloaded',
  'not-enough-animations',
  '3dskinlayers',
  'skinlayers3d',
  'customskinloader',
  'capes',
  'chat-heads',
  'blur',
  'presence-footsteps',
  'ambientsounds',
  'music-duration-reducer',
  'smooth-swapping',
  'legendary-tooltips',
  'tooltipfix',
  'enhancedblockentities',
  'continuity',
  'lambdabettergrass',
  'lambdadynamiclights',
  'distant-horizons',
  'xaeros-minimap',
  'xaeros-world-map',
  'journeymap',
  'minimap',
  'appleskin',
  'itemscroller',
  'inventory-profiles'
])

/** 服务端要从实例里带的目录（saves/logs/screenshots 是玩家的东西，不带） */
const SERVER_FOLDERS = ['config', 'defaultconfigs', 'scripts', 'kubejs', 'datapacks']

function readJsonInside(jar: string, name: string): any | undefined {
  try {
    if (!fs.existsSync(jar)) return undefined
    const buf = readFileInsideZip(jar, name)
    if (!buf) return undefined
    return JSON.parse(buf.toString('utf-8'))
  } catch {
    return undefined
  }
}

/** 从 jar 自带元数据里读 id / name / 声明的运行环境 */
function readLocalMeta(jar: string): { id?: string; name?: string; environment?: string } {
  const fab = readJsonInside(jar, 'fabric.mod.json')
  if (fab?.id) {
    return { id: String(fab.id), name: fab.name ? String(fab.name) : undefined, environment: fab.environment ? String(fab.environment) : undefined }
  }
  const quilt = readJsonInside(jar, 'quilt.mod.json')
  const ql = quilt?.quilt_loader
  if (ql?.id) {
    const env = quilt?.minecraft?.environment ?? ql?.metadata?.environment
    return {
      id: String(ql.id),
      name: ql.metadata?.name ? String(ql.metadata.name) : undefined,
      environment: env ? String(env) : undefined
    }
  }
  const toml = readFileInsideZip(jar, 'META-INF/neoforge.mods.toml') ?? readFileInsideZip(jar, 'META-INF/mods.toml')
  if (toml) {
    const text = toml.toString('utf-8')
    const id = /^\s*modId\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
    const name = /^\s*displayName\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]
    // Forge 侧没有 environment 字段；只有 `clientSideOnly = true`（极少数 mod 会写）
    const clientOnly = /^\s*clientSideOnly\s*=\s*true/m.test(text)
    return { id, name, environment: clientOnly ? 'client' : undefined }
  }
  return {}
}

interface ModrinthProjectLite {
  id: string
  slug?: string
  title?: string
  client_side?: string
  server_side?: string
}

/**
 * 用 Modrinth 的元数据校正侧别：拿 jar 的 sha1 反查版本 → 项目 → client_side/server_side。
 * 查不到（mod 只在 CurseForge 有）就保持本地判定。网络失败整段跳过，不影响导出。
 */
async function modrinthSides(files: string[], signal?: AbortSignal): Promise<Map<string, ModrinthProjectLite>> {
  const out = new Map<string, ModrinthProjectLite>()
  const crypto = await import('node:crypto')
  const hashToFile = new Map<string, string>()
  for (const f of files) {
    try {
      const sha1 = crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
      hashToFile.set(sha1, f)
    } catch {
      /* 读不出来的文件跳过 */
    }
  }
  const hashes = [...hashToFile.keys()]
  if (hashes.length === 0) return out

  const ua = { 'user-agent': 'wfmc-launcher/1.3.4 (server pack export)', 'content-type': 'application/json' }

  // sha1 → 版本（一次最多 100 个）
  const versionToProject = new Map<string, string>()
  for (let i = 0; i < hashes.length; i += 100) {
    const batch = hashes.slice(i, i + 100)
    try {
      const versions = await fetchJson<Record<string, { project_id?: string }>>('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: ua,
        body: JSON.stringify({ hashes: batch, algorithm: 'sha1' }),
        signal
      })
      for (const [sha, v] of Object.entries(versions ?? {})) {
        const f = hashToFile.get(sha)
        if (f && v?.project_id) versionToProject.set(f, v.project_id)
      }
    } catch {
      /* 这一批算了，用本地判定 */
    }
  }
  const projectIds = [...new Set(versionToProject.values())]
  if (projectIds.length === 0) return out

  const projects = new Map<string, ModrinthProjectLite>()
  for (let i = 0; i < projectIds.length; i += 50) {
    const batch = projectIds.slice(i, i + 50)
    try {
      const list = await fetchJson<ModrinthProjectLite[]>(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`,
        { headers: ua, signal }
      )
      for (const p of list ?? []) projects.set(p.id, p)
    } catch {
      /* 同上 */
    }
  }
  for (const [file, pid] of versionToProject) {
    const p = projects.get(pid)
    if (p) out.set(file, p)
  }
  return out
}

/** 判定一个实例里每个 mod 的侧别（network=true 时用 Modrinth 校正） */
export async function classifyInstanceMods(
  instanceId: string,
  opts: { network?: boolean; signal?: AbortSignal } = {}
): Promise<{ mods: ModSideInfo[]; instance: NonNullable<ReturnType<typeof store.getInstance>> }> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const jars = fs.existsSync(modsDir)
    ? fs
        .readdirSync(modsDir)
        .filter((n) => n.toLowerCase().endsWith('.jar'))
        .map((n) => path.join(modsDir, n))
        .sort()
    : []

  const mods: ModSideInfo[] = jars.map((p) => {
    const meta = readLocalMeta(p)
    const file = path.basename(p)
    if (meta.environment === 'client') {
      return { file, path: p, id: meta.id, name: meta.name, side: 'client', why: 'jar 元数据声明仅客户端' }
    }
    if (meta.environment === 'server') {
      return { file, path: p, id: meta.id, name: meta.name, side: 'server', why: 'jar 元数据声明仅服务端' }
    }
    const idKey = (meta.id ?? file.replace(/\.jar$/i, '')).toLowerCase()
    if (CLIENT_ONLY_IDS.has(idKey)) {
      return { file, path: p, id: meta.id, name: meta.name, side: 'client', why: '知名纯客户端 mod' }
    }
    return { file, path: p, id: meta.id, name: meta.name, side: 'unknown', why: '' }
  })

  if (opts.network !== false) {
    try {
      const byFile = await modrinthSides(
        mods.map((m) => m.path),
        opts.signal
      )
      for (const m of mods) {
        const p = byFile.get(m.path)
        if (!p) continue
        if (p.server_side === 'unsupported') {
          m.side = 'client'
          m.why = `Modrinth：${p.title ?? p.slug ?? m.id ?? '该 mod'} 不支持服务端`
        } else if (p.client_side === 'unsupported') {
          m.side = 'server'
          m.why = `Modrinth：${p.title ?? p.slug ?? m.id ?? '该 mod'} 仅服务端需要`
        } else {
          m.side = 'both'
          m.why = `Modrinth：两端都可用`
        }
      }
    } catch {
      /* 网络不给力就算了，本地判定已经够用 */
    }
  }
  return { mods, instance }
}

/** 界面预检：列出「会被剔除的纯客户端 mod」，不下载任何东西 */
export async function previewServerPack(instanceId: string, signal?: AbortSignal): Promise<ServerPackPreview> {
  const { mods, instance } = await classifyInstanceMods(instanceId, { signal })
  const clientOnly = mods.filter((m) => m.side === 'client')
  return {
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    loaderVersion: instance.loaderVersion,
    totalMods: mods.length,
    clientOnly,
    keep: mods.length - clientOnly.length
  }
}

/** 下载加载器服务端本体，返回要写进 zip 的条目 */
async function fetchLoaderArtifacts(
  loader: string,
  mcVersion: string,
  loaderVersion: string | undefined,
  dir: string,
  onProgress: (phase: string) => void,
  signal?: AbortSignal
): Promise<{ files: { name: string; full: string }[]; start: 'fabric' | 'quilt' | 'forge' | 'neoforge' }> {
  const files: { name: string; full: string }[] = []
  const mirror = store.settings.downloadSource !== 'official'
  const pick = (rel: string, official: string) => {
    const mirrors = [
      `https://bmclapi2.bangbang93.com/maven/${rel}`,
      `https://download.mcbbs.net/maven/${rel}`,
      `https://maven.aliyun.com/repository/public/${rel}`
    ]
    return mirror ? [...mirrors, official] : [official, ...mirrors]
  }

  if (loader === 'fabric') {
    onProgress('获取 Fabric 安装器版本')
    let installer = '1.0.1'
    try {
      const list = await fetchJson<{ version: string; stable?: boolean }[]>(
        'https://meta.fabricmc.net/v2/versions/installer',
        { signal }
      )
      installer = list?.find((x) => x.stable)?.version ?? list?.[0]?.version ?? installer
    } catch {
      /* 拿不到就用默认，下面的 URL 依然大概率有效 */
    }
    const lv = loaderVersion ?? ''
    if (!lv) throw new Error('这个实例没记录 Fabric loader 版本，没法生成服务端包')
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(lv)}/${encodeURIComponent(installer)}/server/jar`
    const dest = path.join(dir, 'fabric-server-launch.jar')
    onProgress('下载 Fabric 服务端启动器')
    await downloadFile(url, dest, undefined, { signal, skipIfExists: false })
    files.push({ name: 'fabric-server-launch.jar', full: dest })
    return { files, start: 'fabric' }
  }

  if (loader === 'quilt') {
    const lv = loaderVersion ?? ''
    if (!lv) throw new Error('这个实例没记录 Quilt loader 版本，没法生成服务端包')
    onProgress('获取 Quilt 安装器版本')
    let ver = '0.15.1'
    try {
      const list = await fetchJson<{ version: string }[]>('https://meta.quiltmc.org/v3/versions/installer', { signal })
      ver = list?.[0]?.version ?? ver
    } catch {
      /* 用默认 */
    }
    const dest = path.join(dir, 'quilt-installer.jar')
    onProgress('下载 Quilt 安装器')
    await downloadFile(
      `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${ver}/quilt-installer-${ver}.jar`,
      dest,
      undefined,
      { signal, skipIfExists: false }
    )
    files.push({ name: 'quilt-installer.jar', full: dest })
    return { files, start: 'quilt' }
  }

  // Forge / NeoForge：两个都是 installer jar，第一次启动时在服务器上装
  const lv = loaderVersion ?? ''
  if (!lv) throw new Error(`这个实例没记录 ${loader} 版本，没法生成服务端包`)
  const full = loader === 'forge' ? `${mcVersion}-${lv}` : lv
  const rel =
    loader === 'forge'
      ? `net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
      : `net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`
  const official =
    loader === 'forge'
      ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`
      : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${full}/neoforge-${full}-installer.jar`
  const dest = path.join(dir, `${loader}-installer.jar`)
  onProgress(`下载 ${loader} 服务端安装器`)
  await downloadFile(pick(rel, official), dest, undefined, { signal, skipIfExists: false })
  files.push({ name: `${loader}-installer.jar`, full: dest })
  return { files, start: loader === 'forge' ? 'forge' : 'neoforge' }
}

/** 启动脚本与说明（CRLF，Windows 记事本也不会串行） */
function loaderScripts(
  kind: 'fabric' | 'quilt' | 'forge' | 'neoforge',
  mcVersion: string,
  loader: string,
  loaderVersion: string,
  ram: string
): { name: string; text: string }[] {
  const bat: string[] = ['@echo off', 'chcp 65001 >nul', 'title WFMC 服务端']
  const sh: string[] = ['#!/usr/bin/env bash', 'set -e', 'cd "$(dirname "$0")"']
  let javaLine = ''
  let javaLineSh = ''

  if (kind === 'fabric') {
    javaLine = `java -Xmx${ram} -jar fabric-server-launch.jar nogui`
    javaLineSh = `exec java -Xmx${ram} -jar fabric-server-launch.jar nogui`
  } else if (kind === 'quilt') {
    bat.push('if not exist quilt-server-launch.jar (')
    bat.push(`  echo [WFMC] 首次启动：安装 Quilt 服务端（需要联网，几分钟）`)
    bat.push(`  java -jar quilt-installer.jar install server ${mcVersion} ${loaderVersion} --download-server`)
    bat.push(')')
    javaLine = `java -Xmx${ram} -jar quilt-server-launch.jar nogui`
    sh.push('if [ ! -f quilt-server-launch.jar ]; then')
    sh.push(`  java -jar quilt-installer.jar install server ${mcVersion} ${loaderVersion} --download-server`)
    sh.push('fi')
    javaLineSh = `exec java -Xmx${ram} -jar quilt-server-launch.jar nogui`
  } else {
    const argsPath =
      kind === 'forge'
        ? `libraries/net/minecraftforge/forge/${mcVersion}-${loaderVersion}/win_args.txt`
        : `libraries/net/neoforged/neoforge/${loaderVersion}/win_args.txt`
    const argsPathSh = argsPath.replace('win_args.txt', 'unix_args.txt')
    bat.push('if not exist libraries (')
    bat.push(`  echo [WFMC] 首次启动：安装 ${kind} 服务端（需要联网，几分钟）`)
    bat.push(`  java -jar ${kind}-installer.jar --installServer`)
    bat.push(')')
    bat.push('if exist run.bat (')
    bat.push('  call run.bat nogui')
    bat.push(') else (')
    bat.push(`  java -Xmx${ram} @${argsPath} nogui`)
    bat.push(')')
    sh.push('if [ ! -d libraries ]; then')
    sh.push(`  java -jar ${kind}-installer.jar --installServer`)
    sh.push('fi')
    sh.push(`if [ -f run.sh ]; then`)
    sh.push('  exec ./run.sh nogui')
    sh.push('else')
    sh.push(`  exec java -Xmx${ram} @${argsPathSh} nogui`)
    sh.push('fi')
  }

  if (kind === 'fabric') {
    sh.push(javaLineSh)
  }
  bat.push(javaLine, 'echo.', 'echo 服务端已停止，按任意键关闭窗口', 'pause >nul')

  const readme = [
    `WFMC 服务端整合包（${loader} ${loaderVersion} / Minecraft ${mcVersion}）`,
    '',
    '怎么开服：',
    '  1. 装 Java 17 或更高（1.17 以下用 Java 8），确认命令行里能跑 java -version',
    `  2. 打开 eula.txt，把 eula=false 改成 eula=true（表示你接受 Minecraft 最终用户许可协议）`,
    '  3. Windows 双击 start.bat，Linux/macOS 运行 ./start.sh',
    '  4. 第一次启动会自动下载/安装服务端（需要联网，可能几分钟），之后再启动就很快',
    '',
    '说明：',
    '  · 纯客户端 mod 已经剔掉了（见本文件末尾），带上它们服务端会崩',
    '  · 内存默认 ' + ram + '，改 start.bat / start.sh 里的 -Xmx 即可',
    '  · server.properties 第一次启动时自动生成，改完端口记得重启',
    ''
  ].join('\r\n')

  return [
    { name: 'start.bat', text: bat.join('\r\n') + '\r\n' },
    { name: 'start.sh', text: sh.join('\n') + '\n' },
    { name: 'eula.txt', text: 'eula=false\r\n' },
    { name: 'README.txt', text: readme }
  ]
}

export async function exportInstanceAsServerPack(
  instanceId: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<ServerPackResult> {
  const key = `serverpack-${instanceId}`
  const progress = (phase: string, current?: number, total?: number) => onProgress?.({ key, phase, current, total })

  progress('判定哪些 mod 是纯客户端')
  const { mods, instance } = await classifyInstanceMods(instanceId, { signal })
  const keep = mods.filter((m) => m.side !== 'client')
  const removed = mods.filter((m) => m.side === 'client')

  const gameDir = gamePathFor(instance)
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const tempDir = path.join(store.dataDir, 'temp', `serverpack-${stamp}`)
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    progress('准备加载器服务端文件', 0, 3)
    const { files: loaderFiles, start } = await fetchLoaderArtifacts(
      instance.loader,
      instance.mcVersion,
      instance.loaderVersion,
      tempDir,
      (phase) => progress(phase),
      signal
    )

    progress('写启动脚本', 1, 3)
    const scripts = loaderScripts(
      start,
      instance.mcVersion,
      instance.loader,
      instance.loaderVersion ?? '',
      '4G'
    )

    const items: { name: string; full: string }[] = []
    for (const m of keep) items.push({ name: `mods/${m.file}`, full: m.path })
    for (const folder of SERVER_FOLDERS) {
      const dir = path.join(gameDir, folder)
      if (!fs.existsSync(dir)) continue
      for (const f of collectDirFiles(dir)) items.push({ name: `${folder}/${f.name}`, full: f.full })
    }
    items.push(...loaderFiles)
    for (const s of scripts) {
      const p = path.join(tempDir, s.name)
      fs.writeFileSync(p, s.text, 'utf-8')
      items.push({ name: s.name, full: p })
    }
    // 被剔除的 mod 列进 README，免得开服后发现某个功能没了不知道原因
    if (removed.length) {
      const note = path.join(tempDir, 'README.txt')
      const extra = [
        '',
        `已剔除的纯客户端 mod（${removed.length} 个）：`,
        ...removed.map((r) => `  · ${r.file}${r.id ? ` (${r.id})` : ''} —— ${r.why || '仅客户端'}`),
        ''
      ].join('\r\n')
      fs.appendFileSync(note, extra, 'utf-8')
    }

    progress(`打包 ${items.length} 个文件`, 2, 3)
    const out = path.join(
      store.exportsDir,
      `${instance.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'instance'}-${instance.mcVersion}-${stamp}-server.zip`
    )
    fs.mkdirSync(store.exportsDir, { recursive: true })
    writeZip(out, items)
    progress(`导出完成：${out}`, 3, 3)

    return {
      path: out,
      mcVersion: instance.mcVersion,
      loader: instance.loader,
      loaderVersion: instance.loaderVersion,
      totalMods: mods.length,
      clientOnly: removed,
      keep: keep.length,
      removed: removed.map((r) => ({ file: r.file, id: r.id, why: r.why })),
      loaderFiles: loaderFiles.map((f) => f.name)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

