/**
 * 真机冒烟的小工具：把一段 TS 入口用 esbuild 打成一个临时 ESM 包，
 * 顺手把 `electron` 换成内存里的桩（和 scripts/test-core.mjs 同一套办法）。
 *
 * 区别只有一个：app.getPath('userData') 指向**真实的** %APPDATA%\wfmc，
 * 这样 store 能读到玩家自己的 settings.json（含 curseforgeApiKey / dataDir / downloadSource）。
 *
 * 用法：await runMainWithElectronStub(`import { store } from './src/main/store'; ...`)
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const root = path.join(here, '..', '..')

const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')

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

export async function runMainWithElectronStub(entryCode, opts = {}) {
  let outDir
  if (opts.outDir) {
    fs.mkdirSync(opts.outDir, { recursive: true })
    outDir = opts.outDir
  } else {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-smoke-'))
  }
  const outFile = path.join(outDir, 'main.mjs')
  await build({
    stdin: { contents: entryCode, resolveDir: root, loader: 'ts', sourcefile: 'smoke-entry.ts' },
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    absWorkingDir: root,
    external: ['node:*', ...(opts.external || [])],
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
      if (!opts.outDir) fs.rmSync(outDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉无所谓 */
    }
  }
}
