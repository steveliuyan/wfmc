// 临时 electron 替身：只为了让主进程模块能在 node 里跑单测。验证完即删。
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-stub-'))

module.exports = {
  app: {
    getPath: (name) => {
      const p = path.join(base, name)
      fs.mkdirSync(p, { recursive: true })
      return p
    },
    getVersion: () => '1.2.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: async () => {},
    quit: () => {}
  },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: { openPath: async () => '', openExternal: async () => {}, showItemInFolder: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showMessageBox: async () => ({ response: 0 }) },
  BrowserWindow: class {},
  Notification: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => {} }
}
