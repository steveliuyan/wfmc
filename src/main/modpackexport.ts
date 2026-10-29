import fs from 'node:fs'
import path from 'node:path'
import { ModrinthV2Client } from '@xmcl/modrinth'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { listZipEntries, readZipEntry, writeZip, collectDirFiles } from './zip'
import { sha1Of } from './moddoctor'

const client = new ModrinthV2Client()

interface MrpackFile {
  path: string
  hashes: { sha1: string }
  env?: { client: string; server: string }
  downloads: string[]
  fileSize: number
}

interface MrpackIndex {
  formatVersion: 1
  game: 'minecraft'
  versionId: string
  name: string
  summary?: string
  files: MrpackFile[]
  dependencies: Record<string, string>
}

/**
 * 把实例导出成标准 Modrinth 整合包（.mrpack）：
 * - mods 里能在 Modrinth 查到的 → 写进 index.json 的 files（只存下载地址，包体很小）
 * - 查不到的（本地/自编译）→ 塞进 overrides/mods
 * - config、resourcepacks、shaderpacks、options.txt → overrides/
 */
export async function exportInstanceAsMrpack(instanceId: string, onProgress?: ProgressFn): Promise<string> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  const key = 'mrpack-export'

  const files: MrpackFile[] = []
  const overrides: { name: string; full: string }[] = []

  // 1) mods：能反查到 Modrinth 的写下载地址，查不到的进 overrides
  const modsDir = path.join(gameDir, 'mods')
  const jars = fs.existsSync(modsDir)
    ? fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar')).map((n) => path.join(modsDir, n))
    : []

  if (jars.length > 0) {
    onProgress?.({ key, phase: `识别 ${jars.length} 个 mod 的来源`, current: 0, total: jars.length })
    const hashes = jars.map((j) => sha1Of(j))
    let found: Record<string, { id: string; files: { url: string; filename: string; primary: boolean }[] }> = {}
    try {
      found = (await client.getProjectVersionsByHash(hashes, 'sha1')) as never
    } catch {
      /* 网络失败就全部走 overrides */
    }

    jars.forEach((jar, i) => {
      const hash = hashes[i]
      const hit = found[hash]
      const stat = fs.statSync(jar)
      const url = hit?.files?.find((f) => f.primary)?.url ?? hit?.files?.[0]?.url
      if (hit && url) {
        files.push({
          path: `mods/${path.basename(jar)}`,
          hashes: { sha1: hash },
          env: { client: 'required', server: 'required' },
          downloads: [url],
          fileSize: stat.size
        })
      } else {
        overrides.push({ name: `overrides/mods/${path.basename(jar)}`, full: jar })
      }
    })
    onProgress?.({ key, phase: '来源识别完成', current: jars.length, total: jars.length })
  }

  // 2) 其余目录整体搬进 overrides
  for (const folder of ['config', 'resourcepacks', 'shaderpacks', 'defaultconfigs', 'scripts']) {
    const dir = path.join(gameDir, folder)
    if (!fs.existsSync(dir)) continue
    for (const f of collectDirFiles(dir)) {
      overrides.push({ name: `overrides/${folder}/${f.name}`, full: f.full })
    }
  }
  const optionsFile = path.join(gameDir, 'options.txt')
  if (fs.existsSync(optionsFile)) overrides.push({ name: 'overrides/options.txt', full: optionsFile })

  // 3) index.json
  const dependencies: Record<string, string> = { minecraft: instance.mcVersion }
  if (instance.loader === 'fabric' && instance.loaderVersion) dependencies['fabric-loader'] = instance.loaderVersion
  if (instance.loader === 'quilt' && instance.loaderVersion) dependencies['quilt-loader'] = instance.loaderVersion
  if (instance.loader === 'forge' && instance.loaderVersion) dependencies.forge = instance.loaderVersion
  if (instance.loader === 'neoforge' && instance.loaderVersion) dependencies.neoforge = instance.loaderVersion

  const index: MrpackIndex = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: String(Date.now()),
    name: instance.name,
    summary: `由 WFMC 从实例「${instance.name}」导出（${instance.mcVersion} ${instance.loader}）`,
    files,
    dependencies
  }

  // 4) 打包：先写 index.json，再补 overrides 文件
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const out = path.join(store.exportsDir, `${instance.name}-${instance.mcVersion}-${stamp}.mrpack`)
  fs.mkdirSync(store.exportsDir, { recursive: true })

  // writeZip 只吃磁盘文件，所以把 index.json 先落到临时目录
  const tempDir = path.join(store.dataDir, 'temp', `mrpack-${stamp}`)
  fs.mkdirSync(tempDir, { recursive: true })
  const indexPath = path.join(tempDir, 'modrinth.index.json')
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf-8')

  onProgress?.({ key, phase: `打包 ${overrides.length + 1} 个文件`, current: 0, total: overrides.length + 1 })
  const written = writeZip(out, [
    { name: 'modrinth.index.json', full: indexPath },
    ...overrides
  ])
  fs.rmSync(tempDir, { recursive: true, force: true })
  onProgress?.({ key, phase: `导出完成：${written} 个文件`, current: 1, total: 1 })
  return out
}

/** 整合包更新检查：只看本地 .mrpack 里的 versionId 与实例记录，给出是否被改过 */
export function inspectMrpack(mrpackPath: string): { name?: string; versionId?: string; files: number; deps?: Record<string, string> } {
  const buf = fs.readFileSync(mrpackPath)
  const entries = listZipEntries(buf)
  const entry = entries.find((e) => e.name === 'modrinth.index.json')
  if (!entry) throw new Error('不是有效的 mrpack（缺 modrinth.index.json）')
  const index = JSON.parse(readZipEntry(buf, entry).toString('utf-8')) as MrpackIndex
  return { name: index.name, versionId: index.versionId, files: index.files?.length ?? 0, deps: index.dependencies }
}
