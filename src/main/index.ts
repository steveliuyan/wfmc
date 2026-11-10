import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import { registerIpc, setMainWindow } from './ipc'
import { installGlobalHandlers, logError } from './errlog'
import { flushMetaCache } from './content'
import { flushModMetaCache } from './moddoctor'
import { refreshTray, setupTray } from './tray'
import { applyProxy, installChromiumFetch } from './proxy'
import { startCloudScheduler, stopCloudScheduler } from './cloudsync'
import { startMcpBridge, stopMcpBridge } from './mcp'

const devUrl = process.env.VITE_DEV_SERVER_URL

/**
 * wfmc:// 自定义协议。
 * 用浏览器登录时会先打开网页，登完再跳回 wfmc://login?...；
 * 注册了这个协议，系统才会把那一跳交给启动器，而不是弹「找不到应用」。
 * 真正的登录态是主进程轮询拿的，回跳只是顺手把窗口叫到前台 + 刷新一次状态，
 * 所以便携版写不进注册表也不影响能不能登录成功。
 */
const PROTOCOL = 'wfmc'

function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch {
    /* 注册不上就算了，登录本身不依赖回跳 */
  }
}

function focusMainWindow() {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function handleProtocolUrl(raw?: string) {
  if (!raw || !raw.toLowerCase().startsWith(`${PROTOCOL}:`)) return
  focusMainWindow()
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) win.webContents.send('event:protocol', raw)
}

function protocolUrlFromArgv(argv: string[]): string | undefined {
  return argv.find((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}:`))
}

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

// MCP stdio 端不在这里：它得用 ELECTRON_RUN_AS_NODE=1 跑成纯 Node（见 mcp-stdio.ts / mcpClientConfig）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  registerProtocol()
  // Windows / Linux：第二次启动时命令行里带着 wfmc://…
  app.on('second-instance', (_e, argv) => {
    handleProtocolUrl(protocolUrlFromArgv(argv))
    focusMainWindow()
  })
  // macOS
  app.on('open-url', (e, url) => {
    e.preventDefault()
    handleProtocolUrl(url)
  })

  installGlobalHandlers()

app.on('render-process-gone', (_e, _wc, details) => {
  logError('renderer-gone', details.reason, 'exitCode=' + details.exitCode)
})

app.whenReady().then(async () => {
    // Windows 右下角系统通知要靠 AppUserModelID 才认得是谁发的。
    // 安装版（NSIS）有开始菜单快捷方式，这里显式设一次更稳；portable 版没有快捷方式，
    // toast 可能被系统吞掉 —— 所以「弹窗」类通知同时还弹界面里的模态框，不单靠系统通知。
    app.setAppUserModelId('com.wanfan.wfmc')
    Menu.setApplicationMenu(null)
    store.load()
    // 主进程的网络统一走 Chromium：环境变量里的残留代理不会再把请求带沟里
    installChromiumFetch()
    await applyProxy(store.settings.proxy)
    registerIpc()
    const win = createWindow()
    setMainWindow(win)
    // MCP：给 AI 助手开一个本机回环、带令牌的小接口（设置里能关）
    void startMcpBridge()
    setupTray(win)
    // 冷启动就是被 wfmc:// 拉起来的（浏览器回跳时启动器还没开）
    handleProtocolUrl(protocolUrlFromArgv(process.argv))
    // 云同步（默认关；没配置的话 startCloudScheduler 内部直接返回，不发任何请求）
    startCloudScheduler()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) setMainWindow(createWindow())
    })
  })

  // 退出前把 jar 元数据缓存落盘，下次进内容管理不用再拆一遍压缩包
  app.on('will-quit', () => {
    stopCloudScheduler()
    void stopMcpBridge()
    flushMetaCache()
    flushModMetaCache()
  })

  app.on('window-all-closed', () => {
    // 有托盘在，窗口关掉不退出（服务端还能继续跑），只有「退出」菜单/强制退出才真的结束
    if (process.platform === 'darwin') return
  })
}
