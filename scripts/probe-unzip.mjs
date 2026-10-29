// 用 yauzl 的 lazyEntries 正规姿势验证顺序解压 natives（readEntry 逐条推进）
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const core = require('@xmcl/core')
const unzip = require('@xmcl/unzip')
const { Version, MinecraftFolder } = core

const root = process.argv[2] || 'C:\\Users\\steveliuyan\\AppData\\Local\\Temp\\zhudong-e2e'
const version = await Version.parse(root, '1.20.1')
const folder = new MinecraftFolder(root)
const dest = path.join(path.dirname(folder.getNativesRoot(version.id)), 'natives-test')
await fs.promises.mkdir(dest, { recursive: true })

const natives = version.libraries.filter((l) => l.isNative)
console.log('native 库:', natives.length)

async function extract(jarPath, destDir, excluded) {
  let count = 0
  const zip = await unzip.open(jarPath, { lazyEntries: true, autoClose: false })
  await new Promise((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry) => {
      ;(async () => {
        try {
          const name = entry.fileName
          const skip =
            name.endsWith('/') ||
            name.includes('META-INF/') ||
            name.endsWith('.sha1') ||
            name.endsWith('.git') ||
            excluded.some((p) => name.startsWith(p))
          if (!skip) {
            const target = path.join(destDir, name)
            await fs.promises.mkdir(path.dirname(target), { recursive: true })
            await fs.promises.writeFile(target, await unzip.readEntry(zip, entry))
            count++
          }
          zip.readEntry()
        } catch (e) {
          reject(e)
        }
      })()
    })
    zip.readEntry()
  })
  zip.close()
  return count
}

const timer = setTimeout(() => {
  console.log('❌ 30s 未完成')
  process.exit(2)
}, 30_000)

const t0 = Date.now()
for (const lib of natives) {
  const jarPath = folder.getLibraryByPath(lib.download.path)
  if (!fs.existsSync(jarPath)) {
    console.log('  缺包:', path.basename(jarPath))
    continue
  }
  const n = await extract(jarPath, dest, lib.extractExclude ?? [])
  console.log('  ok', path.basename(jarPath), '→', n, '个文件')
}
clearTimeout(timer)
console.log(`✅ 解压完成，用时 ${Date.now() - t0}ms，共 ${fs.readdirSync(dest).length} 项`)
