import { randomUUID } from 'node:crypto'
import { AbortError } from './net'
import { createGate, setPaused, waitIfPaused } from './pause'
import { setDownloadersPausedBySignal } from './fastdl'

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
  /** 父任务 id：有值说明这是某个任务拆出来的子任务（任务树） */
  parentId?: string
  /** 父任务用：一共几个子任务 / 已完成几个（由子任务聚合出来） */
  childTotal?: number
  childDone?: number
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
  /**
   * 拆一个子任务出来跑。
   *
   * - 子任务显示在父任务下面，父任务进度按子任务聚合；
   * - 取消父任务会连带取消所有子任务；暂停 / 继续同理（整棵树一起停、一起跑）；
   * - 子任务抛错不会自动中断父任务，要不要中断由父任务自己决定。
   */
  spawn: <T>(kind: TaskKind, title: string, fn: (ctx: TaskContext) => Promise<T>) => Promise<T>
}

type Emit = (task: TaskInfo) => void

const tasks = new Map<string, TaskInfo>()
const controllers = new Map<string, AbortController>()
/** 父任务 id → 子任务 id 集合（顺序即创建顺序） */
const childrenOf = new Map<string, Set<string>>()
/** 聚合的重入保护：rollUp 里 publish 父任务时别回头再聚一次自己 */
const rollingUp = new Set<string>()
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
  if (task.parentId) rollUp(task.parentId)
}

