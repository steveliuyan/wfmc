const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const log = (...a) => fs.appendFileSync(path.join(__dirname, 'out3.log'), a.map(String).join(' ') + '\n')
app.whenReady().then(async () => {
  try {
    const b = require('./bundle3')
    b.store.load()
    const t = b.store.listInstances()[0]
    log('ID=' + t.id)
    log('GAME=' + b.gamePathFor(t))
    try {
      const items = b.listContent(t.id, 'mods')
      log('MODS=' + items.length + ' ' + JSON.stringify(items.map((i) => [i.name, i.title, i.iconPath ? 'icon' : 'noicon'])))
    } catch (e) {
      log('MODS_ERR ' + (e && e.message))
    }
  } catch (e) {
    log('ERR ' + (e && e.message))
  }
  app.quit()
})
