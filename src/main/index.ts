import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import { registerIpc, setMainWindow } from './ipc'
import { installGlobalHandlers, logError } from './errlog'
import { flushMetaCache } from './content'
import { refreshTray, setupTray } from './tray'
import { applyProxy, installChromiumFetch } from './proxy'

const devUrl = process.env.VITE_DEV_SERVER_URL

/**
 * 关掉 HTTP/2 / QUIC。
 *
 * 原因：cdn.modrinth.com、代理出口、以及大部分镜像都是「按连接限速」的。
 * HTTP/2 会把同域名的所有请求复用进一条 TCP 连接，于是 8 条并发 Range 请求
 * 全挤在一条连接里共享那 ~50KB/s 的配额 —— 实测同一个 7.2MB 文件，
 * 开着 h2 只有 ~55KB/s，关掉之后 8 条连接各走各的，能跑 ~150KB/s。
 * QUIC（h3）同理，也是复用，一起关掉。
 */
app.commandLine.appendSwitch('disable-http2')
app.commandLine.appendSwitch('disable-quic')

/** 记住的窗口位置可能来自别的显示器配置，先校验它还在可见范围内 */
function safeBounds(
  saved?: { x: number; y: number; width: number; height: number; maximized?: boolean }
): { x?: number; y?: number; width: number; height: number; maximized?: boolean } {
  const fallback = { width: 1280, height: 820 }
  if (!saved) return fallback
  const width = Math.max(1024, Math.min(4000, saved.width || 1280))
  const height = Math.max(680, Math.min(3000, saved.height || 820))
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return (
      saved.x + width > a.x + 40 &&
      saved.x < a.x + a.width - 40 &&
      saved.y + height > a.y + 40 &&
      saved.y < a.y + a.height - 40
    )
  })
  if (!visible) return { width, height, maximized: saved.maximized }
  return { x: saved.x, y: saved.y, width, height, maximized: saved.maximized }
}

function appIcon(): string | undefined {
  for (const candidate of [path.join(app.getAppPath(), 'build', 'icon.ico'), path.join(__dirname, '../../build/icon.ico')]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function createWindow() {
  const saved = safeBounds(store.settings.windowState)
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: store.settings.theme === 'dark' ? '#0e1018' : '#f6f7fb',
    title: 'WFMC',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (saved?.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // 记住窗口位置与大小
  const saveBounds = () => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const bounds = maximized ? win.getNormalBounds() : win.getBounds()
    store.setSettings({ windowState: { ...bounds, maximized } })
  }
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)
  win.on('close', saveBounds)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const shotPage = process.env.WFMC_SHOT_PAGE
  if (devUrl) {
    win.loadURL(shotPage ? `${devUrl}?page=${shotPage}` : devUrl)
    if (!process.env.WFMC_SHOT) win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), shotPage ? { query: { page: shotPage, ...(process.env.WFMC_SHOT_MUSIC ? { music: 'open' } : {}) } } : undefined)
  }

  // 开发自检：WFMC_SHOT=<png 路径> 时截一张窗口内容（不受其它窗口遮挡影响）
  const shotPath = process.env.WFMC_SHOT
  if (shotPath) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // WFMC_SHOT_JS：截图前先跑一段 JS（例如点开某个下拉框）
          if (process.env.WFMC_SHOT_JS) {
            await win.webContents.executeJavaScript(process.env.WFMC_SHOT_JS)
            await new Promise((r) => setTimeout(r, 500))
          }
          const image = await win.webContents.capturePage()
          fs.writeFileSync(shotPath, image.toPNG())
          if (process.env.WFMC_SHOT_DOM) {
            // 选择器默认还是老的 .music/.music-toggle；要看别的节点就设 WFMC_SHOT_SEL=".stat-bars,.stat-foot"
            const sel = JSON.stringify(process.env.WFMC_SHOT_SEL ?? '.music, .music-toggle')
            const dump = await win.webContents.executeJavaScript(
              `JSON.stringify(Array.from(document.querySelectorAll(${sel})).map((n) => ({ cls: n.className, tag: n.tagName, text: (n.textContent || '').slice(0, 40), rect: n.getBoundingClientRect().toJSON(), mt: getComputedStyle(n).marginTop, ac: getComputedStyle(n).alignContent })))`
            )
            fs.writeFileSync(process.env.WFMC_SHOT_DOM, String(dump))
          }
        } catch {
          /* 截图失败不影响启动 */
        }
        app.quit()
      }, Number(process.env.WFMC_SHOT_DELAY ?? 2500))
    })
  }

  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  installGlobalHandlers()

app.on('render-process-gone', (_e, _wc, details) => {
  logError('renderer-gone', details.reason, 'exitCode=' + details.exitCode)
})

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    store.load()
    // 主进程的网络统一走 Chromium：环境变量里的残留代理不会再把请求带沟里
    installChromiumFetch()
    await applyProxy(store.settings.proxy)
    registerIpc()
    const win = createWindow()
    setMainWindow(win)
    setupTray(win)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) setMainWindow(createWindow())
    })
  })

  // 退出前把 jar 元数据缓存落盘，下次进内容管理不用再拆一遍压缩包
  app.on('will-quit', () => flushMetaCache())

  app.on('window-all-closed', () => {
    // 有托盘在，窗口关掉不退出（服务端还能继续跑），只有「退出」菜单/强制退出才真的结束
    if (process.platform === 'darwin') return
  })
}
