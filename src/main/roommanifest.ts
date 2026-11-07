/**
 * 联机 2.0：房间环境清单（B 方向）
 *
 * 目标：房主把「进这服需要哪些 mod」压成一段短码发给好友，好友粘进来就能看到缺什么，
 * 一键补齐。没有中心服务器，清单就在码里。
 *
 * 约定（见 ROADMAP-1.2.0.md B 方向）：
 *  - 码 = `WFMC1:` + base64url(gzip(json))，比裸 JSON 短一个数量级，好复制好发。
 *  - 比对分三段：missing（缺）、mismatch（同名不同内容）、extra（多出来的）。
 *  - **只增不删**：extra 只报告不处理；mismatch 换文件时旧文件挪进 mods/.wfmc-old/，不直接删。
 *  - 下完必须校验 sha1，对不上就丢弃（宁可让用户重试，也不留坏 jar）。
 *  - 超过 500MB 先预告体积，用户确认了才下。
 *  - MC 版本或加载器不一致直接拒绝：这种情况硬补 mod 也进不去服，先换实例更省事。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { store } from './store'
import { gamePathFor } from './paths'
import { buildInstanceManifest, type ModRef, type ServerManifest } from './serversync'
import { downloadFile } from './net'
import type { RoomFixResult, RoomManifestDiff, RoomManifestPayload, RoomModRef } from '../shared/types'

export type { RoomFixResult, RoomManifestDiff, RoomManifestPayload, RoomModRef } from '../shared/types'

export const MANIFEST_PREFIX = 'WFMC1:'
export const CONFIRM_BYTES = 500 * 1024 * 1024
/** 短码里 sha1 保留的字符数（16 hex = 64 bit） */
export const SHA_PREFIX = 16

/** 长短 sha 都能比：want 是几位就比几位 */
function shaMatches(have: string, want: string): boolean {
  if (!want) return false
  return have.slice(0, want.length) === want
}

