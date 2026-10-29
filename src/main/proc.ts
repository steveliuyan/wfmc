import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 跑一个外部进程，实时把输出喂给 onLine，失败时带上输出 */
export function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; onLine?: (line: string) => void; timeoutMs?: number } = {}
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''

    const feed = (chunk: Buffer, sink: (s: string) => void, prefix = '') => {
      const text = chunk.toString('utf-8')
      sink(text)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) opts.onLine?.(prefix + line)
      }
    }
    child.stdout?.on('data', (c: Buffer) => feed(c, (s) => (stdout += s)))
    child.stderr?.on('data', (c: Buffer) => feed(c, (s) => (stderr += s), '[stderr] '))

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill()
          reject(new Error(`进程超时: ${command}`))
        }, opts.timeoutMs)
      : undefined

    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}
