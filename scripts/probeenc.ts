import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { store } from '../src/main/store'

const out = path.join(process.cwd(), '.tmp-shot', 'enc.log')
fs.writeFileSync(out, '', 'utf-8')
const log = (m: string) => fs.appendFileSync(out, m + '\n', 'utf-8')

app.whenReady().then(() => {
  store.load()
  store.setSettings({ dataDir: path.join(os.tmpdir(), 'wfmc-enc') })
  store.setAccounts([
    { id: 'a1', type: 'yggdrasil', name: 'Steve', uuid: '0', accessToken: 'SECRET-TOKEN-123', server: 'https://x/api/yggdrasil' }
  ])
  const file = store.accountsFile
  log('accountsFile=' + file)
  log('exists=' + fs.existsSync(file))
  const raw = fs.readFileSync(file, 'utf-8')
  log('含明文? ' + (raw.includes('SECRET-TOKEN-123') ? '是(加密未生效)' : '否(已加密)'))
  log('片段: ' + raw.replace(/\s+/g, ' ').slice(0, 160))
  log('内存读回: ' + store.accounts[0].accessToken)
  app.exit(0)
})
