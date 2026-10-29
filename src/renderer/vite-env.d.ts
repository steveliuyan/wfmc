/// <reference types="vite/client" />

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

export interface LauncherBridge {
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>
  on: (
    channel:
      | 'event:progress'
      | 'event:launch-log'
      | 'event:launch-state'
      | 'event:host-log'
      | 'event:host-exit'
      | 'event:task',
    cb: (payload: any) => void
  ) => () => void
  pathOfFile: (file: File) => string
}

declare global {
  interface Window {
    launcher: LauncherBridge
  }
}
