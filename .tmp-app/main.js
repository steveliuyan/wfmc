const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const log = (...a) => fs.appendFileSync(path.join(__dirname, 'out.log'), a.map(String).join(' ') + '\n')
app.whenReady().then(async () => {
  try {
    const { store, installLangPacks, inspectLangPack } = require('./bundle')
    store.load()
    const list = store.listInstances()
    const t = list.find((i) => i.mcVersion === '1.21.11') || list[0]
    const res = await installLangPacks(t.id, (p) => log('PROG', p.phase, p.current, '/', p.total))
    log('RESULT', JSON.stringify(res))
    const cov = inspectLangPack(t.id)
    log('COVER packs=' + JSON.stringify(cov.packs) + ' total=' + cov.coveredCount + ' mods=' + JSON.stringify(cov.mods))
  } catch (e) {
    log('ERR', e && e.message)
  }
  app.quit()
})