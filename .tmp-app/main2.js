const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const log = (...a) => fs.appendFileSync(path.join(__dirname, 'out2.log'), a.map(String).join(' ') + '\n')
app.whenReady().then(async () => {
  try {
    const { store, inspectLangPack } = require('./bundle')
    const { gamePathFor } = require('./bundle')
    store.load()
    const list = store.listInstances()
    log('instances=' + JSON.stringify(list.map((i) => [i.id, i.mcVersion, i.versionId, i.isolate, i.installed])))
    const t = list[0]
    const cov = inspectLangPack(t.id)
    log('COVER ' + JSON.stringify(cov.packs) + ' total=' + cov.coveredCount + ' mods=' + JSON.stringify(cov.mods))
  } catch (e) {
    log('ERR ' + (e && e.message))
  }
  app.quit()
})
