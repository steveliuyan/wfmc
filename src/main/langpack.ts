import fs from 'node:fs'
import path from 'node:path'
import { downloadFile } from './net'
import { disableResourcePack, enableResourcePack } from './options'
import { gamePathFor } from './paths'
import { store } from './store'
import { listZipEntries, readFileInsideZip } from './zip'

/**
 * 模组汉化包。
 *
 * 模组里的中文是作者写死在 jar 的 zh_cn.json 里的，没写就是英文 —— 启动器没法凭空翻译。
 * 国内的办法是装「汉化资源包」：包里放着一堆 assets/<modid>/lang/zh_cn.json，
 * 资源包优先级高于 mod 自带语言，加载后模组界面就变中文。
 *
 * 数据源用 VM 汉化组的公开资源包（Modrinth 项目 vmct），覆盖 1.12.2 ~ 最新版本。
 */
const PROJECT = 'vmct'
const API = 'https://api.modrinth.com/v2'
const UA = { 'User-Agent': 'WFMC-Launcher/1.0 (Minecraft launcher)' }

/** CFPA（中文模组翻译联盟）的整合语言包 —— 400 个 modid，跟 VM 的 210 个只重叠 48 个，合起来才够用 */
const CFPA_REPO = 'CFPAOrg/Minecraft-Mod-Language-Package'
const CFPA_MIRRORS = [(u: string) => `https://gh-proxy.com/${u}`, (u: string) => `https://ghfast.top/${u}`, (u: string) => u]

interface MrVersion {
  id: string
  version_number: string
  game_versions: string[]
  files: { url: string; filename: string; size: number; primary: boolean }[]
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`拉取汉化包列表失败（HTTP ${res.status}）`)
  return (await res.json()) as T
}

/** 挑一个覆盖当前 MC 版本的汉化包 */
export async function pickLangPack(mcVersion: string): Promise<{ version: MrVersion; file: MrVersion['files'][number]; exact: boolean }> {
  const list = await getJson<MrVersion[]>(`${API}/project/${PROJECT}/version`)
  const scored = list
    .map((v) => {
      const exact = v.game_versions.includes(mcVersion)
      const covers = v.game_versions.some((g) => g.startsWith(mcVersion.split('.').slice(0, 2).join('.')))
      const file = v.files.find((f) => f.primary) ?? v.files[0]
      return { v, file, exact, covers }
    })
    .filter((x) => x.file)
  const hit = scored.find((x) => x.exact) ?? scored.find((x) => x.covers) ?? scored[0]
  if (!hit) throw new Error('没找到可用的汉化包')
  return { version: hit.v, file: hit.file, exact: hit.exact }
}

export interface LangPackResult {
  file: string
  name: string
  size: number
  exact: boolean
  packVersion: string
}

export interface InstalledPack {
  name: string
  source: 'vm' | 'cfpa'
  size: number
  version: string
  exact: boolean
}

export interface InstallPacksResult {
  packs: InstalledPack[]
  /** 没装上的源 + 原因（比如 CFPA 没有这个 MC 版本的分支） */
  skipped: { source: string; reason: string }[]
}

function cfpaSuffix(mcVersion: string): string | undefined {
  const m = /^1\.(\d+)/.exec(mcVersion)
  return m ? `1-${m[1]}` : undefined
}

interface CfpaRelease {
  tag_name: string
  assets: { name: string; size: number; browser_download_url: string }[]
}

