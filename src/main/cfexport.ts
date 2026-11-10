import fs from 'node:fs'
import path from 'node:path'
import type { ProgressFn } from '../shared/types'
import { store } from './store'
import { gamePathFor } from './paths'
import { collectDirFiles, writeZip } from './zip'
import { fetchJson } from './net'

/**
 * 导出成 CurseForge 整合包（zip）：
 *
 * 结构跟 mrpack 完全不同：
 *   manifest.json   —— 只写「MC 版本 + 加载器 + 文件清单（projectID/fileID）」
 *   overrides/      —— 其余所有东西（config、脚本、识别不出来的 jar…）
 *
 * 关键在于「识别 jar」：CF 不看文件名也不看 sha1，它认自己那套 fingerprint
 * （"Normalized" MurmurHash2：先剔除文里的空白字节 9/10/13/32，再用种子 1
 * 算 32 位无符号数，长度取剔除后的字节数）。识别出来的写进
 * manifest 的 files 数组，包体就只有几十 KB；识别不出来的只能塞 overrides，
 * 包体就等于那几个 jar 的大小。所以有 key 和没 key 差别很大。
 */

const CF_BASE = 'https://api.curseforge.com/v1'
/** CF 官方没写批量上限，200 一批实测稳（返回体也小） */
const FP_BATCH = 200

/** MurmurHash2（32 位）。CF 的 fingerprint 算法就是它，种子固定 1 */
export function murmur2(buf: Buffer, seed = 1): number {
  const m = 0x5bd1e995
  const r = 24
  const len = buf.length
  let h = (seed ^ len) >>> 0

  const len4 = len >>> 2
  for (let i = 0; i < len4; i++) {
    const i4 = i << 2
    let k = (buf[i4] | (buf[i4 + 1] << 8) | (buf[i4 + 2] << 16) | (buf[i4 + 3] << 24)) >>> 0
    k = Math.imul(k, m) >>> 0
    k ^= k >>> r
    k = Math.imul(k, m) >>> 0
    h = Math.imul(h, m) >>> 0
    h ^= k
  }

  switch (len & 3) {
    case 3:
      h ^= (buf[(len & ~3) + 2] & 0xff) << 16
    // falls through
    case 2:
      h ^= (buf[(len & ~3) + 1] & 0xff) << 8
    // falls through
    case 1:
      h ^= buf[len & ~3] & 0xff
      h = Math.imul(h, m) >>> 0
  }

  h ^= h >>> 13
  h = Math.imul(h, m) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

/**
 * CF 的指纹是「归一化」后的 murmur2：先剔除空白字节（\t \n \r 空格）。
 * 这样模组作者改个换行/缩进，CF 依然认得出来。
 * 实测（jar 与 CF fileFingerprint 对齐）：0World2Create→1211594411、jei→3077103837。
 */
export function cfNormalize(buf: Buffer): Buffer {
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 9 || b === 10 || b === 13 || b === 32) continue
    n++
  }
  if (n === buf.length) return buf
  const out = Buffer.allocUnsafe(n)
  let j = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 9 || b === 10 || b === 13 || b === 32) continue
    out[j++] = b
  }
  return out
}

/** 对一个 buffer 直接算 CF fingerprint（先归一化再 murmur2） */
export function cfFingerprint(buf: Buffer): number {
  return murmur2(cfNormalize(buf))
}

/** 单个文件的 CF fingerprint */
export function fingerprintOf(file: string): number {
  return cfFingerprint(fs.readFileSync(file))
}

interface CfFile {
  id: number
  modId: number
  fileName?: string
  displayName?: string
}

interface CfMatch {
  id?: number
  file?: CfFile
}

interface CfFingerprintResp {
  data?: {
    exactMatches?: CfMatch[]
    exactFingerprints?: number[]
    unmatchedFingerprints?: number[]
    installedFingerprints?: number[]
  }
}

export interface CfExportResult {
  /** 生成的 zip 路径 */
  path: string
  /** 认出来、写进 manifest 的 mod 数 */
  matched: number
  /** 认不出来、塞进 overrides 的 mod 数 */
  unmatched: number
  /** 有没有用 key（没用的话 matched 必然是 0） */
  usedKey: boolean
}

function apiKey(): string {
  return store.settings.curseforgeApiKey?.trim() ?? ''
}

/**
 * 把 jar 列表逐批交给 CF 认领。
 *
 * 坑：/v1/fingerprints 的 exactMatches[] 里**不带 fingerprint 字段**（只有 file 本身），
 * 光看它没法知道哪一条对应哪个 jar。但响应的 `exactFingerprints[]` 与 exactMatches[]
 * **按下标一一对应**（实测 120/120 命中、顺序一致），拿它当 key 就能可靠对位。
 * 万一哪天真不带 exactFingerprints，只在「返回条数 == 提交条数」时才敢按序对位，
 * 否则退回一个文件一问 —— 错位会把别人的 projectID 写进 manifest，装包时下错 mod。
 */
