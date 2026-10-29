// 服务器 ping / SRV 实测（在 Electron 主进程里跑，走的就是产品代码）
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { queryServer, resolveSrv, addServer, listServers } from '../src/main/servers'

const out = path.join(process.cwd(), '.tmp-shot', 'servertest.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, m + '\n', 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-servertest') })
    log('下载源/数据目录 ok')

    for (const host of ['2b2t.org', 'mc.hypixel.net', 'play.mcprison.com']) {
      const srv = await resolveSrv(host)
      log(`SRV ${host} → ${srv ? `${srv.host}:${srv.port}` : '无'}`)
    }

    for (const addr of ['2b2t.org', 'mc.hypixel.net', '127.0.0.1:1']) {
      const t0 = Date.now()
      const st = await queryServer(addr)
      log(
        `${addr} → online=${st.online} latency=${st.latency ?? '-'}ms version=${st.version ?? '-'} players=${
          st.players ? `${st.players.online}/${st.players.max}` : '-'
        } srv=${st.srv ? `${st.srv.host}:${st.srv.port}` : '-'} motd=${(st.motd ?? '').slice(0, 40).replace(/\n/g, ' ')} err=${st.error ?? '-'} (${Date.now() - t0}ms)`
      )
    }

    addServer({ address: 'mc.hypixel.net', name: 'Hypixel' })
    log(`收藏数量 = ${listServers().length}`)
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
