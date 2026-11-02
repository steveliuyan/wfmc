import { randomUUID } from 'node:crypto'
import { AbortError } from './net'
import { createGate, setPaused, waitIfPaused } from './pause'

export type TaskKind = 'install' | 'modpack' | 'resource' | 'server' | 'java' | 'update' | 'mods' | 'misc'
export type TaskStatus = 'running' | 'paused' | 'done' | 'error' | 'canceled'

export interface TaskInfo {
  id: string
  kind: TaskKind
  title: string
  status: TaskStatus
  phase?: string
  current?: number
  total?: number
  detail?: string
  error?: string
  createdAt: number
  finishedAt?: number
}

export interface TaskContext {
  id: string
  signal: AbortSignal
  /** 更新阶段与进度（同时会推给渲染层） */
  report: (patch: { phase?: string; current?: number; total?: number; detail?: string }) => void
  /**
   * 暂停检查点：任务被暂停时在这里停住，恢复后接着往下跑；被取消时立刻返回，由 signal 负责抛 AbortError。
   * 下载走 `downloadAll` / `downloadFile` 的路径已经自动停在文件边界，不用手写；
   * 自己写的长循环（逐个解压、逐个装模组之类）记得在循环里 `await ctx.checkpoint()`。
   */
  checkpoint: () => Promise<void>
}

type Emit = (task: TaskInfo) => void

const tasks = new Map<string, TaskInfo>()
const controllers = new Map<string, AbortController>()
let emit: Emit = () => undefined

export function setTaskEmitter(fn: Emit) {
  emit = fn
}

function publish(task: TaskInfo) {
  tasks.set(task.id, task)
  try {
    emit(task)
  } catch {
    /* 窗口可能已关闭 */
  }
}

export function listTasks(): TaskInfo[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
}

export function cancelTask(id: string): boolean {
  const controller = controllers.get(id)
  if (!controller) return false
  // 先解除暂停：否则任务停在第 20 行等闸门，abort 之后还得等闸门 flush 才看得到取消
  setPaused(controller.signal, false)
  controller.abort()
  const task = tasks.get(id)
  if (task && (task.status === 'running' || task.status === 'paused')) {
    publish({ ...task, status: 'canceled', finishedAt: Date.now() })
  }
  return true
}

/** 暂停：任务停在下一个检查点，已下的文件不重下 */
export function pauseTask(id: string): boolean {
  const controller = controllers.get(id)
  const task = tasks.get(id)
  if (!controller || !task || task.status !== 'running') return false
  if (!setPaused(controller.signal, true)) return false
  publish({ ...task, status: 'paused' })
  return true
}

/** 继续：放闸门，任务从停下的地方接着跑 */
export function resumeTask(id: string): boolean {
  const controller = controllers.get(id)
  const task = tasks.get(id)
  if (!controller || !task || task.status !== 'paused') return false
  setPaused(controller.signal, false)
  publish({ ...task, status: 'running' })
  return true
}

export function clearFinishedTasks(): TaskInfo[] {
  // 暂停中的不能当"已完成"清掉：它还在内存里跑着呢
  for (const [id, task] of tasks) if (task.status !== 'running' && task.status !== 'paused') tasks.delete(id)
  return listTasks()
}

/**
 * 跑一个后台任务：注册 → 执行 → 记录结果。
 * 传进来的 fn 通过 ctx 更新进度，取消靠 ctx.signal（下载器已经认这个 signal）。
 */
export async function runTask<T>(
  kind: TaskKind,
  title: string,
  fn: (ctx: TaskContext) => Promise<T>
): Promise<T> {
  const id = randomUUID()
  const controller = new AbortController()
  controllers.set(id, controller)
  createGate(controller.signal)

  const task: TaskInfo = { id, kind, title, status: 'running', createdAt: Date.now() }
  publish(task)

  const ctx: TaskContext = {
    id,
    signal: controller.signal,
    report: (patch) => {
      const current = tasks.get(id)
      if (!current) return
      publish({ ...current, ...patch })
    },
    checkpoint: () => waitIfPaused(controller.signal)
  }

  try {
    const result = await fn(ctx)
    publish({ ...(tasks.get(id) as TaskInfo), status: 'done', finishedAt: Date.now() })
    return result
  } catch (e) {
    const aborted = e instanceof AbortError || controller.signal.aborted
    publish({
      ...(tasks.get(id) as TaskInfo),
      status: aborted ? 'canceled' : 'error',
      error: aborted ? '已取消' : (e as Error)?.message ?? String(e),
      finishedAt: Date.now()
    })
    throw e
  } finally {
    // 兜底放闸门：万一任务在暂停状态下直接结束，别把等待者挂在那儿
    setPaused(controller.signal, false)
    controllers.delete(id)
  }
}
