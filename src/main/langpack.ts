import fs from 'node:fs'
import path from 'node:path'
import { downloadFile } from './net'
import { enableResourcePack } from './options'
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

/** 下载汉化包到实例的 resourcepacks/，并写进 options.txt 启用 */
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
  onProgress?.({ phase: `下载汉化包 ${file.filename}`, current: 0, total: file.size })
  await downloadFile([file.url], dest, (cur, total) =>
    onProgress?.({ phase: `下载汉化包 ${file.filename}`, current: cur, total })
  )

  enableResourcePack(gameDir, path.basename(dest))
  onProgress?.({ phase: '已装好并启用汉化包', current: 1, total: 1 })

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
  pack: string | null
  coveredCount: number
  mods: ModCoverage[]
}

/**
 * 汉化包到底覆盖了哪些模组 —— 用户最常问的就是「我装了，为什么这个模组还是英文」。
 * 资源包只能替换 jar 里用可翻译键定义的文本，模组硬编码的字符串（直接 drawString 的标题等）谁都翻不了；
 * 另外 VM 汉化包是按模组收录的，没收录的模组自然一点中文都没有。
 */
export function inspectLangPack(instanceId: string): LangCoverage {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)

  // 1) 找覆盖模组最多的那个资源包（一般就是汉化包）
  const rpDir = path.join(gameDir, 'resourcepacks')
  let pack: string | null = null
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
        if (ids.size > covered.size) {
          pack = z
          covered.clear()
          ids.forEach((i) => covered.add(i))
        }
      } catch {
        // 坏包跳过
      }
    }
  }

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

  return { pack, coveredCount: covered.size, mods }
}
