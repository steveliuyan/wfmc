// 端到端验证：真实下载 1.20.1 全量文件并用本机 Java 17 启动游戏
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const core = require('@xmcl/core')
const installer = require('@xmcl/installer')
const user = require('@xmcl/user')

const root = process.argv[2] || path.join(os.tmpdir(), 'zhudong-e2e')
const javaPath = process.argv[3] || 'C:\\Program Files\\Zulu\\zulu-17\\bin\\java.exe'
fs.mkdirSync(root, { recursive: true })

const list = await installer.getVersionList()
const meta = list.versions.find((v) => v.id === '1.20.1')
console.log(`[e2e] 开始全量安装 1.20.1 到 ${root}`)
const t0 = Date.now()
const mirror = process.argv.includes('--mirror')
const { createDefaultRetryHandler } = require('@xmcl/file-transfer')
const installOptions = {
  agent: { retryHandler: createDefaultRetryHandler(6) },
  assetsDownloadConcurrency: 6,
  librariesDownloadConcurrency: 6,
  ...(mirror
    ? {
        mavenHost: ['https://bmclapi2.bangbang93.com/maven', 'https://libraries.minecraft.net'],
        assetsHost: ['https://bmclapi2.bangbang93.com/assets', 'https://resources.download.minecraft.net']
      }
    : {})
}
let installed = false
for (let attempt = 1; attempt <= 4 && !installed; attempt++) {
  try {
    await installer.install(meta, root, installOptions)
    installed = true
  } catch (e) {
    console.log(`[e2e] 第 ${attempt} 轮失败：${String(e).slice(0, 200)}`)
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
}
if (!installed) throw new Error('四轮重试后仍未装完')
console.log(`[e2e] 安装完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s，镜像=${mirror}`)

const version = await core.Version.parse(root, '1.20.1')
console.log(`[e2e] mainClass=${version.mainClass} libraries=${version.libraries.length}`)

const profile = user.offline('TestPlayer')
console.log('[e2e] 启动游戏…')
const proc = await core.launch({
  gamePath: root,
  resourcePath: root,
  javaPath,
  version,
  gameProfile: { name: 'TestPlayer', id: profile.selectedProfile.id },
  accessToken: profile.accessToken,
  userType: 'mojang',
  launcherName: 'ZhuDongLauncher',
  launcherBrand: '诛冬启动器',
  minMemory: 1024,
  maxMemory: 2048
})

let ready = false
let output = ''
proc.stdout?.on('data', (c) => {
  output += c.toString()
})
proc.stderr?.on('data', (c) => {
  output += c.toString()
})

const watcher = core.createMinecraftProcessWatcher(proc)
watcher.on('minecraft-window-ready', () => {
  ready = true
  console.log('[e2e] ✅ 游戏窗口已出现，启动成功')
})
watcher.on('error', (e) => console.log('[e2e] ❌ spawn 失败:', e?.message ?? e))
watcher.on('minecraft-exit', (e) => {
  console.log(`[e2e] 游戏退出 code=${e.code}`)
  if (!ready) {
    console.log('[e2e] 输出片段：\n' + output.split('\n').slice(-30).join('\n'))
    process.exit(2)
  }
  process.exit(0)
})

// 90 秒内没崩就算成功
setTimeout(() => {
  if (ready) {
    console.log('[e2e] 90s 仍存活，结束进程')
    proc.kill()
    process.exit(0)
  } else {
    console.log('[e2e] ⏱ 超时未检测到窗口，输出片段：\n' + output.split('\n').slice(-40).join('\n'))
    proc.kill()
    process.exit(3)
  }
}, 90_000)
