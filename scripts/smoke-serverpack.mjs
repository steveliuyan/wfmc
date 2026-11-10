/**
 * 真机冒烟：在真实实例上跑一遍「导出服务端整合包（.zip）」。
 *
 * 用法：node scripts/smoke-serverpack.mjs <实例 id> [...]
 */
import { runMainWithElectronStub } from './lib/smoke-harness.mjs'

const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('用法：node scripts/smoke-serverpack.mjs <实例 id> [...]')
  process.exit(2)
}

const ENTRY = `
import fs from 'node:fs'
import { store } from './src/main/store'
import { exportInstanceAsServerPack, previewServerPack } from './src/main/serverpack'

store.load()
console.log('dataDir =', store.dataDir)

for (const id of ${JSON.stringify(ids)}) {
  const pv = await previewServerPack(id)
  console.log('\\n== ' + id + ' | ' + pv.loader + ' ' + (pv.loaderVersion || '?') + ' / MC ' + pv.mcVersion)
  console.log('  mod 总数 ' + pv.totalMods + ' | 保留 ' + pv.keep + ' | 剔除 ' + pv.clientOnly.length)
  for (const c of pv.clientOnly) console.log('    - ' + c.file + ' :: ' + c.why)
  const t0 = Date.now()
  const res = await exportInstanceAsServerPack(id, (p) => console.log('  ·', p.phase))
  const size = fs.statSync(res.path).size
  console.log('  完成 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's | 保留 ' + res.keep + ' 个 mod | ' + (size / 1024 / 1024).toFixed(2) + ' MB')
  console.log('  加载器文件: ' + res.loaderFiles.join(', '))
  console.log('  → ' + res.path)
}
`

await runMainWithElectronStub(ENTRY)