/** 从 CFPA 的 GitHub release 里挑当前 MC 版本的整合语言包（资产名固定，只有 1.21 分支） */
async function pickCfpa(mcVersion: string): Promise<{ tag: string; name: string; size: number; url: string } | undefined> {
  const suffix = cfpaSuffix(mcVersion)
  if (!suffix) return undefined
  const res = await fetch(`https://api.github.com/repos/${CFPA_REPO}/releases?per_page=5`, {
    headers: { ...UA, Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) throw new Error(`拉取 CFPA 汉化包列表失败（HTTP ${res.status}）`)
  const list = (await res.json()) as CfpaRelease[]
  const want = new RegExp(`^Minecraft-Mod-Language-Modpack-${suffix}\\.zip$`, 'i')
  for (const rel of list) {
    const hit = rel.assets.find((a) => want.test(a.name))
    if (hit) return { tag: rel.tag_name, name: hit.name, size: hit.size, url: hit.browser_download_url }
  }
  return undefined
}

/**
 * 装汉化包：VM（Modrinth vmct）+ CFPA（GitHub 整合语言包）。
 * 两个包收录的模组几乎不重叠（210 vs 400，交集 48），一起装上覆盖 560+ 个模组。
 * 顺序上 VM 放前面（更新更勤），CFPA 放后面。
 */
export async function installLangPacks(
  instanceId: string,
  onProgress?: (p: { phase: string; current: number; total: number }) => void
): Promise<InstallPacksResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  const dir = path.join(gameDir, 'resourcepacks')
  fs.mkdirSync(dir, { recursive: true })
  const packs: InstalledPack[] = []
  const skipped: { source: string; reason: string }[] = []

  // 1) VM 汉化组（Modrinth）
  try {
    onProgress?.({ phase: '查询 VM 汉化包…', current: 0, total: 1 })
    const { version, file, exact } = await pickLangPack(instance.mcVersion)
    const dest = path.join(dir, file.filename)
    onProgress?.({ phase: `下载 ${file.filename}`, current: 0, total: file.size })
    await downloadFile([file.url], dest, (cur, total) => onProgress?.({ phase: `下载 ${file.filename}`, current: cur, total }))
    enableResourcePack(gameDir, path.basename(dest))
    packs.push({ name: path.basename(dest), source: 'vm', size: fs.statSync(dest).size, version: version.version_number, exact })
  } catch (e) {
    skipped.push({ source: 'VM 汉化组', reason: (e as Error).message })
  }

  // 2) CFPA 整合语言包（GitHub release，国内走镜像）
  try {
    const cf = await pickCfpa(instance.mcVersion)
    if (!cf) {
      skipped.push({ source: 'CFPA 语言包', reason: `没有 ${instance.mcVersion} 分支（目前只出 1.21 的整合包）` })
    } else {
      const dest = path.join(dir, cf.name)
      onProgress?.({ phase: `下载 ${cf.name}`, current: 0, total: cf.size })
      await downloadFile(
        CFPA_MIRRORS.map((m) => m(cf.url)),
        dest,
        (cur, total) => onProgress?.({ phase: `下载 ${cf.name}`, current: cur, total })
      )
      const got = fs.statSync(dest).size
      if (cf.size && got !== cf.size) throw new Error(`下载不完整（${got} / ${cf.size} 字节），重试一次`)
      enableResourcePack(gameDir, path.basename(dest))
      packs.push({ name: path.basename(dest), source: 'cfpa', size: got, version: cf.tag, exact: true })
    }
  } catch (e) {
    skipped.push({ source: 'CFPA 语言包', reason: (e as Error).message })
  }

  if (!packs.length) throw new Error(`汉化包都没装上：${skipped.map((s) => `${s.source} ${s.reason}`).join('；')}`)
  onProgress?.({ phase: `已装好 ${packs.length} 个汉化包并启用`, current: packs.length, total: packs.length })
  return { packs, skipped }
}

/** 只装 VM 一个包（老接口，保留兼容） */
export async function installLangPack(
  instanceId: string,
  onProgress?: (p: { phase: string; current: number; total: number }) => void
): Promise<LangPackResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  onProgress?.({ phase: '查询汉化包版本…', current: 0, total: 1 })
  const { version, file, exact } = await pickLangPack(instance.mcVersion)
  const dir = path.join(gameDir, 'resourcepacks')
  fs.mkdirSync(dir, { recursive: true })
  const dest = path.join(dir, file.filename)
  await downloadFile([file.url], dest, (cur, total) =>
    onProgress?.({ phase: `下载汉化包 ${file.filename}`, current: cur, total })
  )
  enableResourcePack(gameDir, path.basename(dest))
  return { file: dest, name: path.basename(dest), size: fs.statSync(dest).size, exact, packVersion: version.version_number }
}

