import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunOptions {
  cwd?: string
  onLine?: (line: string) => void
  /** 总时长上限：到点直接 kill（保底，别指望它能及时发现卡死） */
  timeoutMs?: number
  /**
   * 空闲看门狗：连续这么多毫秒**一行输出都没有**就判定卡死，kill 并 reject。
   *
   * 为什么需要它：Forge 官方安装器卡在一条不返回的 HTTP 连接上时，stdout 会彻底静音，
   * 只有 timeoutMs（20 分钟）兜底 —— 用户看到的就是「进度条一晚上没动」。
   * 装了 watchdog 之后，几分钟没动静就能报错，让用户重试。
   *
   * 不传 = 关闭（老行为）。
   */
  idleTimeoutMs?: number
}

/** 跑一个外部进程，实时把输出喂给 onLine，失败时带上输出 */
export function runProcess(
  command: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    let done = false
    let timer: NodeJS.Timeout | undefined
    let idleTimer: NodeJS.Timeout | undefined

    /** 收尾统一走这里：只结算一次，顺手把两个定时器都拆掉 */
    const settle = (err: Error | undefined, result?: RunResult) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      if (idleTimer) clearTimeout(idleTimer)
      if (err) reject(err)
      else resolve(result as RunResult)
    }

    const armIdle = () => {
      if (!opts.idleTimeoutMs) return
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        child.kill()
        settle(new Error(`进程 ${Math.round(opts.idleTimeoutMs! / 1000)} 秒没有任何输出，判定卡死: ${command}`))
      }, opts.idleTimeoutMs)
    }

    const feed = (chunk: Buffer, sink: (s: string) => void, prefix = '') => {
      const text = chunk.toString('utf-8')
      sink(text)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) opts.onLine?.(prefix + line)
      }
      armIdle()
    }
    child.stdout?.on('data', (c: Buffer) => feed(c, (s) => (stdout += s)))
    child.stderr?.on('data', (c: Buffer) => feed(c, (s) => (stderr += s), '[stderr] '))

    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill()
        settle(new Error(`进程超时（${Math.round(opts.timeoutMs! / 1000)} 秒）: ${command}`))
      }, opts.timeoutMs)
    }
    armIdle()

    child.on('error', (e) => settle(e))
    child.on('close', (code) => settle(undefined, { code, stdout, stderr }))
  })
}