export function listTasks(): TaskInfo[] {
  return [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
}

/** 所有后代（隔代也算） */
function descendants(id: string): string[] {
  const out: string[] = []
  const stack = [...(childrenOf.get(id) ?? [])]
  while (stack.length) {
    const cur = stack.pop() as string
    out.push(cur)
    for (const g of childrenOf.get(cur) ?? []) stack.push(g)
  }
  return out
}

/** 把子任务的进度 / 完成数汇总到父任务上 */
function rollUp(parentId: string) {
  if (rollingUp.has(parentId)) return
  const parent = tasks.get(parentId)
  const ids = [...(childrenOf.get(parentId) ?? [])]
  if (!parent || ids.length === 0) return
  const kids = ids.map((id) => tasks.get(id)).filter((t): t is TaskInfo => !!t)
  if (!kids.length) return

  rollingUp.add(parentId)
  try {
    const done = kids.filter((k) => k.status === 'done').length

    // 进度：有 total 的子任务按实际大小加权，没 total 的每个算 1 份
    let current = 0
    let total = 0
    for (const k of kids) {
      const kt = k.total ?? 0
      if (kt > 0) {
        total += kt
        current += Math.min(k.current ?? 0, kt)
      } else {
        total += 1
        if (k.status === 'done') current += 1
      }
    }

    // 阶段文字跟着"正在跑的那个子任务"走，比父任务自己报的空 phase 有用
    const active = kids.find((k) => k.status === 'running') ?? kids.find((k) => k.status === 'paused')
    const phase = active ? `${active.title}${active.phase ? ' · ' + active.phase : ''}` : parent.phase

    // 子任务全停了，父任务也显示成"已暂停"，别让用户以为它还在跑
    let status: TaskStatus = parent.status
    if (parent.status === 'running') {
      if (kids.some((k) => k.status === 'running')) status = 'running'
      else if (kids.some((k) => k.status === 'paused')) status = 'paused'
    }

    publish({
      ...parent,
      status,
      phase,
      current,
      total,
      detail: `${done}/${kids.length}`,
      childTotal: kids.length,
      childDone: done
    })
  } finally {
    rollingUp.delete(parentId)
  }
}

export function cancelTask(id: string): boolean {
  const controller = controllers.get(id)
  if (!controller) return false
  // 先解除暂停：否则任务停在第 20 行等闸门，abort 之后还得等闸门 flush 才看得到取消
  setPaused(controller.signal, false)
  setDownloadersPausedBySignal(controller.signal, false)
  controller.abort()
  const task = tasks.get(id)
  if (task && (task.status === 'running' || task.status === 'paused')) {
    publish({ ...task, status: 'canceled', finishedAt: Date.now() })
  }
  // 子任务跟着一起收掉
  for (const cid of descendants(id)) {
    const c = controllers.get(cid)
    if (!c) continue
    setPaused(c.signal, false)
    setDownloadersPausedBySignal(c.signal, false)
    c.abort()
  }
  return true
}

/** 暂停：任务停在下一个检查点，已下的文件不重下（整棵任务树一起停） */
export function pauseTask(id: string): boolean {
  const controller = controllers.get(id)
  const task = tasks.get(id)
  if (!controller || !task || task.status !== 'running') return false
  if (!setPaused(controller.signal, true)) return false
  setDownloadersPausedBySignal(controller.signal, true)
  publish({ ...task, status: 'paused' })
  for (const cid of descendants(id)) {
    const c = controllers.get(cid)
    if (!c) continue
    if (setPaused(c.signal, true)) {
      setDownloadersPausedBySignal(c.signal, true)
      const ct = tasks.get(cid)
      if (ct && ct.status === 'running') publish({ ...ct, status: 'paused' })
    }
  }
  return true
}

/** 继续：放闸门，任务从停下的地方接着跑（整棵任务树一起跑） */
export function resumeTask(id: string): boolean {
  const controller = controllers.get(id)
  const task = tasks.get(id)
  if (!controller || !task || task.status !== 'paused') return false
  setPaused(controller.signal, false)
  setDownloadersPausedBySignal(controller.signal, false)
  publish({ ...task, status: 'running' })
  for (const cid of descendants(id)) {
    const c = controllers.get(cid)
    if (!c) continue
    setPaused(c.signal, false)
    setDownloadersPausedBySignal(c.signal, false)
    const ct = tasks.get(cid)
    if (ct && ct.status === 'paused') publish({ ...ct, status: 'running' })
  }
  return true
}

/** 反查：这个 signal 属于哪个任务（下载面板的暂停/继续/取消要同步到任务树） */
export function findTaskIdBySignal(signal?: AbortSignal): string | undefined {
  if (!signal) return undefined
  for (const [id, c] of controllers) if (c.signal === signal) return id
  return undefined
}

export function clearFinishedTasks(): TaskInfo[] {
  // 暂停中的不能当"已完成"清掉：它还在内存里跑着呢
  const active = new Set<string>()
  for (const t of tasks.values()) if (t.status === 'running' || t.status === 'paused') active.add(t.id)

  for (const [id, task] of [...tasks]) {
    if (task.status === 'running' || task.status === 'paused') continue
    // 父任务还在跑：子任务的记录留着给聚合和面板用
    if (task.parentId && active.has(task.parentId)) continue
    tasks.delete(id)
    childrenOf.get(task.parentId ?? '')?.delete(id)
    const grandKids = childrenOf.get(id)
    if (grandKids) {
      for (const cid of grandKids) tasks.delete(cid)
      childrenOf.delete(id)
    }
  }
  return listTasks()
}

export interface RunTaskOptions {
  /** 挂到哪个父任务下面（ctx.spawn 自动传） */
  parentId?: string
}

/**
 * 跑一个后台任务：注册 → 执行 → 记录结果。
 * 传进来的 fn 通过 ctx 更新进度，取消靠 ctx.signal（下载器已经认这个 signal）。
 */
export async function runTask<T>(
  kind: TaskKind,
  title: string,
  fn: (ctx: TaskContext) => Promise<T>,
  opts: RunTaskOptions = {}
): Promise<T> {
  const id = randomUUID()
  const controller = new AbortController()
  controllers.set(id, controller)
  createGate(controller.signal)

  const parentId = opts.parentId
  if (parentId) {
    const set = childrenOf.get(parentId) ?? new Set<string>()
    set.add(id)
    childrenOf.set(parentId, set)
    // 父任务被取消时子任务必须跟着死，否则父任务报"已取消"子任务还在后台跑
    const pc = controllers.get(parentId)
    if (pc) {
      if (pc.signal.aborted) controller.abort()
      else pc.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }

  const task: TaskInfo = { id, kind, title, status: 'running', createdAt: Date.now(), parentId }
  publish(task)

  const ctx: TaskContext = {
    id,
    signal: controller.signal,
    report: (patch) => {
      const current = tasks.get(id)
      if (!current) return
      publish({ ...current, ...patch })
    },
    checkpoint: () => waitIfPaused(controller.signal),
    spawn: <R>(k: TaskKind, t: string, f: (c: TaskContext) => Promise<R>) => runTask(k, t, f, { parentId: id })
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
