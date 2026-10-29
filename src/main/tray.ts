import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'
import { listHostedServers, isHostedRunning, stopHosted } from './serverhost'

/**
 * 托盘常驻：
 * - 点窗口 ✕ 时（默认）最小化到托盘，服务端继续跑
 * - 托盘菜单：显示主界面 / 停止所有服务端 / 退出
 */

let tray: Tray | null = null
let quitting = false

function trayIcon(): Electron.NativeImage {
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(process.resourcesPath ?? '', 'build/icon.png'),
    path.join(app.getAppPath(), 'build/icon.png')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file)
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
    }
  }
  return nativeImage.createEmpty()
}

/** 通知气泡用的高清图标：托盘那张是 16×16，放大到通知里就糊了 */
function bigIcon(): Electron.NativeImage | undefined {
  const candidates = [
    path.join(__dirname, '../../build/icon.png'),
    path.join(process.resourcesPath ?? '', 'build/icon.png'),
    path.join(app.getAppPath(), 'build/icon.png')
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file)
      if (!img.isEmpty()) return img.resize({ width: 128, height: 128, quality: 'best' })
    }
  }
  return undefined
}

function runningSummary(): string {
  const running = listHostedServers().filter((s) => isHostedRunning(s.id))
  if (running.length === 0) return '没有服务端在运行'
  return running.map((s) => `${s.name}（${s.kind} ${s.mcVersion}）`).join('、')
}

export function buildTrayMenu(win: BrowserWindow | null) {
  const running = listHostedServers().filter((s) => isHostedRunning(s.id))
  return Menu.buildFromTemplate([
    { label: `服务端：${running.length} 个在跑`, enabled: false },
    { type: 'separator' },
    {
      label: '显示主界面',
      click: () => {
        if (!win || win.isDestroyed()) return
        win.show()
        win.focus()
      }
    },
    {
      label: '停止所有服务端',
      enabled: running.length > 0,
      click: async () => {
        for (const s of running) stopHosted(s.id)
        refreshTray(win)
      }
    },
    { type: 'separator' },
    {
      label: '退出 WFMC',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

export function refreshTray(win: BrowserWindow | null) {
  if (!tray) return
  tray.setToolTip(`WFMC · ${runningSummary()}`)
  tray.setContextMenu(buildTrayMenu(win))
}

export function setupTray(win: BrowserWindow) {
  if (tray) {
    refreshTray(win)
    return
  }
  tray = new Tray(trayIcon())
  tray.setToolTip('WFMC · 万凡 Minecraft 启动器')
  tray.setContextMenu(buildTrayMenu(win))
  tray.on('click', () => {
    if (!win.isDestroyed()) {
      win.isVisible() ? win.hide() : (win.show(), win.focus())
    }
  })

  // 关窗行为：服务端还在跑 / 用户选了「最小化到托盘」→ 藏起来而不是退出
  win.on('close', (e) => {
    if (quitting) return
    const running = listHostedServers().filter((s) => isHostedRunning(s.id))
    const keep = running.length > 0 || (store.settings.closeToTray ?? true)
    if (!keep) return
    e.preventDefault()
    win.hide()
    {
      const icon = bigIcon()
      tray?.displayBalloon?.({
        title: 'WFMC 还在后台运行',
        content: running.length > 0 ? `${runningSummary()} 仍在运行，从托盘图标可以随时回来。` : '从托盘图标可以随时回来。',
        ...(icon ? { iconType: 'custom' as const, icon } : {})
      })
    }
  })

  app.on('before-quit', () => {
    quitting = true
  })
}

export function isQuitting() {
  return quitting
}