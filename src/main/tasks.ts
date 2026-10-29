import { randomUUID } from 'node:crypto'
import { AbortError } from './net'

export type TaskKind = 'install' | 'modpack' | 'resource' | 'server' | 'java' | 'update' | 'mods' | 'misc'
export type TaskStatus = 'running' | 'done' | 'error' | 'canceled'

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
  controller.abort()
  const task = tasks.get(id)
  if (task && task.status === 'running') publish({ ...task, status: 'canceled', finishedAt: Date.now() })
  return true
}

export function clearFinishedTasks(): TaskInfo[] {
  for (const [id, task] of tasks) if (task.status !== 'running') tasks.delete(id)
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

  const task: TaskInfo = { id, kind, title, status: 'running', createdAt: Date.now() }
  publish(task)

  const ctx: TaskContext = {
    id,
    signal: controller.signal,
    report: (patch) => {
      const current = tasks.get(id)
      if (!current) return
      publish({ ...current, ...patch })
    }
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
    controllers.delete(id)
  }
}
