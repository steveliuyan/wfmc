import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'
import { importDatapack, listDatapacks, toggleDatapack } from '../src/main/content'
import { createInstance } from '../src/main/instances'
import { gamePathFor } from '../src/main/paths'

const out = path.join(process.cwd(), '.tmp-shot', 'probe.log')
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, m + '\n', 'utf-8')

app.whenReady().then(() => {
  store.load()
  store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-probe-dp') })
  const inst = createInstance({ name: 'probe-dp', mcVersion: '1.20.1' })
  const world = 'W1'
  const dir = path.join(gamePathFor(inst), 'saves', world, 'datapacks')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(os.tmpdir(), 'p.zip')
  fs.writeFileSync(src, Buffer.alloc(64, 3))
  importDatapack(inst.id, world, [src])
  log('dir=' + dir)
  log('exists before=' + fs.existsSync(path.join(dir, 'p.zip')))
  const after = toggleDatapack(inst.id, world, 'p.zip')
  log('listdir=' + JSON.stringify(fs.readdirSync(dir)))
  log('returned=' + JSON.stringify(after.map((p) => [p.name, p.disabled])))
  app.exit(0)
})
