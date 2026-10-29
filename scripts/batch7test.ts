// 第七批实测：截图管理 / MOTD 缓存 / 令牌加密 / 设置项持久化
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { deleteScreenshot, listScreenshots, screenshotsDir } from '../src/main/shots'
import { addServer, listServers, queryServer } from '../src/main/servers'
import { createInstance } from '../src/main/instances'

const out = path.join(process.cwd(), '.tmp-shot', 'batch7.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b7] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch7'), downloadSource: 'mirror' })

    // 1) 截图：列 / 删 / 越权保护
    const inst = createInstance({ name: 'b7-shots', mcVersion: '1.20.1' })
    const dir = screenshotsDir(inst.id)
    const fake = path.join(dir, '2026-01-01_12.00.00.png')
    fs.writeFileSync(fake, Buffer.alloc(1024, 7))
    const list = listScreenshots(inst.id)
    log(`截图列表：${list.map((s) => `${s.name}(${s.size}B)`).join(',')}`)
    try {
      deleteScreenshot(inst.id, 'C:/Windows/System32/drivers/etc/hosts')
      log('❌ 越界删除没被拦住')
    } catch (e: any) {
      log(`✅ 越界删除被拒：${e.message}`)
    }
    deleteScreenshot(inst.id, fake)
    log(`删除后剩 ${listScreenshots(inst.id).length} 张`)

    // 2) MOTD 缓存：收藏一个真服务器并查询
    const srv = addServer({ name: 'hypixel', address: 'mc.hypixel.net' })
    const status = await queryServer('mc.hypixel.net')
    log(`查询：online=${status.online} ${status.latency}ms ${status.players?.online ?? 0}/${status.players?.max ?? 0}`)
    const cached = listServers().find((s) => s.id === srv.id)
    log(`缓存写入：lastStatus.online=${cached?.lastStatus?.online} 图标=${cached?.icon ? '有' : '无'} 时间=${cached?.lastChecked ? '有' : '无'}`)

    // 3) 令牌加密
    store.setAccounts([
      { id: 'a1', type: 'yggdrasil', name: 'Steve', uuid: '0000', accessToken: 'SECRET-TOKEN-123', server: 'https://littleskin.cn/api/yggdrasil' }
    ])
    const raw = fs.readFileSync(path.join(store.dataDir, 'accounts.json'), 'utf-8')
    log(`磁盘上出现明文令牌？${raw.includes('SECRET-TOKEN-123') ? '❌ 是（加密没生效）' : '✅ 否'}`)
    log(`磁盘片段：${raw.slice(0, 120).replace(/\s+/g, ' ')}`)
    log(`内存里能读回明文？${store.accounts[0]?.accessToken === 'SECRET-TOKEN-123' ? '✅ 可以' : '❌ 不行'}`)

    // 4) 设置项持久化（主题自定义 / 语言）
    store.setSettings({ language: 'en', themeCustom: { accent: '#06b6d4', radius: 18 } })
    const reread = JSON.parse(fs.readFileSync(path.join(store.dataDir, 'settings.json'), 'utf-8'))
    log(`设置落盘：language=${reread.language} accent=${reread.themeCustom?.accent} radius=${reread.themeCustom?.radius}`)

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
