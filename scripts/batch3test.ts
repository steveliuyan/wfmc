// 第三批实测：分片下载 / 任务队列取消 / Mod 体检 / mrpack 导出 / 更新检查
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { downloadFile } from '../src/main/net'
import { runTask, listTasks, cancelTask } from '../src/main/tasks'
import { writeZip } from '../src/main/zip'
import { diagnoseMods } from '../src/main/moddoctor'
import { exportInstanceAsMrpack, inspectMrpack } from '../src/main/modpackexport'
import { createInstance } from '../src/main/instances'
import { gamePathFor } from '../src/main/paths'
import { checkUpdate } from '../src/main/updater'

const out = path.join(process.cwd(), '.tmp-shot', 'batch3.log')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, `[b3] ${m}\n`, 'utf-8')

function makeFakeMod(file: string, id: string, name: string, version: string, deps: string[] = []) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-fake-'))
  const metaFile = path.join(tempDir, 'fabric.mod.json')
  fs.writeFileSync(
    metaFile,
    JSON.stringify({
      schemaVersion: 1,
      id,
      name,
      version,
      depends: Object.fromEntries([['minecraft', '*'], ['fabricloader', '*'], ...deps.map((d) => [d, '*'])]),
      description: 'wfmc test mod'
    }),
    'utf-8'
  )
  const payload = path.join(tempDir, 'payload.txt')
  fs.writeFileSync(payload, `fake jar for ${id} ${version} ${Math.random()}`, 'utf-8')
  writeZip(file, [
    { name: 'fabric.mod.json', full: metaFile },
    { name: 'payload.txt', full: payload }
  ])
  fs.rmSync(tempDir, { recursive: true, force: true })
}

app.whenReady().then(async () => {
  try {
    store.load()
    store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-batch3'), downloadSource: 'mirror' })

    // 1) 分片下载（>4MB 会走 Range）
    const bigUrl = 'https://bmclapi2.bangbang93.com/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar'
    const dest = path.join(os.tmpdir(), 'wfmc-batch3', 'lwjgl-test.jar')
    let lastPct = -1
    const t0 = Date.now()
    await downloadFile(bigUrl, dest, (cur, total) => {
      const pct = total ? Math.floor((cur / total) * 100) : 0
      if (pct >= lastPct + 25) {
        lastPct = pct
        log(`  下载进度 ${pct}% (${cur}/${total})`)
      }
    })
    log(`分片/单流下载完成：${(fs.statSync(dest).size / 1024).toFixed(0)} KB，${Date.now() - t0}ms`)

    // 2) 任务队列 + 取消
    const taskPromise = runTask('misc', '测试长任务', async (ctx) => {
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 150))
        ctx.report({ phase: `走到第 ${i} 步`, current: i, total: 10 })
        if (ctx.signal.aborted) throw new Error('canceled')
      }
      return 'done'
    }).catch((e) => `任务结束：${e.message}`)

    await new Promise((r) => setTimeout(r, 400))
    const running = listTasks().find((t) => t.title === '测试长任务')
    log(`任务已注册：${running?.title} 状态=${running?.status}`)
    if (running) cancelTask(running.id)
    log(`取消结果：${await taskPromise}`)
    log(`取消后状态：${listTasks().find((t) => t.title === '测试长任务')?.status}`)

    // 3) Mod 体检（造两个同 modId 的假 mod + 一个缺前置的）
    const inst = createInstance({ name: 'b3-doctor', mcVersion: '1.20.1', loader: 'fabric', loaderVersion: '0.15.0' })
    const modsDir = path.join(gamePathFor(inst), 'mods')
    fs.mkdirSync(modsDir, { recursive: true })
    makeFakeMod(path.join(modsDir, 'sodium-1.jar'), 'sodium', 'Sodium', '0.5.0')
    makeFakeMod(path.join(modsDir, 'sodium-2.jar'), 'sodium', 'Sodium', '0.6.0')
    makeFakeMod(path.join(modsDir, 'iris.jar'), 'iris', 'Iris', '1.7.0', ['sodium-extra'])
    const report = diagnoseMods(inst.id)
    log(`体检：扫到 ${report.mods.length} 个 mod，${report.issues.length} 条问题`)
    for (const issue of report.issues) log(`  [${issue.level}] ${issue.title} — ${issue.detail.slice(0, 60)}`)

    // 4) 导出 mrpack
    const mrpack = await exportInstanceAsMrpack(inst.id, (p) => p.phase && log(`  ${p.phase}`))
    log(`导出整合包：${mrpack.split(/[\\/]/).pop()} (${(fs.statSync(mrpack).size / 1024).toFixed(1)} KB)`)
    const info = inspectMrpack(mrpack)
    log(`回读 index：name=${info.name} files=${info.files} deps=${JSON.stringify(info.deps)}`)

    // 5) 更新检查（没配 updateUrl）
    const up = await checkUpdate()
    log(`更新检查：current=${up.current} hasUpdate=${up.hasUpdate} note=${up.error ?? '-'}`)

    log('全部完成')
    app.exit(0)
  } catch (e: any) {
    log('失败: ' + (e?.message ?? e))
    app.exit(1)
  }
})
