/**
 * 任务「暂停 / 继续」闸门。
 *
 * 为什么不复用 AbortSignal：取消和暂停语义不同 —— 取消要抛 AbortError 一路退出、
 * 半截文件该删就删；暂停只是把工作停在原地，恢复后必须原样接着跑，一个字节都不能重下。
 * 所以单独一个 gate，挂在 AbortSignal 对象上（下载器只认 signal，拿它当 key 最省改造）。
 *
 * 注意：gate 只在 `runTask` 创建的任务信号上存在；别的地方（比如不进任务队列的即时下载）
 * 查不到 gate 就直接放行，行为和不加暂停完全一样。
 */

interface Gate {
  paused: boolean
  waiters: Set<() => void>
}

const gates = new WeakMap<AbortSignal, Gate>()

/** 为一个任务信号建闸门；signal 被 abort 时把所有等待者放出来（外层 checkAbort 会抛 AbortError） */
export function createGate(signal: AbortSignal): void {
  const gate: Gate = { paused: false, waiters: new Set() }
  gates.set(signal, gate)
  signal.addEventListener('abort', () => flush(gate), { once: true })
}

function flush(gate: Gate) {
  const list = [...gate.waiters]
  gate.waiters.clear()
  for (const fn of list) fn()
}

/** 返回 false 表示这个信号没有闸门（不是任务队列里的活儿） */
export function setPaused(signal: AbortSignal | undefined, paused: boolean): boolean {
  const gate = signal ? gates.get(signal) : undefined
  if (!gate) return false
  gate.paused = paused
  if (!paused) flush(gate)
  return true
}

export function isPaused(signal?: AbortSignal): boolean {
  return !!signal && gates.get(signal)?.paused === true
}

/**
 * 暂停中就停在这里等。signal 被 abort 时立刻返回（后面的 checkAbort 会抛）。
 *
 * onTick：等待期间每秒调一次。**必须给下载器传 guard.kick**，
 * 否则暂停超过 45 秒，卡住判定（IDLE_TIMEOUT_MS）会把这条连接当断流掐掉，恢复后直接失败。
 */
export async function waitIfPaused(signal?: AbortSignal, onTick?: () => void): Promise<void> {
  const gate = signal ? gates.get(signal) : undefined
  if (!gate || !gate.paused || signal!.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => onTick?.(), 1000)
    timer.unref?.()
    const done = () => {
      clearInterval(timer)
      gate.waiters.delete(done)
      resolve()
    }
    gate.waiters.add(done)
  })
}
