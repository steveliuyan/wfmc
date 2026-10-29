// 集成测试：在 Electron 主进程环境里跑产品代码（store/instances/安装/启动）。
// 结果写文件（不用 stdout，避免管道断开导致 EPIPE）。
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { addOfflineAccount } from '../src/main/accounts'
import { createInstance, instanceDetail } from '../src/main/instances'
import { installInstanceGame } from '../src/main/minecraft'
import { launchInstance, killGame } from '../src/main/launch'
import { scanJava } from '../src/main/java'

const reportFile = path.join(process.cwd(), '.tmp-probe', 'itest-report.log')
fs.mkdirSync(path.dirname(reportFile), { recursive: true })
fs.writeFileSync(reportFile, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(reportFile, `[itest] ${m}\n`, 'utf-8')

const dataDir = path.join(os.tmpdir(), 'zhudong-itest-data')

async function main() {
  fs.mkdirSync(dataDir, { recursive: true })
  store.load()
  store.setSettings({ dataDir, downloadSource: 'mirror' })
  log(`数据目录 = ${store.dataDir}`)
  log(`下载源 = ${store.settings.downloadSource}`)

  const javas = await scanJava()
  log(`扫描到 Java: ${javas.map((j) => j.majorVersion).join(', ') || '无'}`)

  const account = addOfflineAccount('TestPlayer')
  log(`离线账号: ${account.name} / ${account.uuid}`)

  const existing = store.listInstances().find((i) => i.name === 'itest-1.20.1')
  const instance = existing ?? createInstance({ name: 'itest-1.20.1', mcVersion: '1.20.1' })
  log(`实例: ${instance.id}`)

  log('开始安装 1.20.1 …')
  const t0 = Date.now()
  const skipInstall = process.argv.includes('--skip-install')
  if (skipInstall) {
    log('（跳过安装，直接启动）')
  } else {
    let last = ''
    try {
      const installed = await installInstanceGame(instance, (p) => {
        if (!p.phase || p.phase === last) return
        last = p.phase
        log(`  ${p.phase}${p.current !== undefined ? ` (${p.current}/${p.total})` : ''}`)
      })
      log(`安装完成 ${((Date.now() - t0) / 1000).toFixed(1)}s，versionId=${installed.versionId}`)
    } catch (e: any) {
      log('安装失败: ' + (e?.message ?? e))
      app.exit(1)
      return
    }
  }

  const detail = instanceDetail(instance.id)
  log(`版本目录: ${detail.versions.join(', ')}`)

  log('启动游戏…')
  let ready = false
  await launchInstance(
    { instanceId: instance.id, accountId: account.id },
    (_id, line) => {
      if (/Setting user|LWJGL|OpenAL initialized|Created:|Stopping!|Exception|窗口/.test(line)) {
        log('game> ' + line.slice(0, 140))
      }
    },
    (s) => {
      log(`state=${s.state} ${s.message ?? ''}`)
      if (s.state === 'running') ready = true
      if (s.state === 'error') log('启动报错')
    }
  )

  for (let i = 0; i < 90 && !ready; i++) await new Promise((r) => setTimeout(r, 1000))
  log(ready ? '✅ 启动成功：游戏已进入运行状态' : '❌ 未进入运行状态')
  // 保持 25 秒，方便外部截图确认真有窗口
  await new Promise((r) => setTimeout(r, 25_000))
  killGame(instance.id)
  log('已结束游戏进程')
  app.exit(ready ? 0 : 2)
}

app.whenReady().then(() =>
  main().catch((e) => {
    log('异常: ' + (e?.message ?? e))
    app.exit(1)
  })
)
