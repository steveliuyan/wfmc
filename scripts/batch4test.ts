// 第四批实测：Fabric/Forge/NeoForge 服务端版本、Fabric 服务端下载、运维（白名单/OP/统计）
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import {
  addAccessEntry,
  backupHosted,
  createHostedServer,
  hostedServerDir,
  hostedStats,
  listLoaderServerVersions,
  readAccessList,
  removeAccessEntry
} from '../src/main/serverhost'

const out = path.join(process.cwd(), '.tmp-shot', 'batch4.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b4] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch4'), downloadSource: 'mirror' })

    for (const kind of ['fabric', 'forge', 'neoforge'] as const) {
      const list = await listLoaderServerVersions(kind, '1.20.1').catch((e) => [`err:${e.message}`] as string[])
      log(`${kind} 1.20.1 可装版本 ${list.length} 个，前 3：${list.slice(0, 3).join(', ')}`)
    }

    // Fabric 服务端 jar 下载
    const t0 = Date.now()
    const fabric = await createHostedServer(
      { name: 'b4-fabric', kind: 'fabric', mcVersion: '1.20.1', memoryMb: 2048, port: 25600 },
      (p) => p.phase && log(`  ${p.phase}`)
    )
    const jar = path.join(hostedServerDir(fabric.id), fabric.jarFile)
    log(
      `Fabric 服务端创建：${fabric.id} loader=${fabric.loaderVersion} jar=${fabric.jarFile} 大小=${(
        fs.statSync(jar).size / 1024
      ).toFixed(0)} KB，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    )

    // 运维：白名单 / OP
    log(`初始白名单 ${readAccessList(fabric.id, 'whitelist').length} 条`)
    addAccessEntry(fabric.id, 'whitelist', 'Steve')
    addAccessEntry(fabric.id, 'whitelist', 'Alex')
    addAccessEntry(fabric.id, 'ops', 'Steve', undefined, 4)
    log(`加入后：白名单 ${readAccessList(fabric.id, 'whitelist').map((e) => e.name).join(',')}；OP ${readAccessList(fabric.id, 'ops').map((e) => `${e.name}(lv${e.level})`).join(',')}`)
    removeAccessEntry(fabric.id, 'whitelist', 'Alex')
    log(`删除 Alex 后白名单 ${readAccessList(fabric.id, 'whitelist').map((e) => e.name).join(',')}`)
    log(`ops.json 落盘：${fs.existsSync(path.join(hostedServerDir(fabric.id), 'ops.json'))}`)

    // 备份（没有世界时会报错，验证提示正常）
    try {
      const backup = backupHosted(fabric.id)
      log(`备份：${backup}`)
    } catch (e: any) {
      log(`备份（预期报错）：${e.message}`)
    }

    // 统计
    log(`统计：${JSON.stringify(hostedStats(fabric.id))}`)

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
