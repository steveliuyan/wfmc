// 第五批实测：测速 / 资源包顺序 / 诊断包导出 / 临时文件清理
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { speedTest, cleanTempFiles } from '../src/main/speedtest'
import { exportDiagnostics, moveResourcePack, readResourcePackOrder, toggleResourcePack } from '../src/main/content'
import { createInstance } from '../src/main/instances'
import { gamePathFor } from '../src/main/paths'
import { writeZip } from '../src/main/zip'

const out = path.join(process.cwd(), '.tmp-shot', 'batch5.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b5] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch5'), downloadSource: 'mirror' })

    // 1) 测速
    const t0 = Date.now()
    const speed = await speedTest()
    for (const r of speed.results) log(`${r.name} → ${r.ok ? r.ms + 'ms' : '失败 ' + r.error}`)
    log(`建议源：${speed.recommend}（${Date.now() - t0}ms）`)

    // 2) 资源包顺序
    const inst = createInstance({ name: 'b5-packs', mcVersion: '1.20.1' })
    const root = gamePathFor(inst)
    fs.mkdirSync(path.join(root, 'resourcepacks'), { recursive: true })
    log(`初始顺序 ${JSON.stringify(readResourcePackOrder(inst.id))}`)
    toggleResourcePack(inst.id, 'file/A.zip', true)
    toggleResourcePack(inst.id, 'file/B.zip', true)
    log(`启用两个：${JSON.stringify(readResourcePackOrder(inst.id))}`)
    log(`B 上移后：${JSON.stringify(moveResourcePack(inst.id, 'file/B.zip', -1))}`)
    log(`options.txt 内容：${fs.readFileSync(path.join(root, 'options.txt'), 'utf-8').trim()}`)

    // 3) 诊断包
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(root, 'logs', 'latest.log'), '[12:00:00] [main/INFO]: 测试日志\n', 'utf-8')
    fs.mkdirSync(path.join(root, 'crash-reports'), { recursive: true })
    fs.writeFileSync(path.join(root, 'crash-reports', 'crash-1.txt'), 'java.lang.NullPointerException\n', 'utf-8')
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true })
    // 造两个假 jar 让清单有内容
    const tmp = path.join(os.tmpdir(), 'b5-mod.json')
    fs.writeFileSync(tmp, '{"id":"demo"}', 'utf-8')
    writeZip(path.join(root, 'mods', 'demo-mod.jar'), [{ name: 'fabric.mod.json', full: tmp }])

    const diag = exportDiagnostics(inst.id)
    log(`诊断包：${diag.split(/[\\/]/).pop()} (${(fs.statSync(diag).size / 1024).toFixed(1)} KB)`)

    // 4) 清理临时文件
    const clean = cleanTempFiles(store.dataDir)
    log(`清理：${clean.removed} 个文件，释放 ${(clean.freed / 1024).toFixed(1)} KB`)

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