async function resolveJars(
  jars: string[],
  signal?: AbortSignal
): Promise<{ matched: Map<string, CfFile>; unmatched: string[] }> {
  const matched = new Map<string, CfFile>()
  const unmatched: string[] = []
  const key = apiKey()
  if (!key) return { matched, unmatched: jars.slice() }

  /** 返回 fingerprint → file 的映射 */
  const ask = async (fps: number[]): Promise<Map<number, CfFile>> => {
    const resp = await fetchJson<CfFingerprintResp>(`${CF_BASE}/fingerprints`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ fingerprints: fps }),
      signal
    })
    const data = resp.data ?? {}
    const hits = data.exactMatches ?? []
    const hitFps = data.exactFingerprints ?? []
    const map = new Map<number, CfFile>()
    if (hitFps.length === hits.length && hits.length > 0) {
      hits.forEach((h, i) => {
        const f = h?.file
        if (f?.modId) map.set(hitFps[i], f)
      })
    } else if (hits.length === fps.length) {
      hits.forEach((h, i) => {
        const f = h?.file
        if (f?.modId) map.set(fps[i], f)
      })
    }
    return map
  }

  const withFp = jars.map((j) => ({ jar: j, fp: fingerprintOf(j) }))

  for (let i = 0; i < withFp.length; i += FP_BATCH) {
    const batch = withFp.slice(i, i + FP_BATCH)
    const got = await ask(batch.map((b) => b.fp))
    for (const b of batch) {
      const f = got.get(b.fp)
      if (f) matched.set(b.jar, f)
      else unmatched.push(b.jar)
    }
  }
  return { matched, unmatched }
}

/** CF 要求加载器写成 `fabric-0.15.11` / `forge-47.2.0` 这种 */
function loaderId(loader: string, version?: string): string | undefined {
  if (!version) return undefined
  if (loader === 'fabric') return `fabric-${version}`
  if (loader === 'quilt') return `quilt-${version}`
  if (loader === 'neoforge') return `neoforge-${version}`
  if (loader === 'forge') return `forge-${version}`
  return undefined
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'instance'
}

/** 只搬这些目录进 overrides —— saves/logs/screenshots 属于玩家自己的东西，不往外带 */
const OVERRIDE_FOLDERS = ['config', 'defaultconfigs', 'scripts', 'resourcepacks', 'shaderpacks', 'kubejs']

export async function exportInstanceAsCurseforgeZip(
  instanceId: string,
  onProgress?: ProgressFn,
  signal?: AbortSignal
): Promise<CfExportResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  const gameDir = gamePathFor(instance)
  const key = 'cf-export'
  const usedKey = !!apiKey()

  const modsDir = path.join(gameDir, 'mods')
  const jars = fs.existsSync(modsDir)
    ? fs
        .readdirSync(modsDir)
        .filter((n) => n.toLowerCase().endsWith('.jar'))
        .map((n) => path.join(modsDir, n))
    : []

  onProgress?.({ key, phase: `识别 ${jars.length} 个 mod 的 CurseForge 来源`, current: 0, total: jars.length || 1 })
  const { matched, unmatched } = await resolveJars(jars, signal)
  onProgress?.({
    key,
    phase: `识别完成：${matched.size} 个对上 CurseForge，${unmatched.length} 个进 overrides`,
    current: jars.length,
    total: jars.length || 1
  })

  // manifest.json
  const files = [...matched.values()].map((f) => ({ projectID: f.modId, fileID: f.id, required: true }))
  const lid = loaderId(instance.loader, instance.loaderVersion)
  const manifest = {
    minecraft: {
      version: instance.mcVersion,
      modLoaders: lid ? [{ id: lid, primary: true }] : []
    },
    manifestType: 'minecraftModpack',
    manifestVersion: 1,
    name: instance.name,
    version: '1.0.0',
    author: 'WFMC',
    files,
    overrides: 'overrides'
  }

  // overrides
  const overrides: { name: string; full: string }[] = []
  for (const jar of unmatched) overrides.push({ name: `overrides/mods/${path.basename(jar)}`, full: jar })
  for (const folder of OVERRIDE_FOLDERS) {
    const dir = path.join(gameDir, folder)
    if (!fs.existsSync(dir)) continue
    for (const f of collectDirFiles(dir)) overrides.push({ name: `overrides/${folder}/${f.name}`, full: f.full })
  }
  for (const single of ['options.txt', 'servers.dat']) {
    const f = path.join(gameDir, single)
    if (fs.existsSync(f)) overrides.push({ name: `overrides/${single}`, full: f })
  }

  // 临时落 manifest（writeZip 只吃磁盘文件）
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/[/:\s]/g, '-')
  const tempDir = path.join(store.dataDir, 'temp', `cfzip-${stamp}`)
  fs.mkdirSync(tempDir, { recursive: true })
  const manifestPath = path.join(tempDir, 'manifest.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

  const out = path.join(store.exportsDir, `${safeName(instance.name)}-${instance.mcVersion}-${stamp}-cf.zip`)
  fs.mkdirSync(store.exportsDir, { recursive: true })

  onProgress?.({ key, phase: `打包 ${overrides.length + 1} 个文件`, current: 0, total: overrides.length + 1 })
  writeZip(out, [{ name: 'manifest.json', full: manifestPath }, ...overrides])
  fs.rmSync(tempDir, { recursive: true, force: true })
  onProgress?.({ key, phase: `导出完成：${out}`, current: 1, total: 1 })

  return { path: out, matched: matched.size, unmatched: unmatched.length, usedKey }
}

/** 给界面用的「这个实例能不能导出成纯净 CF 包」预检：不联网，只看有没有 key 和 mod 数 */
export function cfExportReady(instanceId: string): { hasKey: boolean; mods: number } {
  const instance = store.getInstance(instanceId)
  if (!instance) return { hasKey: !!apiKey(), mods: 0 }
  const modsDir = path.join(gamePathFor(instance), 'mods')
  const mods = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((n) => n.toLowerCase().endsWith('.jar')).length : 0
  return { hasKey: !!apiKey(), mods }
}
