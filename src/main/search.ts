import fs from 'fs'
import path from 'path'
import { listServers } from './servers'
import { store } from './store'
import type { Instance, LoaderType, SearchHit } from '../shared/types'

/**
 * Ctrl+K 全局搜索的本地索引。
 *
 * 设计取舍：
 * - 只读目录树、只看文件名，**不解析 jar**（解析要读 zip，几百个 mod 会卡住主进程）；
 *   想按「模组显示名」搜，进内容管理页用那边的搜索。
 * - 全部同步读，但每个目录只 readdir 一次，几千个文件也就几毫秒。
 * - 排序：完全相等 > 前缀 > 包含 > 子序列（`mcf` 能命中 `moon create factory`）。
 */

const LOADER_LABEL: Record<LoaderType, string> = {
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  legacyfabric: 'Legacy Fabric',
  cleanroom: 'Cleanroom'
}

const CONTENT_SPECS: {
  kind: 'mods' | 'resourcepacks' | 'shaderpacks' | 'saves'
  group: SearchHit['group']
  /** 存档是目录，其余是文件 */
  dir: boolean
}[] = [
  { kind: 'mods', group: '模组', dir: false },
  { kind: 'resourcepacks', group: '资源包', dir: false },
  { kind: 'shaderpacks', group: '光影', dir: false },
  { kind: 'saves', group: '存档', dir: true }
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.·]+/g, '')
}

/** 子序列匹配：q 的字符按顺序出现在 t 里就算命中 */
function subsequence(q: string, t: string): boolean {
  let i = 0
  for (const ch of t) {
    if (ch === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

export function matchScore(query: string, ...fields: (string | undefined)[]): number {
  const nq = normalize(query)
  if (!nq) return 0
  let best = 0
  for (const f of fields) {
    if (!f) continue
    const nf = normalize(f)
    if (!nf) continue
    if (nf === nq) best = Math.max(best, 100)
    else if (nf.startsWith(nq)) best = Math.max(best, 80)
    else if (nf.includes(nq)) best = Math.max(best, 60)
    else if (nq.length >= 2 && subsequence(nq, nf)) best = Math.max(best, 20)
  }
  return best
}

function sizeText(n: number): string {
  if (n < 0) return '文件夹'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

function displayName(file: string): string {
  return file.replace(/\.disabled$/i, '').replace(/\.(jar|zip)$/i, '')
}

/** 扫一个实例的四个内容目录，命中就带上实例信息和 tab */
function scanInstance(instance: Instance, query: string): { score: number; hit: SearchHit }[] {
  const out: { score: number; hit: SearchHit }[] = []
  const base = store.instanceGameDir(instance.id)

  for (const spec of CONTENT_SPECS) {
    const dir = path.join(base, spec.kind)
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const raw of names) {
      const title = displayName(raw)
      const s = matchScore(query, title)
      if (!s) continue
      let size = -1
      try {
        const st = fs.statSync(path.join(dir, raw))
        if (spec.dir !== st.isDirectory()) continue
        size = st.isDirectory() ? -1 : st.size
      } catch {
        continue
      }
      out.push({
        // 模组命中比资源包/存档更常见，同分时排前面
        score: s + (spec.kind === 'mods' ? 3 : 0),
        hit: {
          group: spec.group,
          title,
          subtitle: `${instance.name} · ${sizeText(size)}`,
          page: 'manage',
          instanceId: instance.id,
          tab: spec.kind
        }
      })
    }
  }
  return out
}

/**
 * 本地搜索：实例 / 当前实例的模组·资源包·光影·存档 / 收藏的服务器。
 * 页面、动作、设置项那些「静态入口」由渲染层自己拼，不走 IPC。
 */
export function searchLocal(query: string, instanceId?: string, limit = 24): SearchHit[] {
  const q = query.trim()
  if (!q) return []

  const hits: { score: number; hit: SearchHit }[] = []
  const instances = store.listInstances()

  for (const ins of instances) {
    const s = matchScore(q, ins.name, ins.mcVersion, ins.loader)
    if (!s) continue
    hits.push({
      score: s + 10,
      hit: {
        group: '实例',
        title: ins.name,
        subtitle: `${ins.mcVersion} · ${LOADER_LABEL[ins.loader] ?? ins.loader}`,
        page: 'home',
        instanceId: ins.id
      }
    })
  }

  const active = instanceId ? instances.find((i) => i.id === instanceId) : undefined
  if (active) hits.push(...scanInstance(active, q))

  for (const srv of listServers()) {
    const s = matchScore(q, srv.name, srv.address, srv.note)
    if (!s) continue
    hits.push({
      score: s,
      hit: {
        group: '服务器',
        title: srv.name || srv.address,
        subtitle: `${srv.address}:${srv.port ?? 25565}`,
        page: 'servers'
      }
    })
  }

  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.hit)
}
