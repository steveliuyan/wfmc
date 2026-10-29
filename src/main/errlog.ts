import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'

/**
 * 本地错误日志（不上传，只落在 dataDir/logs/errors.log）。
 * 崩溃时把这份日志 + 实例日志一起打进诊断包，交给作者看。
 */

function logFile() {
  const dir = path.join(store.dataDir, 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'errors.log')
}

export function logError(scope: string, message: string, detail?: string): void {
  try {
    const file = logFile()
    // 超过 1MB 就滚动一次
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      fs.renameSync(file, file.replace(/\.log$/, '.1.log'))
    }
    const stamp = new Date().toISOString()
    const line = `[${stamp}] [${scope}] ${message}${detail ? `\n${detail}` : ''}\n`
    fs.appendFileSync(file, line, 'utf-8')
  } catch {
    /* 记录失败就算了，别把主流程带崩 */
  }
}

export function readErrors(limit = 400): string[] {
  try {
    const file = logFile()
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8').split(/\r?\n/).slice(-limit)
  } catch {
    return []
  }
}

export function errorsFile(): string {
  return logFile()
}

/** 主进程兜底：未捕获异常 / 未处理 Promise 都记下来 */
export function installGlobalHandlers(): void {
  process.on('uncaughtException', (e) => {
    logError('main', e?.message ?? String(e), e?.stack)
  })
  process.on('unhandledRejection', (reason) => {
    const err = reason as Error
    logError('main-rejection', err?.message ?? String(reason), err?.stack)
  })
}
