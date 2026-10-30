import fs from 'node:fs'
import path from 'node:path'
import { downloadFile } from './net'
import { enableResourcePack } from './options'
import { gamePathFor } from './paths'
import { store } from './store'

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
