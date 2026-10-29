// 第二批功能实测：房间码 / authlib-injector 下载 / 性能预设 / LittleSkin 连通性
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { encodeRoomCode, decodeRoomCode } from '../src/main/rooms'
import { ensureInjector, lookupSkin } from '../src/main/authlib'
import { applyPerfPreset, PERF_PRESETS } from '../src/main/shots'
import { createInstance } from '../src/main/instances'

const out = path.join(process.cwd(), '.tmp-shot', 'batch2.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b2] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch2'), downloadSource: 'mirror' })

    // 1. 房间码往返
    for (const [h, p] of [
      ['bore.pub', 13705],
      ['223.160.224.211', 25565],
      ['mc.example.cn', 25599]
    ] as [string, number][]) {
      const code = encodeRoomCode(h, p)
      const back = decodeRoomCode(code)
      log(`房间码 ${h}:${p} → ${code} → ${back.host}:${back.port} ${back.host === h && back.port === p ? '✅' : '❌'}`)
    }
    try {
      decodeRoomCode('ZZZZ')
      log('❌ 乱码竟然解出来了')
    } catch {
      log('✅ 乱码被正确拒绝')
    }

    // 2. authlib-injector 下载
    const t0 = Date.now()
    const injector = await ensureInjector((p) => p.phase && log(`  ${p.phase}`))
    log(`authlib-injector 就绪：${injector.version ?? '?'} (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${injector.path}`)
    log(`文件大小 = ${(fs.statSync(injector.path).size / 1024).toFixed(0)} KB`)

    // 3. 性能预设
    const inst = createInstance({ name: 'b2-preset', mcVersion: '1.20.1' })
    for (const preset of PERF_PRESETS) {
      const updated = applyPerfPreset(inst.id, preset.id)
      log(`预设 ${preset.id} → 内存 ${updated.maxMemory}MB, JVM 参数 ${updated.extraJvmArgs?.length} 条`)
    }
    const optionsFile = path.join(store.instanceGameDir(inst.id), 'options.txt')
    log(`options.txt 生成：${fs.existsSync(optionsFile)}（${fs.readFileSync(optionsFile, 'utf-8').split('\n').length} 行）`)

    // 4. LittleSkin 连通性（未登录也能拉公开皮肤信息）
    const res = await fetch('https://littleskin.cn/api/yggdrasil', { method: 'HEAD' }).catch(() => undefined)
    log(`LittleSkin API 可达：${res ? res.status : '失败'}`)
    try {
      const probe = await fetch('https://littleskin.cn/api/yggdrasil/sessionserver/session/minecraft/profile/853c80ef3c3749fdaa49938b674adae6')
      log(`公开档案接口：${probe.status}（204/404 都算正常，说明路由通）`)
    } catch (e: any) {
      log('公开档案接口失败：' + e.message)
    }
    log('空账号查皮肤（应返回 undefined）：' + (await lookupSkin('not-exist')))

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
