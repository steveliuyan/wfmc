import fs from 'node:fs'
import path from 'node:path'
import type { MinecraftFolder, ResolvedVersion } from '@xmcl/core'
import { listZipEntries, readZipEntry } from './zip'

/**
 * 自己解压 natives（lwjgl 等本地库）。
 *
 * 不用 @xmcl/core 的 `LaunchPrecheck.checkNatives`：它依赖 yauzl/@xmcl/unzip
 * 一边遍历 zip 一边并发开条目流，在本机 Node 24 下会卡住不返回。
 * 这里用自带的 zip 读取器顺序解压，稳定且快（1.20.1 的 21 个 native 包 67ms）。
 */
export async function extractNatives(folder: MinecraftFolder, version: ResolvedVersion): Promise<number> {
  const nativesDir = folder.getNativesRoot(version.id)
  await fs.promises.mkdir(nativesDir, { recursive: true })

  let count = 0
  for (const lib of version.libraries.filter((l) => l.isNative)) {
    const jarPath = folder.getLibraryByPath(lib.download.path)
    if (!fs.existsSync(jarPath)) continue

    const excluded = lib.extractExclude ?? []
    const buf = fs.readFileSync(jarPath)
    for (const entry of listZipEntries(buf)) {
      const name = entry.name
      if (entry.isDirectory) continue
      if (name.includes('META-INF/')) continue
      if (name.endsWith('.sha1') || name.endsWith('.git')) continue
      if (excluded.some((prefix) => name.startsWith(prefix))) continue

      const dest = path.join(nativesDir, name)
      await fs.promises.mkdir(path.dirname(dest), { recursive: true })
      await fs.promises.writeFile(dest, readZipEntry(buf, entry))
      count++
    }
  }
  return count
}

/** 已解压过就跳过（标记文件） */
export async function ensureNatives(folder: MinecraftFolder, version: ResolvedVersion): Promise<number> {
  const nativesDir = folder.getNativesRoot(version.id)
  const marker = path.join(nativesDir, '.extracted')
  if (fs.existsSync(marker) && fs.readdirSync(nativesDir).length > 1) return 0
  const count = await extractNatives(folder, version)
  await fs.promises.writeFile(marker, String(Date.now()), 'utf-8')
  return count
}
