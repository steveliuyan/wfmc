import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BmclApi, Official } from './net'

export interface SpeedResult {
  name: string
  url: string
  ms: number
  ok: boolean
  error?: string
}

/** 测一个小文件的响应时间（同时反映 DNS + TLS + 带宽可用性） */
async function probe(name: string, url: string): Promise<SpeedResult> {
  const start = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, { method: 'GET', signal: controller.signal, headers: { 'User-Agent': 'WFMC/1.0' } })
    clearTimeout(timer)
    // 读一点点就够，别把整个文件拉下来
    const reader = res.body?.getReader()
    if (reader) await reader.read()
    return { name, url, ms: Date.now() - start, ok: res.ok }
  } catch (e) {
    return { name, url, ms: Date.now() - start, ok: false, error: (e as Error)?.message ?? '连接失败' }
  }
}

/**
 * 下载源测速：比较 BMCLAPI 与官方源的响应时间，给出建议。
 * 探测目标用「一字节范围请求」，对服务器压力小。
 */
export async function speedTest(): Promise<{ results: SpeedResult[]; recommend: 'mirror' | 'official' }> {
  const probePath = '/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.pom'
  const results = await Promise.all([
    probe('BMCLAPI 镜像', `${BmclApi.maven}${probePath}`),
    probe('Mojang 官方', `${Official.maven}${probePath}`),
    probe('BMCLAPI 版本清单', BmclApi.versionManifest),
    probe('Mojang 版本清单', Official.versionManifest)
  ])

  const mirrorAvg = average(results.filter((r) => r.name.includes('BMCLAPI')))
  const officialAvg = average(results.filter((r) => r.name.includes('Mojang')))
  return { results, recommend: mirrorAvg <= officialAvg ? 'mirror' : 'official' }
}

function average(list: SpeedResult[]): number {
  if (list.length === 0) return Number.POSITIVE_INFINITY
  // 失败的探测按重罚计，避免「一个通一个不通」被平均成最快
  return list.reduce((sum, r) => sum + (r.ok ? r.ms : 9999), 0) / list.length
}

/** 顺便把临时文件清一清（设置里那个「清理临时文件」用的） */
export function cleanTempFiles(dataDir: string): { removed: number; freed: number } {
  const targets = [path.join(dataDir, 'temp'), path.join(dataDir, 'exports')]
  let removed = 0
  let freed = 0
  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      try {
        const stat = fs.statSync(full)
        if (stat.isFile() && stat.mtimeMs < Date.now() - 3 * 24 * 3600 * 1000) {
          freed += stat.size
          fs.rmSync(full, { force: true })
          removed++
        }
      } catch {
        /* 跳过 */
      }
    }
  }
  // 顺手清掉半截下载
  const tmpRoot = path.join(dataDir, 'instances')
  if (fs.existsSync(tmpRoot)) {
    for (const inst of fs.readdirSync(tmpRoot)) {
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return
        for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, name.name)
          if (name.isDirectory()) walk(full)
          else if (name.name.endsWith('.part')) {
            try {
              freed += fs.statSync(full).size
              fs.rmSync(full, { force: true })
              removed++
            } catch {
              /* 跳过 */
            }
          }
        }
      }
      walk(path.join(tmpRoot, inst))
    }
  }
  return { removed, freed }
}

export const tmpDir = os.tmpdir
