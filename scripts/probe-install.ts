// 在 Electron 主进程里跑 installer.install（复现 maxRedirections 报错）
import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('@xmcl/installer')
const ft = require('@xmcl/file-transfer')

const root = path.join(os.tmpdir(), 'zhudong-inst-probe')

app.whenReady().then(async () => {
  fs.mkdirSync(root, { recursive: true })
  const list = await installer.getVersionList()
  const meta = list.versions.find((v: any) => v.id === '1.0')
  console.log('[p] 目标版本', meta.id, '| undici(安装器) =', require.resolve('undici', { paths: [path.dirname(require.resolve('@xmcl/installer'))] }))

  const attempts: { name: string; opts: any }[] = [
    { name: '仅镜像', opts: { mavenHost: ['https://bmclapi2.bangbang93.com/maven'], assetsHost: ['https://bmclapi2.bangbang93.com/assets'] } },
    {
      name: '镜像+并发',
      opts: {
        mavenHost: ['https://bmclapi2.bangbang93.com/maven'],
        assetsHost: ['https://bmclapi2.bangbang93.com/assets'],
        assetsDownloadConcurrency: 6,
        librariesDownloadConcurrency: 6
      }
    },
    {
      name: '镜像+并发+retryHandler',
      opts: {
        mavenHost: ['https://bmclapi2.bangbang93.com/maven'],
        assetsHost: ['https://bmclapi2.bangbang93.com/assets'],
        assetsDownloadConcurrency: 6,
        librariesDownloadConcurrency: 6,
        agent: { retryHandler: ft.createDefaultRetryHandler(6) }
      }
    }
  ]

  for (const a of attempts) {
    const dir = path.join(root, a.name.replace(/[^\w]/g, '_'))
    try {
      await installer.install(meta, dir, a.opts)
      console.log(`[p] ✅ ${a.name} 成功`)
    } catch (e: any) {
      const inner = e?.errors?.[0]?.errors?.[0] ?? e?.errors?.[0] ?? e
      console.log(`[p] ❌ ${a.name}: ${inner?.message ?? inner} | code=${inner?.code ?? ''} | url=${(e?.errors?.[0]?.urls ?? [])[0] ?? ''}`)
    }
  }
  app.exit(0)
})
