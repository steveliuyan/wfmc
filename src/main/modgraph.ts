import fs from 'node:fs'
import { diagnoseMods, depLabel, NOT_A_MOD, type ModMeta } from './moddoctor'
import type { ModGraph, ModGraphEdge, ModGraphNode } from '../shared/types'

export type { ModGraph, ModGraphEdge, ModGraphNode }

/**
 * 模组依赖图：把「谁依赖谁」「谁和谁冲突」「缺了哪个前置」画成一张图。
 *
 * 设计原则（同 `AGENTS.md` §6）：本文件里除 `buildGraph()` 之外全是纯函数，
 * 只吃 `ModMeta[]` 吐数据结构，不碰 electron / 磁盘，方便用 node 直接跑断言。
 */

/** 提供某个 modId 的「来源」（自己的 id、fabric 的 provides、内嵌 jar 都算） */
function buildProviderIndex(mods: ModMeta[]): Map<string, ModMeta[]> {
  const index = new Map<string, ModMeta[]>()
  const add = (id: string | undefined, mod: ModMeta) => {
    if (!id) return
    const k = id.toLowerCase()
    if (!k || NOT_A_MOD.has(k)) return
    const list = index.get(k) ?? []
    if (!list.includes(mod)) list.push(mod)
    index.set(k, list)
  }
  // 真 mod 优先于 provides：同一个 id 两边都有时，先放进去的排在前面
  for (const mod of mods) add(mod.id, mod)
  for (const mod of mods) {
    for (const id of mod.provides ?? []) add(id, mod)
    for (const b of mod.bundled ?? []) {
      add(b.id, mod)
      for (const id of b.provides) add(id, mod)
    }
  }
  return index
}

const ALIAS: Record<string, string> = { fabric: 'fabric-api', 'fabric-api': 'fabric' }

function pickProvider(index: Map<string, ModMeta[]>, depId: string): ModMeta | undefined {
  const key = depId.toLowerCase()
  const direct = index.get(key)
  if (direct && direct.length > 0) {
    // 优先给「没被禁用」的那个：装了但 .disabled 的前置照样会崩，但比完全没装好排查
    return direct.find((m) => !m.disabled) ?? direct[0]
  }
  const alias = ALIAS[key]
  if (alias) {
    const alt = index.get(alias)
    if (alt && alt.length > 0) return alt.find((m) => !m.disabled) ?? alt[0]
  }
  return undefined
}

/**
 * Tarjan 求强连通分量：分量大小 > 1（或自己连自己）就是环。
 * 只用来提示「这几个模组互相依赖，游戏会卡死/加载不出来」，不做别的判断。
 */
export function findCycles(keys: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>()
  for (const k of keys) adj.set(k, [])
  for (const e of edges) {
    const list = adj.get(e.from)
    if (list && adj.has(e.to)) list.push(e.to)
  }
  let idx = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const out: string[][] = []

  const strong = (v: string) => {
    index.set(v, idx)
    low.set(v, idx)
    idx++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      for (;;) {
        const w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
        if (w === v) break
      }
      const selfLoop = comp.length === 1 && (adj.get(comp[0]) ?? []).includes(comp[0])
      if (comp.length > 1 || selfLoop) out.push(comp.reverse())
    }
  }

  for (const k of keys) if (!index.has(k)) strong(k)
  return out
}

/** 纯函数入口：给一批已经解析好的模组元数据，产出依赖图 */
export function buildGraphFromMods(mods: ModMeta[], sizes?: Map<string, number>): ModGraph {
  const index = buildProviderIndex(mods)
  const nodes = new Map<string, ModGraphNode>()

  for (const mod of mods) {
    const key = mod.file
    nodes.set(key, {
      key,
      id: mod.id,
      name: mod.name ?? mod.id ?? mod.file,
      version: mod.version,
      file: mod.file,
      loader: mod.loader,
      bytes: sizes?.get(key) ?? 0,
      disabled: mod.disabled,
      out: 0,
      in: 0
    })
  }

  const edges: ModGraphEdge[] = []
  const seen = new Set<string>()
  const missingMap = new Map<string, { label: string; range?: string; wantedBy: string[] }>()

  const pushEdge = (from: string, to: string, kind: ModGraphEdge['kind']) => {
    const sig = `${from}\u0000${to}\u0000${kind}`
    if (seen.has(sig)) return
    seen.add(sig)
    edges.push({ from, to, kind })
  }

  for (const mod of mods) {
    // 被禁用的模组不产生边：它不参与加载，画上去会让图看起来很乱
    if (mod.disabled) continue
    const from = mod.file
    for (const depId of mod.depends ?? []) {
      const provider = pickProvider(index, depId)
      if (provider) {
        pushEdge(from, provider.file, 'depends')
      } else {
        const key = `missing:${depId}`
        if (!nodes.has(key)) {
          nodes.set(key, {
            key,
            id: depId,
            name: depLabel(depId),
            missing: true,
            bytes: 0,
            out: 0,
            in: 0
          })
        }
        const range = mod.depRanges?.[depId] || undefined
        const prev = missingMap.get(depId)
        if (prev) {
          if (!prev.wantedBy.includes(mod.name ?? mod.file)) prev.wantedBy.push(mod.name ?? mod.file)
          if (!prev.range && range) prev.range = range
        } else {
          missingMap.set(depId, { label: depLabel(depId), range, wantedBy: [mod.name ?? mod.file] })
        }
        pushEdge(from, key, 'missing')
      }
    }
    for (const brk of mod.breaks ?? []) {
      const provider = pickProvider(index, brk)
      if (provider) pushEdge(from, provider.file, 'breaks')
    }
  }

  // 度数：只统计 depends / missing（breaks 是警告，不算入度出度）
  for (const e of edges) {
    if (e.kind === 'breaks') continue
    const a = nodes.get(e.from)
    const b = nodes.get(e.to)
    if (a) a.out++
    if (b) b.in++
  }

  const realKeys = mods.filter((m) => !m.disabled).map((m) => m.file)
  const cycles = findCycles(
    realKeys,
    edges.filter((e) => e.kind === 'depends')
  ).map((keys) => ({
    keys,
    label: keys.map((k) => nodes.get(k)?.name ?? k).join(' → ')
  }))

  const missing = [...missingMap.entries()]
    .map(([id, v]) => ({ id, label: v.label, range: v.range, wantedBy: v.wantedBy }))
    .sort((a, b) => b.wantedBy.length - a.wantedBy.length || a.id.localeCompare(b.id))

  return {
    nodes: [...nodes.values()].sort((a, b) => Number(!!a.missing) - Number(!!b.missing) || b.in - a.in || a.name.localeCompare(b.name)),
    edges,
    cycles,
    missing,
    stats: {
      mods: mods.filter((m) => !m.disabled).length,
      edges: edges.length,
      missingCount: missing.length,
      cycleCount: cycles.length
    }
  }
}

/** 读磁盘上的实例，产出依赖图（薄包装，唯一会碰 fs 的地方） */
export function buildGraph(instanceId: string): ModGraph {
  const { mods } = diagnoseMods(instanceId)
  const sizes = new Map<string, number>()
  for (const mod of mods) {
    try {
      sizes.set(mod.file, fs.statSync(mod.path).size)
    } catch {
      sizes.set(mod.file, 0)
    }
  }
  return buildGraphFromMods(mods, sizes)
}
