import { contextBridge, ipcRenderer, webUtils } from 'electron'

export type EventChannel =
  | 'event:progress'
  | 'event:launch-log'
  | 'event:launch-state'
  | 'event:host-log'
  | 'event:host-exit'
  | 'event:task'

const api = {
  invoke: <T = unknown>(channel: string, ...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>,
  on: (channel: EventChannel, listener: (payload: any) => void) => {
    const wrapped = (_e: unknown, payload: any) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  /** 拖拽进来的 File 拿到真实路径（Electron 32+ 用 webUtils） */
  pathOfFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  }
}

contextBridge.exposeInMainWorld('launcher', api)

export type LauncherApi = typeof api
