/**
 * 真机冒烟：在真实实例上跑一遍「导出 CurseForge 整合包（.zip）」。
 *
 * 不开 Electron：用 esbuild 把 src/main 相关模块打成一个临时 ESM 包，
 * 顺手把 `electron` 换成内存里的桩（跟 scripts/test-core.mjs 同一套办法）。
 * 唯一的不同是 app.getPath('userData') 指向**真实的** %APPDATA%\wfmc，
 * 这样 store 能读到玩家自己的 settings.json（含 curseforgeApiKey / dataDir）。
 *
 * 用法：node scripts/smoke-cfexport.mjs <实例 id> [...]
 *   （实例 id 见数据目录 instances/ 下的目录名）
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const ids = process.argv.slice(2)
if (ids.length === 0) {
  console.error('用法：node scripts/smoke-cfexport.mjs <实例 id> [...]')
  process.exit(2)
}

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')

/** 真实 userData 的 electron 桩（其余都是空实现，只够 import 期不炸） */
const ELECTRON_STUB = `
import path from 'node:path'
const noop = () => {}
const appData = ${JSON.stringify(appData)}
export const app = {
  getPath: (name) => (name === 'userData' ? path.join(appData, 'wfmc') : path.join(appData, 'wfmc', String(name || 'x'))),
  getAppPath: () => ${JSON.stringify(root)},
  getVersion: () => '0.0.0-smoke',
  getName: () => 'wfmc',
  isPackaged: false,
  on: noop,
  once: noop,
  quit: noop,
  whenReady: () => Promise.resolve(),
  setPath: noop
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(String(s), 'utf-8'),
  decryptString: (b) => Buffer.from(b).toString('utf-8')
}
export const ipcMain = { handle: noop, on: noop, removeHandler: noop }
export const net = { fetch: (...a) => globalThis.fetch(...a), isOnline: () => true, request: () => { throw new Error('no net.request') } }
export const session = {
  defaultSession: { setProxy: async () => {}, resolveProxy: async () => 'DIRECT', webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop } },
  fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'DIRECT', webRequest: {} })
}
export const shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: noop, trashItem: async () => {} }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }
export const BrowserWindow = class {}
export const Notification = class { static isSupported() { return false } show() {} on() {} }
export default { app, safeStorage, ipcMain, shell, dialog, BrowserWindow, Notification }
`

const ENTRY = `
import { store } from './src/main/store'
import { cfExportReady, exportInstanceAsCurseforgeZip } from './src/main/cfexport'

store.load()
console.log('dataDir =', store.dataDir)

for (const id of ${JSON.stringify(ids)}) {
  const ready = cfExportReady(id)
  console.log('\\n== ' + id + ' | 有 key=' + ready.hasKey + ' | mods=' + ready.mods)
  if (!ready.hasKey) { console.log('  没有 curseforgeApiKey，跳过'); continue }
  const t0 = Date.now()
  const res = await exportInstanceAsCurseforgeZip(id, (p) => console.log('  ·', p.phase))
  const size = (await import('node:fs')).statSync(res.path).size
  console.log('  完成 ' + (((Date.now() - t0) / 1000).toFixed(1)) + 's | 对上 ' + res.matched + ' | overrides ' + res.unmatched + ' | ' + (size / 1024 / 1024).toFixed(2) + ' MB')
  console.log('  → ' + res.path)
}
`

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-smokecf-'))
const outFile = path.join(outDir, 'smoke.mjs')

await build({
  stdin: { contents: ENTRY, resolveDir: root, loader: 'ts', sourcefile: 'smoke-cfexport.ts' },
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  absWorkingDir: root,
  external: ['node:*'],
  logLevel: 'warning',
  plugins: [
    {
      name: 'electron-stub',
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
        b.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: ELECTRON_STUB, loader: 'js' }))
      }
    }
  ]
})

try {
  await import(pathToFileURL(outFile).href)
} finally {
  try {
    fs.rmSync(outDir, { recursive: true, force: true })
  } catch {
    /* 临时目录清不掉无所谓 */
  }
}
