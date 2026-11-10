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

// 产物放在项目目录里（不是系统临时目录）：mcp.ts 会顺带拖进 @xmcl/* / yauzl 这些
// CommonJS 依赖，它们在运行时 require('fs')、找自己的 node_modules，只有待在项目树下才解析得到。
const outDir = fs.mkdtempSync(path.join(root, '.tmp-testcore-'))
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
  // 打进来的 CJS 依赖要用真的 require / __dirname，esbuild 的 ESM 壳里默认没有
  banner: {
    js: [
      "import { createRequire as __wfmcCr } from 'node:module'",
      "import { fileURLToPath as __wfmcFu } from 'node:url'",
      "import { dirname as __wfmcDir } from 'node:path'",
      'const __filename = __wfmcFu(import.meta.url)',
      'const __dirname = __wfmcDir(__filename)',
      'const require = __wfmcCr(import.meta.url)'
    ].join('\n')
  },
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
