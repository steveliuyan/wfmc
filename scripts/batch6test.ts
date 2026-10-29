// 第六批实测：歌单 / 数据包 / 整合包更新检测 / CF（无 Key 的报错）/ i18n
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { importTracks, listTracks, musicDir, removeTrack } from '../src/main/music'
import { deleteDatapack, importDatapack, listDatapacks, listWorlds, toggleDatapack } from '../src/main/content'
import { checkPackUpdate } from '../src/main/modpack'
import { searchCurseforge } from '../src/main/curseforge'
import { createInstance } from '../src/main/instances'
import { gamePathFor } from '../src/main/paths'
import { translate } from '../src/renderer/i18n'

const out = path.join(process.cwd(), '.tmp-shot', 'batch6.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b6] ${m}\n`, 'utf-8')

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch6') })

    // 1) 歌单
    const fakeMp3 = path.join(os.tmpdir(), 'b6-song.mp3')
    fs.writeFileSync(fakeMp3, Buffer.alloc(2048, 1))
    const tracks = importTracks([fakeMp3])
    log(`歌单导入后 ${tracks.length} 首：${tracks.map((t) => t.name).join(',')}（目录 ${musicDir()}）`)
    const removed = removeTrack('b6-song.mp3')
    log(`删除后剩 ${removed.length} 首`)

    // 2) 数据包
    const inst = createInstance({ name: 'b6-datapack', mcVersion: '1.20.1' })
    const worldDir = path.join(gamePathFor(inst), 'saves', '测试世界', 'datapacks')
    fs.mkdirSync(worldDir, { recursive: true })
    log(`存档列表：${JSON.stringify(listWorlds(inst.id))}`)
    const dpFile = path.join(os.tmpdir(), 'b6-pack.zip')
    fs.writeFileSync(dpFile, Buffer.alloc(512, 2))
    log(`导入后 ${importDatapack(inst.id, '测试世界', [dpFile]).length} 个数据包`)
    log(`停用后：${JSON.stringify(listDatapacks(inst.id, '测试世界').map((p) => `${p.name}${p.disabled ? '(禁用)' : ''}`))}`)
    toggleDatapack(inst.id, '测试世界', 'b6-pack.zip.disabled')
    log(`再启用：${JSON.stringify(listDatapacks(inst.id, '测试世界').map((p) => p.name))}`)
    log(`删除后剩 ${deleteDatapack(inst.id, '测试世界', 'b6-pack.zip').length} 个`)

    // 3) 整合包更新检测（非 Modrinth 来源）
    const pack = await checkPackUpdate(inst.id)
    log(`包更新检测：hasUpdate=${pack.hasUpdate} note=${pack.note}`)

    // 4) CF 无 Key
    try {
      await searchCurseforge({ query: 'jei' })
      log('CF：居然搜到了（说明有 Key）')
    } catch (e: any) {
      log(`CF 无 Key 提示：${e.message}`)
    }

    // 5) i18n
    log(`i18n zh: ${translate('zh', 'nav.online')} / en: ${translate('en', 'nav.online')} / 缺 key 回退: ${translate('en', 'no.such.key', 'fallback')}`)

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
