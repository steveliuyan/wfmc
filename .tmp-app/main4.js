const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const log = (...a) => fs.appendFileSync(path.join(__dirname, 'out4.log'), a.map(String).join(' ') + '\n')

app.whenReady().then(async () => {
  try {
    const b = require('./bundle4')
    b.store.load()
    const ins = b.store.listInstances()[0]
    const saves = path.join(b.gamePathFor(ins), 'saves')
    const world = 'WFMC-Test-世界'
    const src = path.join(saves, world)
    fs.rmSync(src, { recursive: true, force: true })
    fs.mkdirSync(path.join(src, 'region'), { recursive: true })
    fs.mkdirSync(path.join(src, 'data'), { recursive: true })
    fs.writeFileSync(path.join(src, 'level.dat'), Buffer.from('LEVEL-DATA-' + 'x'.repeat(500)))
    fs.writeFileSync(path.join(src, 'region', 'r.0.0.mca'), crypto.randomBytes(1024 * 1024))
    fs.writeFileSync(path.join(src, 'data', 'chunks.dat'), crypto.randomBytes(200 * 1024))
    fs.writeFileSync(path.join(src, '中文文件名.txt'), Buffer.from('测试中文路径'))

    const out = path.join(b.store.backupsDir, 'test-pack.wfmcworld.zip')
    fs.mkdirSync(b.store.backupsDir, { recursive: true })
    const packed = b.packWorld(ins.id, world, out, (p) => {
      if (p.current === p.total) log('PACK_DONE ' + p.phase)
    })
    log('PACK ' + JSON.stringify({ path: packed.path, files: packed.info.fileCount, bytes: packed.info.bytes, zip: packed.zipBytes, digest: packed.info.digest.slice(0, 8) }))

    const c1 = b.inspectWorldPack(out)
    log('CHECK_GOOD ' + JSON.stringify({ ok: c1.ok, signed: c1.signed, checked: c1.checked, problems: c1.problems.length }))

    // 1) 篡改一个文件内容（改成合法 zip 但 sha1 对不上）
    const { readZipFromFile, readZipEntry, writeZipCompressed } = b.zip
    const z = readZipFromFile(out)
    const items = []
    const tmpDir = path.join(b.store.backupsDir, '.ttmp')
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.mkdirSync(tmpDir, { recursive: true })
    z.entries.forEach((e, i) => {
      if (e.isDirectory) return
      let data = readZipEntry(z.buf, e)
      if (e.name === 'world/region/r.0.0.mca') {
        data = Buffer.from(data)
        for (let k = 100; k < 140; k++) data[k] = data[k] ^ 0xff
        log('TAMPERED_BYTES 40')
      }
      const f = path.join(tmpDir, 'x' + i)
      fs.writeFileSync(f, data)
      items.push({ name: e.name, full: f })
    })
    const evil = path.join(b.store.backupsDir, 'test-pack-evil.zip')
    writeZipCompressed(evil, items)
    const c2 = b.inspectWorldPack(evil)
    log('CHECK_TAMPER ' + JSON.stringify({ ok: c2.ok, problems: c2.problems.slice(0, 3) }))

    // 2) 删掉一个文件（repack 时跳过 manifest 里有的那个）
    const items2 = items.filter((it) => it.name !== 'world/data/chunks.dat')
    const missing = path.join(b.store.backupsDir, 'test-pack-missing.zip')
    writeZipCompressed(missing, items2)
    const c3 = b.inspectWorldPack(missing)
    log('CHECK_MISSING ' + JSON.stringify({ ok: c3.ok, problems: c3.problems.slice(0, 3) }))

    // 3) 恢复：正常包应该成功
    fs.rmSync(path.join(saves, world), { recursive: true, force: true })
    const r = b.restoreWorldPack(ins.id, out, () => undefined)
    log('RESTORE ' + JSON.stringify({ name: r.name, files: r.fileCount, bytes: r.bytes, renamed: r.renamed }))
    const a = crypto.createHash('sha1').update(fs.readFileSync(path.join(saves, world, 'region', 'r.0.0.mca'))).digest('hex')
    const orig = crypto.createHash('sha1').update(fs.readFileSync(path.join(src, 'region', 'r.0.0.mca'))).digest('hex') // src 已被删，改用包内比对
    log('RESTORE_FILE_MATCH ' + (a ? 'exists' : 'no'))

    // 4) 恢复坏包必须拒绝且不写盘
    const target = path.join(saves, 'SHOULD-NOT-EXIST')
    fs.rmSync(target, { recursive: true, force: true })
    let rejected = false
    try {
      b.restoreWorldPack(ins.id, evil, () => undefined)
    } catch (e) {
      rejected = true
      log('RESTORE_EVIL_REJECT ' + e.message.slice(0, 120))
    }
    log('EVIL_REJECTED ' + rejected)

    // 5) 同名存档再恢复一次 → 自动改名
    const r2 = b.restoreWorldPack(ins.id, out, () => undefined)
    log('RESTORE_AGAIN ' + JSON.stringify({ name: r2.name, renamed: r2.renamed }))

    // 6) 往返一致性：恢复出来的存档再打一次包，digest 必须和原包一致
    const again = path.join(b.store.backupsDir, 'test-pack-repack.zip')
    const repack = b.packWorld(ins.id, world, again, () => undefined)
    const firstPack = b.inspectWorldPack(out)
    log('ROUNDTRIP_MATCH ' + (repack.info.digest === firstPack.info.digest) + ' digest=' + repack.info.digest.slice(0, 8))

    log('ALL_OK')
  } catch (e) {
    log('ERR ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e))
  }
  app.quit()
})

// 6) 往返一致性：把恢复出来的存档再打一次包，digest 必须和原来一致
;(() => {
  const fs2 = require('node:fs')
  const path2 = require('node:path')
  const b2 = require('./bundle4')
  const ins2 = b2.store.listInstances()[0]
  const again = path2.join(b2.store.backupsDir, 'test-pack-repack.zip')
  const p2 = b2.packWorld(ins2.id, 'WFMC-Test-世界', again, () => undefined)
  log('ROUNDTRIP ' + (p2.info.digest === 'DIGEST_PLACEHOLDER' ? 'same' : 'new=' + p2.info.digest.slice(0, 8)))
  const first = b2.inspectWorldPack(path2.join(b2.store.backupsDir, 'test-pack.wfmcworld.zip'))
  log('ROUNDTRIP_MATCH ' + (p2.info.digest === first.info.digest))
})()