export interface ModCoverage {
  id: string
  name: string
  /** 汉化包里有它的 zh_cn.json */
  covered: boolean
  /** 模组 jar 自己带中文 */
  selfChinese: boolean
}

export interface LangCoverage {
  packs: { name: string; count: number }[]
  coveredCount: number
  mods: ModCoverage[]
}

/**
 * 汉化包到底覆盖了哪些模组 —— 用户最常问的就是「我装了，为什么这个模组还是英文」。
 * 资源包只能替换 jar 里用可翻译键定义的文本，模组硬编码的字符串（直接 drawString 的标题等）谁都翻不了；
 * 另外汉化包是按模组收录的，没收录的模组自然一点中文都没有。
 * 这里把 resourcepacks 下所有 zip 的 assets/<modid>/lang/zh_cn.json 汇总起来算并集。
 */
export function inspectLangPack(instanceId: string): LangCoverage {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)

  // 1) 汇总所有资源包里的 zh_cn 语言文件
  const rpDir = path.join(gameDir, 'resourcepacks')
  const packs: { name: string; count: number }[] = []
  const covered = new Set<string>()
  if (fs.existsSync(rpDir)) {
    for (const z of fs.readdirSync(rpDir)) {
      if (!z.toLowerCase().endsWith('.zip')) continue
      try {
        const buf = fs.readFileSync(path.join(rpDir, z))
        const ids = new Set<string>()
        for (const e of listZipEntries(buf)) {
          const m = /^assets\/([^/]+)\/lang\/zh_cn\.json$/i.exec(e.name)
          if (m) ids.add(m[1].toLowerCase())
        }
        if (!ids.size) continue
        packs.push({ name: z, count: ids.size })
        ids.forEach((i) => covered.add(i))
      } catch {
        // 坏包跳过
      }
    }
  }
  packs.sort((a, b) => b.count - a.count)

  // 2) 读 mods 里每个模组的 id
  const modsDir = path.join(gameDir, 'mods')
  const mods: ModCoverage[] = []
  if (fs.existsSync(modsDir)) {
    for (const f of fs.readdirSync(modsDir)) {
      if (!/\.jar(\.disabled)?$/i.test(f)) continue
      const jar = path.join(modsDir, f)
      let id = ''
      let name = f.replace(/\.jar(\.disabled)?$/i, '')
      try {
        const raw = readFileInsideZip(jar, 'fabric.mod.json')
        if (raw) {
          const j = JSON.parse(raw.toString('utf8')) as { id?: string; name?: string }
          id = String(j.id ?? '').toLowerCase()
          if (j.name) name = j.name
        } else {
          const raw2 = readFileInsideZip(jar, 'META-INF/neoforge.mods.toml') ?? readFileInsideZip(jar, 'META-INF/mods.toml')
          if (raw2) {
            const txt = raw2.toString('utf8')
            const m = /^\s*modId\s*=\s*"([^"]+)"/m.exec(txt)
            const d = /^\s*displayName\s*=\s*"([^"]+)"/m.exec(txt)
            if (m) id = m[1].toLowerCase()
            if (d) name = d[1]
          }
        }
      } catch {
        // 解析不了就当普通文件
      }
      if (!id) continue
      let selfChinese = false
      try {
        selfChinese = !!readFileInsideZip(jar, `assets/${id}/lang/zh_cn.json`)
      } catch {
        selfChinese = false
      }
      mods.push({ id, name, covered: covered.has(id), selfChinese })
    }
  }

  return { packs, coveredCount: covered.size, mods }
}

