/**
 * 跑 scripts/tests/core.ts 里的纯函数断言。
 *
 * 不启 Electron：用 esbuild 把入口连同 `src/main/*` 打成一个临时 ESM 包，
 * 顺手把 `electron` 换成内存里的小桩（`AGENTS.md` §6 的老办法）。
 * 用法：`npm run test:core`
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/** electron 的最小桩：只提供主进程模块在 import 期会碰到的东西 */
const ELECTRON_STUB = `
import os from 'node:os'
import path from 'node:path'
const noop = () => {}
export const app = {
  getPath: (name) => path.join(os.tmpdir(), 'wfmc-test', String(name || 'x')),
  getAppPath: () => process.cwd(),
  getVersion: () => '0.0.0-test',
  getName: () => 'wfmc-test',
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
export const net = {
  fetch: (...args) => globalThis.fetch(...args),
  isOnline: () => true,
  request: () => {
    throw new Error('electron.net.request 不在纯函数断言范围内')
  }
}
export const session = {
  defaultSession: {
    setProxy: async () => {},
    resolveProxy: async () => 'DIRECT',
    webRequest: { onBeforeSendHeaders: noop, onHeadersReceived: noop }
  },
  fromPartition: () => ({ setProxy: async () => {}, resolveProxy: async () => 'DIRECT', webRequest: {} })
}
export const shell = { openPath: async () => '', openExternal: async () => {}, showItemInFolder: noop, trashItem: async () => {} }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) }
export const BrowserWindow = class {}
export const Notification = class { static isSupported() { return false } show() {} on() {} }
export default { app, safeStorage, ipcMain, shell, dialog, BrowserWindow, Notification }
`

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-testcore-'))
const outFile = path.join(outDir, 'core.mjs')

await build({
  entryPoints: [path.join(here, 'tests', 'core.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  absWorkingDir: root,
  external: ['node:*'],
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
    /* 临时目录删不掉也无所谓 */
  }
}
