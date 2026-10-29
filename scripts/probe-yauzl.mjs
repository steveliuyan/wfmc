// 直接测原生 yauzl（绕过 @xmcl/unzip 包装），确认卡住到底是谁的问题
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const yauzl = require('yauzl')

const jar =
  process.argv[2] ||
  'C:\\Users\\steveliuyan\\AppData\\Local\\Temp\\zhudong-e2e\\libraries\\org\\lwjgl\\lwjgl\\3.3.1\\lwjgl-3.3.1-natives-windows.jar'
console.log('jar =', path.basename(jar))

const timer = setTimeout(() => {
  console.log('❌ 原生 yauzl 也卡住')
  process.exit(2)
}, 15_000)

yauzl.open(jar, { lazyEntries: true }, (err, zip) => {
  if (err) throw err
  let n = 0
  let bytes = 0
  zip.on('entry', (entry) => {
    if (/\/$/.test(entry.fileName)) {
      zip.readEntry()
      return
    }
    zip.openReadStream(entry, (e, stream) => {
      if (e) throw e
      stream.on('data', (c) => (bytes += c.length))
      stream.on('end', () => {
        n++
        zip.readEntry()
      })
    })
  })
  zip.on('end', () => {
    clearTimeout(timer)
    console.log(`✅ 原生 yauzl 正常：${n} 个文件，${bytes} 字节`)
    process.exit(0)
  })
  zip.readEntry()
})
