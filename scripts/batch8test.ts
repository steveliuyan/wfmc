// 第八批实测：服务端环境清单 / 进服前对比 / 自动补齐
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { createInstance } from '../src/main/instances'
import { gamePathFor, ensureGamePath } from '../src/main/paths'
import { buildManifest, startManifestServer, stopManifestServer, discoverManifest, compareEnvironment, syncEnvironment } from '../src/main/serversync'

const out = path.join(process.cwd(), '.tmp-shot', 'batch8.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b8] ${m}\n`, 'utf-8')

function fakeJar(file: string, id: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(`fake mod ${id} ${Math.random()}`), 'utf-8')
}

app.whenReady().then(async () => {
  try {
    store.load()
    const dataDir = path.join(os.tmpdir(), 'wfmc-batch8')
    store.setSettings({ dataDir })
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir, { recursive: true })

    // 1) 造一个"服务端"：fabric 1.20.1 + 2 个 mod
    const sid = 'srv-fabric-1-20-1-test'
    const srvDir = path.join(dataDir, 'servers', sid)
    fs.mkdirSync(path.join(srvDir, 'mods'), { recursive: true })
    fs.writeFileSync(
      path.join(srvDir, 'hosted-server.json'),
      JSON.stringify({
        id: sid,
        name: '朋友服',
        kind: 'fabric',
        mcVersion: '1.20.1',
        memoryMb: 2048,
        port: 25599,
        eulaAccepted: true,
        createdAt: Date.now(),
        jarFile: 'fabric-server-launch.jar',
        loaderVersion: '0.15.0'
      }),
      'utf-8'
    )
    fakeJar(path.join(srvDir, 'mods', 'sodium-0.5.jar'), 'sodium')
    fakeJar(path.join(srvDir, 'mods', 'lithium-0.12.jar'), 'lithium')

    const manifest = buildManifest(sid)!
    log(`清单：${manifest.name} ${manifest.mcVersion}/${manifest.loader} mods=${manifest.mods.length} gamePort=${manifest.gamePort}`)

    // 2) 起来并提供 HTTP
    const info = await startManifestServer(sid)
    log(`清单服务端口：${info?.port} mods=${info?.mods}`)

    const discovered = await discoverManifest('127.0.0.1', 25599)
    log(`客户端发现清单：${discovered ? `${discovered.base} / ${discovered.manifest.mods.length} 个 mod` : '失败'}`)

    // 3) 造一个只有 1 个 mod 的客户端实例
    const inst = createInstance({ name: 'b8-client', mcVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.15.0' })
    ensureGamePath(inst)
    const clientMods = path.join(gamePathFor(inst), 'mods')
    fs.mkdirSync(clientMods, { recursive: true })
    fs.copyFileSync(path.join(srvDir, 'mods', 'sodium-0.5.jar'), path.join(clientMods, 'sodium-0.5.jar'))
    fakeJar(path.join(clientMods, 'extra-client-only.jar'), 'extra')

    const diff = compareEnvironment(inst.id, discovered!.manifest, discovered!.base)
    log(`对比结果：缺 ${diff.missing.length} 个（${diff.missing.map((m) => m.file).join(',')}），多 ${diff.extra.length} 个（${diff.extra.join(',')}）`)
    log(`版本/加载器：${diff.versionMismatch ? '不匹配' : '匹配'} / ${diff.loaderMismatch ? '不匹配' : '匹配'}`)

    // 4) 自动补齐
    const res = await syncEnvironment(inst.id, diff, (p) => p.phase && log(`  ${p.phase}`))
    log(`补齐：成功 ${res.added} 个，失败 ${res.failed.length} 个`)
    const after = compareEnvironment(inst.id, discovered!.manifest, discovered!.base)
    log(`补齐后再对比：缺 ${after.missing.length} 个（应为 0）`)

    stopManifestServer(sid)
    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
