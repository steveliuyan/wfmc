// 新功能实测：版本隔离 / STUN / 局域网 / 内网穿透 / 一键开服 / Mod 更新
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { gamePathFor, ensureGamePath } from '../src/main/paths'
import { publicEndpoint, lanStart, lanList, firstLanIp, tunnelStart, tunnelState, tunnelStop } from '../src/main/netshare'
import { createHostedServer, acceptEula, startHosted, stopHosted, listHostedServers } from '../src/main/serverhost'
import { checkModUpdates } from '../src/main/modupdates'

const out = path.join(process.cwd(), '.tmp-shot', 'featuretest.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[ft] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-featuretest'), downloadSource: 'mirror' })
    log(`数据目录 = ${store.dataDir}`)

    // 1. 版本隔离路径
    const inst = { id: 'x', name: 'x', mcVersion: '1.20.1', loader: 'vanilla', createdAt: 0 } as any
    log(`隔离关闭 → ${gamePathFor({ ...inst, isolate: false })}`)
    log(`隔离开启 → ${gamePathFor({ ...inst, isolate: true, versionId: '1.20.1' })}`)

    // 2. STUN
    const ep = await publicEndpoint()
    log(`STUN 公网端点 = ${ep ? `${ep.ip}:${ep.port}` : '拿不到（UDP 可能被限制）'}`)
    log(`本机内网 IP = ${firstLanIp()}`)

    // 3. 局域网监听
    lanStart()
    await new Promise((r) => setTimeout(r, 1200))
    log(`局域网监听启动，当前发现 ${lanList().length} 个世界（没人开局域网就是 0）`)

    // 4. Mod 更新检查（空实例，验证不炸）
    const updates = await checkModUpdates('x').catch((e: any) => [{ note: e.message }])
    log(`Mod 更新检查（无实例）= ${JSON.stringify(updates)}`)

    // 5. 一键开服：Paper 1.20.1
    log('创建 Paper 1.20.1 服务端（会下载 jar，稍慢）…')
    const t0 = Date.now()
    const srv = await createHostedServer(
      { name: 'ft-paper', kind: 'paper', mcVersion: '1.20.1', memoryMb: 2048, port: 25599 },
      (p) => {
        if (p.phase && p.current !== undefined) log(`  ${p.phase} ${p.current}/${p.total}`)
      }
    )
    log(`服务端已创建：${srv.id}（${((Date.now() - t0) / 1000).toFixed(0)}s）`)
    acceptEula(srv.id)
    log('已同意 EULA，准备启动…')

    const lines: string[] = []
    let done = false
    await startHosted(
      srv.id,
      (_id, line) => {
        lines.push(line)
        if (/Done \([\d.]+s\)!|For help/.test(line)) done = true
      },
      () => log('服务端进程退出')
    )
    for (let i = 0; i < 90 && !done; i++) await new Promise((r) => setTimeout(r, 1000))
    log(done ? '✅ 服务端启动完成（日志里出现 Done）' : '⚠ 60s 内没看到 Done，尾部日志：')
    if (!done) log(lines.slice(-15).join('\n'))
    await stopHosted(srv.id)
    log('已停服')
    log(`服务端列表 = ${listHostedServers().length}`)

    // 6. 内网穿透（bore.pub）
    log('启动公网穿透（bore.pub）…')
    const st = await tunnelStart(25599)
    log(`穿透状态 running=${st.running} public=${st.publicAddress ?? '未拿到'} err=${st.error ?? '-'}`)
    if (st.logs.length) log('隧道日志尾部: ' + st.logs.slice(-3).join(' | '))
    tunnelStop()
    log('隧道已关闭')

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
