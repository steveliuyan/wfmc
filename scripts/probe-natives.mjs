// 验证 @xmcl/core 自带的 checkNatives 在 unzip 2.2.0 下是否还会死锁
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const core = require('@xmcl/core')
const { Version, MinecraftFolder, LaunchPrecheck } = core

const root = process.argv[2] || 'C:\\Users\\steveliuyan\\AppData\\Local\\Temp\\zhudong-e2e'
const version = await Version.parse(root, '1.20.1')
const folder = new MinecraftFolder(root)

const timer = setTimeout(() => {
  console.log('❌ checkNatives 20s 未完成（仍然死锁）')
  process.exit(2)
}, 20_000)

const t0 = Date.now()
try {
  await LaunchPrecheck.checkNatives(folder, version, { gamePath: root, resourcePath: root, javaPath: 'java', version })
  clearTimeout(timer)
  console.log(`✅ checkNatives 完成，用时 ${Date.now() - t0}ms`)
} catch (e) {
  clearTimeout(timer)
  console.log('checkNatives 抛错:', e?.message ?? e)
  process.exit(3)
}