export interface PackFile {
  /** assets/<modid>/lang/zh_cn.json 里的 modid */
  id: string
  /** 这个模组的中文条目数（语言文件里的键数量） */
  keys: number
  /** 语言文件在包里的路径 */
  entry: string
}

export interface PackContents {
  name: string
  size: number
  /** 是不是汉化包（有 assets/x/lang/zh_cn.json） */
  isLangPack: boolean
  /** pack.mcmeta 里声明的名字 / 描述 */
  title?: string
  description?: string
  /** 按 modid 汇总的中文文件 */
  files: PackFile[]
  /** 包里其它文件（预览用，最多 60 条） */
  others: string[]
  totalEntries: number
}

/** 一个资源包里到底装了什么 —— 「我装的这个汉化包翻译了哪些模组」 */
export function readPackContents(instanceId: string, zipName: string): PackContents {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const zipPath = path.join(gamePathFor(instance), 'resourcepacks', zipName)
  if (!fs.existsSync(zipPath)) throw new Error('这个包不在了，刷新一下列表')
  const size = fs.statSync(zipPath).size
  const buf = fs.readFileSync(zipPath)
  const entries = listZipEntries(buf)

  const files: PackFile[] = []
  const others: string[] = []
  for (const e of entries) {
    const m = /^assets\/([^/]+)\/lang\/zh_cn\.json$/i.exec(e.name)
    if (m) {
      let keys = 0
      try {
        const raw = readFileInsideZip(zipPath, e.name)
        const json = raw ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {}
        keys = Object.keys(json).length
      } catch {
        keys = 0
      }
      files.push({ id: m[1].toLowerCase(), keys, entry: e.name })
    } else if (others.length < 60) {
      others.push(e.name)
    }
  }
  files.sort((a, b) => b.keys - a.keys)

  let title: string | undefined
  let description: string | undefined
  try {
    const raw = readFileInsideZip(zipPath, 'pack.mcmeta')
    if (raw) {
      const j = JSON.parse(raw.toString('utf8')) as { pack?: { description?: unknown } }
      const d = j.pack?.description
      if (typeof d === 'string') description = d
      else if (d && typeof d === 'object' && 'text' in d) description = String((d as { text: unknown }).text)
    }
  } catch {
    /* 没有 mcmeta 就只显示文件名 */
  }
  if (description && description.length < 60) title = description

  return { name: zipName, size, isLangPack: files.length > 0, title, description, files, others, totalEntries: entries.length }
}

/** 删一个资源包文件，并把 options.txt 里对应的条目一起摘掉 */
export function removePack(instanceId: string, zipName: string): { removed: string; lines: boolean } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  const zipPath = path.join(gameDir, 'resourcepacks', zipName)
  const lines = disableResourcePack(gameDir, zipName)
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath, { force: true })
  return { removed: zipName, lines }
}

/**
 * 一键卸载所有汉化包：找出 resourcepacks 里有 assets/x/lang/zh_cn.json 的 zip 全删，
 * 顺手把 options.txt 的引用清掉（不留悬空条目）。
 */
export function removeLangPacks(instanceId: string): { removed: string[]; lines: boolean } {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  const rpDir = path.join(gameDir, 'resourcepacks')
  const removed: string[] = []
  let lines = false
  if (!fs.existsSync(rpDir)) return { removed, lines }
  for (const z of fs.readdirSync(rpDir)) {
    if (!z.toLowerCase().endsWith('.zip')) continue
    const p = path.join(rpDir, z)
    let isLang = false
    try {
      for (const e of listZipEntries(fs.readFileSync(p))) {
        if (/^assets\/[^/]+\/lang\/zh_cn\.json$/i.test(e.name)) {
          isLang = true
          break
        }
      }
    } catch {
      isLang = false
    }
    if (!isLang) continue
    if (disableResourcePack(gameDir, z)) lines = true
    try {
      fs.rmSync(p, { force: true })
      removed.push(z)
    } catch {
      /* 删不掉（被占用）就跳过 */
    }
  }
  return { removed, lines }
}