/** 清单 → 短码 */
export function encodeManifest(payload: RoomManifestPayload): string {
  // sha1 只留前 16 位：40 位十六进制一个 mod 就吃掉 40 个字符，而 64 bit 的碰撞概率
  // 对「同一个 jar 是不是同一个文件」这种判断完全够用。解出来的清单里就是短 sha，
  // 比对时按长度前缀匹配（见 shaMatches），旧的全长码也能照常工作。
  const slim: RoomManifestPayload = {
    ...payload,
    mods: payload.mods.map((m) => ({ ...m, sha1: m.sha1.slice(0, SHA_PREFIX) }))
  }
  const json = JSON.stringify(slim)
  const gz = zlib.gzipSync(Buffer.from(json, 'utf-8'), { level: 9 })
  return MANIFEST_PREFIX + gz.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** 短码 → 清单（认错前缀 / 解压失败都给明确报错，不然用户只看到「解析失败」） */
export function decodeManifest(code: string): RoomManifestPayload {
  const text = code.trim()
  if (!text) throw new Error('清单码是空的')
  if (!text.startsWith(MANIFEST_PREFIX)) throw new Error(`清单码应该以 ${MANIFEST_PREFIX} 开头`)
  const b64 = text.slice(MANIFEST_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  const buf = Buffer.from(b64, 'base64')
  let json: string
  try {
    json = zlib.gunzipSync(buf).toString('utf-8')
  } catch {
    throw new Error('清单码损坏了（解压失败），让房主重新发一次')
  }
  let parsed: RoomManifestPayload
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('清单码内容不是合法 JSON')
  }
  if (!parsed || parsed.v !== 1) throw new Error('清单码版本不认识（可能是新版启动器发的）')
  if (!Array.isArray(parsed.mods)) throw new Error('清单码里没有 mod 列表')
  return parsed
}

/** 从本地实例生成清单 */
export function manifestOfInstance(instanceId: string): RoomManifestPayload {
  const manifest: ServerManifest | undefined = buildInstanceManifest(instanceId)
  if (!manifest) throw new Error('实例不存在')
  const instance = store.getInstance(instanceId)
  return {
    v: 1,
    name: manifest.name,
    mcVersion: manifest.mcVersion,
    loader: manifest.loader,
    loaderVersion: manifest.loaderVersion ?? instance?.loaderVersion,
    gamePort: manifest.gamePort,
    at: manifest.at,
    mods: manifest.mods
  }
}

export type ModMismatch = RoomManifestDiff['mismatch'][number]

/** 比对结果（类型定义在 shared/types.ts，渲染层也用） */
export type ManifestDiff = RoomManifestDiff

function sha1File(file: string): string {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')
}

/** Quilt 客户端能进 Fabric 服，反过来不行；vanilla 房间不要求加载器 */
function needsLoaderRefuse(want: string, have: string): boolean {
  if (!want || want === 'vanilla') return false
  if (want === have) return false
  if (want === 'fabric' && have === 'quilt') return false
  return true
}

/** 读本地实例 mods 目录（按文件名索引） */
export function localModsOf(instanceId: string): Map<string, ModRef> {
  const instance = store.getInstance(instanceId)
  const out = new Map<string, ModRef>()
  if (!instance) return out
  const modsDir = path.join(gamePathFor(instance), 'mods')
  if (!fs.existsSync(modsDir)) return out
  for (const name of fs.readdirSync(modsDir)) {
    // .disabled 的算「没装」：游戏也不会加载它
    if (!name.toLowerCase().endsWith('.jar')) continue
    const full = path.join(modsDir, name)
    try {
      const size = fs.statSync(full).size
      out.set(name, { file: name, sha1: sha1File(full), size })
    } catch {
      /* 读不了就跳过，当成缺 */
    }
  }
  return out
}

/** 三段比对。纯函数（接收本地 mod 表），方便单测 */
export function diffManifest(
  local: Map<string, ModRef>,
  payload: RoomManifestPayload,
  opts?: { mcVersion?: string; loader?: string; loaderVersion?: string }
): ManifestDiff {
  const missing: ModRef[] = []
  const mismatch: ModMismatch[] = []
  const wanted = new Set<string>()

  for (const want of payload.mods) {
    wanted.add(want.file)
    const have = local.get(want.file)
    if (!have) missing.push(want)
    else if (!shaMatches(have.sha1, want.sha1)) mismatch.push({ want, have })
  }
  const extra: ModRef[] = [...local.values()].filter((m) => !wanted.has(m.file))

  const manual: { title: string; reason: string }[] = []
  let refuse: string | undefined
  if (opts?.mcVersion && opts.mcVersion !== payload.mcVersion) {
    refuse = `游戏版本不一样（房间是 ${payload.mcVersion}，你是 ${opts.mcVersion}）——模组补不齐，先建一个 ${payload.mcVersion} 的实例再进`
  } else if (opts?.loader && needsLoaderRefuse(payload.loader, opts.loader)) {
    refuse = `加载器不一样（房间是 ${payload.loader}，你是 ${opts.loader}）——换一个 ${payload.loader} 实例再进`
  } else if (payload.loaderVersion && opts?.loaderVersion && payload.loaderVersion !== opts.loaderVersion) {
    manual.push({
      title: `${payload.loader} 加载器版本不一样（房间是 ${payload.loaderVersion}，你是 ${opts.loaderVersion}）`,
      reason: '加载器版本自动换不了，去「实例设置」里改成房间那个版本，或者让房主确认一下'
    })
  }

  for (const e of extra) {
    manual.push({
      title: `多一个 ${e.file}`,
      reason: '这份 mod 房间那边没有。为了不乱删你的东西，自动补齐不会动它；如果进服报错，手动挪走试试'
    })
  }

  const downloadBytes = [...missing, ...mismatch.map((m) => m.want)].reduce((sum, m) => sum + (m.size || 0), 0)

  return {
    refuse,
    missing,
    mismatch,
    extra,
    manual,
    downloadBytes,
    needsConfirm: downloadBytes > CONFIRM_BYTES,
    env: { mcVersion: payload.mcVersion, loader: payload.loader, loaderVersion: payload.loaderVersion }
  }
}

/** 补齐结果（类型定义在 shared/types.ts） */
export type FixResult = RoomFixResult

/**
 * 按 diff 补齐：只下 missing / mismatch。
 * base 是房主清单服务的地址（http://host:port），文件走 /mods/<名字>。
 * 同名但内容不同的旧文件挪进 mods/.wfmc-old/，不直接删。
 */
export async function applyManifestDiff(
  instanceId: string,
  payload: RoomManifestPayload,
  base: string,
  diff: ManifestDiff,
  onProgress?: (done: number, total: number) => void
): Promise<FixResult> {
  const instance = store.getInstance(instanceId)
  if (!instance) throw new Error('实例不存在')
  if (diff.refuse) throw new Error(diff.refuse)
  const modsDir = path.join(gamePathFor(instance), 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  const oldDir = path.join(modsDir, '.wfmc-old')

  const queue = [...diff.missing, ...diff.mismatch.map((m) => m.want)]
  const total = queue.reduce((s, m) => s + (m.size || 0), 0)
  const result: FixResult = { downloaded: 0, bytes: 0, skipped: 0, errors: [] }
  let done = 0

  for (const ref of queue) {
    const dest = path.join(modsDir, ref.file)
    const tmp = path.join(modsDir, `.wfmc-${ref.file}.part`)
    try {
      await downloadFile(`${base.replace(/\/+$/, '')}/mods/${encodeURIComponent(ref.file)}`, tmp, (d, t) => {
        onProgress?.(done + d, total || t)
      })
      const got = sha1File(tmp)
      if (!shaMatches(got, ref.sha1)) {
        throw new Error('sha1 对不上（下载的文件和清单不一致）')
      }
      if (fs.existsSync(dest)) {
        fs.mkdirSync(oldDir, { recursive: true })
        fs.renameSync(dest, path.join(oldDir, `${ref.file}.${Date.now()}`))
      }
      fs.renameSync(tmp, dest)
      result.downloaded++
      result.bytes += ref.size || 0
      done += ref.size || 0
    } catch (e) {
      result.errors.push({ file: ref.file, message: e instanceof Error ? e.message : String(e) })
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {
        /* 忽略 */
      }
    }
  }
  onProgress?.(total, total)
  return result
}
