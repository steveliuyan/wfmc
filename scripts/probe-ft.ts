// 在 Electron 主进程里单测 @xmcl/file-transfer 下载，打印它实际用的 undici
import { app } from 'electron'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(path.join(process.cwd(), 'node_modules', '@xmcl', 'file-transfer', 'probe.js'))

app.whenReady().then(async () => {
  try {
    const ftPath = require.resolve('@xmcl/file-transfer')
    console.log('[probe] file-transfer =', ftPath)
    console.log('[probe] undici(resolved from ft) =', require.resolve('undici'))
    console.log('[probe] undici version =', require('undici/package.json').version)
    console.log('[probe] node =', process.versions.node, 'electron =', process.versions.electron)

    const ft = require('@xmcl/file-transfer')
    const dest = path.join(os.tmpdir(), 'ft-probe', 'test.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    await ft.download({
      url: 'https://bmclapi2.bangbang93.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar',
      destination: dest
    })
    console.log('[probe] ✅ 下载成功', fs.statSync(dest).size, 'bytes')

    // 再测带 retryHandler 的 agent
    const dest2 = dest + '.2'
    await ft.download({
      url: 'https://bmclapi2.bangbang93.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar',
      destination: dest2,
      agent: { retryHandler: ft.createDefaultRetryHandler(6) }
    })
    console.log('[probe] ✅ 带 retryHandler 也成功', fs.statSync(dest2).size)
    app.exit(0)
  } catch (e: any) {
    console.log('[probe] ❌ 失败:', e?.message ?? e)
    console.log('[probe] code =', e?.code)
    app.exit(1)
  }
})
