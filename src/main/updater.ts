import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ProgressFn } from '../shared/types'
import { applyDelta, readDeltaHeader } from './delta'
import { logError } from './errlog'
import { store } from './store'
import { downloadFile, fetchJson } from './net'

/**
 * 自动更新（自托管 update.json 方案，免账号免 token）：
 * settings.updateUrl 指向一个 JSON：
 * { "version": "1.1.0", "url": "https://.../WFMC-1.1.0.exe", "notes": "更新说明" }
 * 也可以放 GitHub Releases 的直链。
 */

export interface UpdateInfo {
  current: string
  latest?: string
  url?: string
  notes?: string
  hasUpdate: boolean
  error?: string
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0)
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export async function checkUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion()
  const url = store.settings.updateUrl?.trim()
  if (!url) return { current, hasUpdate: false, error: '还没有配置更新源（设置里填 update.json 地址）' }
  try {
    const meta = await fetchJson<{ version: string; url?: string; notes?: string }>(url)
    const hasUpdate = !!meta.version && compareVersion(current, meta.version) > 0
    store.setSettings({ lastUpdateCheck: Date.now() })
    return { current, latest: meta.version, url: meta.url, notes: meta.notes, hasUpdate }
  } catch (e) {
    return { current, hasUpdate: false, error: `检查更新失败：${(e as Error).message}` }
  }
}

/** 当前用户实际启动的那个 exe（便携版会解压到临时目录运行，这里取原始文件） */
function targetExecutable(): string {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  if (portable && fs.existsSync(portable)) return portable
  return process.execPath
}

/** github.com 直链在部分网络下打不开，自动改走镜像 */
function mirrorCandidates(url: string): string[] {
  if (!/^https?:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(url)) return [url]
  return [url, `https://gh-proxy.com/${url}`, `https://ghfast.top/${url}`]
}

/** 依次试 直连 → 镜像，成功返回；失败抛最后一个错误 */
async function downloadWithMirrors(
  url: string,
  dest: string,
  phase: string,
  onProgress?: ProgressFn
): Promise<void> {
  const candidates = mirrorCandidates(url)
  let lastErr: unknown
  for (let i = 0; i < candidates.length; i++) {
    try {
      onProgress?.({
        key: 'update',
        phase: i === 0 ? phase : `直连失败，改走镜像 ${i}`,
        current: 0,
        total: 1
      })
      await downloadFile(
        candidates[i],
        dest,
        (cur, total) => onProgress?.({ key: 'update', phase, current: cur, total }),
        { skipIfExists: false }
      )
      return
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`下载失败：${(lastErr as Error)?.message ?? '网络不通'}`)
}

/** 更新前先把「记录」抄一份到安装目录外面：万一安装包把数据清掉，账号/设置还能捞回来 */
function backupRecords(): void {
  try {
    const dir = path.join(app.getPath('appData'), 'WFMC', 'update-backup')
    fs.mkdirSync(dir, { recursive: true })
    for (const f of [store.settingsFile, store.accountsFile]) {
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)))
    }
  } catch {
    /* 备份失败不影响更新 */
  }
}

/** 下载新包 → 写一个替换脚本 → 退出并重启 */
export async function applyUpdate(url: string, onProgress?: ProgressFn): Promise<string> {
  const exe = targetExecutable()
  const tmp = path.join(os.tmpdir(), `wfmc-update-${Date.now()}.exe`)
  await downloadWithMirrors(url, tmp, '下载新版本', onProgress)
  onProgress?.({ key: 'update', phase: '准备替换文件', current: 1, total: 1 })

  backupRecords()

  // 安装版：**下载下来的是安装包，直接运行它**，不要拿安装包去覆盖 WFMC.exe。
  // （以前是 move /y setup.exe → WFMC.exe 再启动，等于每次都跑一遍安装流程；
  //   而安装包在「更新」分支里会把整个安装目录挪走再删，数据在安装目录里的用户每次更新都丢数据。）
  if (!process.env.PORTABLE_EXECUTABLE_FILE) {
    spawn(tmp, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    setTimeout(() => app.quit(), 800)
    return tmp
  }

  const script = path.join(os.tmpdir(), `wfmc-update-${Date.now()}.cmd`)
  const content = [
    '@echo off',
    'chcp 65001 >nul',
    'timeout /t 2 /nobreak >nul',
    `:wait`,
    `tasklist /fi "PID eq ${process.pid}" | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
    `move /y "${tmp}" "${exe}"`,
    `start "" "${exe}"`,
    'del "%~f0"'
  ].join('\r\n')
  fs.writeFileSync(script, content, 'utf-8')

  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => app.quit(), 600)
  return tmp
}

/** 便携模式：数据目录跟着 exe 走 */
export function portableDataDir(): string | undefined {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  if (!portable) return undefined
  return path.join(portable, 'WFMC-Data')
}

/* ------------------------------------------------------------------ *
 * GitHub Releases 更新源（推荐）：能拿到全部历史版本 + 更新说明 + 附件
 * ------------------------------------------------------------------ */

export interface ReleaseAsset {
  name: string
  size: number
  url: string
}

export interface ReleaseInfo {
  version: string
  tag: string
  name: string
  notes: string
  publishedAt: string
  prerelease: boolean
  assets: ReleaseAsset[]
}

export interface DeltaPlan {
  /** portable = 直接补 exe；asar = 补 resources/app.asar */
  kind: DeltaKind
  asset: ReleaseAsset
  /** 要被替换的那个本地文件 */
  target: string
  fromVersion: string
  toVersion: string
}

export type DeltaKind = 'portable' | 'asar'

export interface ReleaseCheck {
  current: string
  hasUpdate: boolean
  latest?: ReleaseInfo
  /** 全部历史版本（含最新） */
  history: ReleaseInfo[]
  source: 'github' | 'json' | 'none'
  error?: string
  /** 有可用的增量补丁时带上（客户端只下这一小块就够了） */
  delta?: { kind: DeltaKind; size: number; url: string; from: string; to: string }
}


/** 把「用户名/仓库名」「releases 页面地址」「API 地址」统一成 API 地址 */
function toReleasesApi(input: string): string {
  const u = input.trim()
  if (!u) return ''
  if (u.includes('api.github.com')) return u.includes('?') ? u : `${u}?per_page=30`
  const gh = u.match(/github\.com\/([^/\s]+)\/([^/\s?#]+)/i)
  if (gh) return `https://api.github.com/repos/${gh[1]}/${gh[2].replace(/\.git$/i, '')}/releases?per_page=30`
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) return `https://api.github.com/repos/${u}/releases?per_page=30`
  return u
}

interface RawRelease {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  prerelease?: boolean
  draft?: boolean
  assets?: { name: string; size: number; browser_download_url: string }[]
}

export function normalizeVersion(tag: string): string {
  return tag.replace(/^v/i, '').trim()
}

function toReleaseInfo(raw: RawRelease): ReleaseInfo {
  return {
    version: normalizeVersion(raw.tag_name),
    tag: raw.tag_name,
    name: raw.name || raw.tag_name,
    notes: raw.body || '',
    publishedAt: raw.published_at || '',
    prerelease: !!raw.prerelease,
    assets: (raw.assets ?? []).map((a) => ({ name: a.name, size: a.size, url: a.browser_download_url }))
  }
}

/** 检查更新：GitHub 模式（多版本）优先，其次兼容老的 update.json */
export async function checkReleases(): Promise<ReleaseCheck> {
  const current = app.getVersion()
  const raw = store.settings.updateUrl?.trim() ?? ''
  if (!raw) {
    return { current, hasUpdate: false, history: [], source: 'none', error: '还没有配置更新源' }
  }
  const api = toReleasesApi(raw)

  if (!api.includes('api.github.com')) {
    // 老方案：单个 update.json
    const info = await checkUpdate()
    const one: ReleaseInfo | undefined = info.latest
      ? {
          version: info.latest,
          tag: `v${info.latest}`,
          name: `WFMC ${info.latest}`,
          notes: info.notes ?? '',
          publishedAt: '',
          prerelease: false,
          assets: info.url ? [{ name: 'update.exe', size: 0, url: info.url }] : []
        }
      : undefined
    return attachDelta({
      current,
      hasUpdate: info.hasUpdate,
      latest: one,
      history: one ? [one] : [],
      source: 'json',
      error: info.error
    })
  }

  // GitHub API 在国内经常连不上，按 直连 → gh-proxy → ghfast 顺序试
  const candidates = [api, `https://gh-proxy.com/${api}`, `https://ghfast.top/${api}`]
  let res: Response | undefined
  let lastErr: unknown
  for (const url of candidates) {
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'WFMC-Updater',
          Accept: 'application/vnd.github+json'
        },
        signal: AbortSignal.timeout(8000)
      })
      if (r.ok || r.status === 404) {
        res = r
        break
      }
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) {
      lastErr = e
    }
  }
  if (!res) {
    return {
      current,
      hasUpdate: false,
      history: [],
      source: 'github',
      error: `检查更新失败：${(lastErr as Error)?.message ?? '网络不通'}`
    }
  }
  try {
    if (res.status === 404) {
      return { current, hasUpdate: false, history: [], source: 'github', error: '更新仓库不存在（检查设置里的仓库名）' }
    }
    if (!res.ok) {
      return { current, hasUpdate: false, history: [], source: 'github', error: `GitHub 返回 HTTP ${res.status}` }
    }
    const list = (await res.json()) as RawRelease[]
    const releases = list.filter((r) => !r.draft).map(toReleaseInfo)
    releases.sort((a, b) => (compareVersion(a.version, b.version) > 0 ? 1 : -1))
    const latest = releases[0]
    const hasUpdate = !!latest && compareVersion(current, latest.version) > 0
    store.setSettings({ lastUpdateCheck: Date.now() })
    return attachDelta({ current, hasUpdate, latest, history: releases, source: 'github' })
  } catch (e) {
    return {
      current,
      hasUpdate: false,
      history: [],
      source: 'github',
      error: `检查更新失败：${(e as Error).message}`
    }
  }
}

/** 从某个版本的附件里挑合适的安装包：便携版挑 Portable，安装版挑 Setup */
export function pickAsset(release: ReleaseInfo): ReleaseAsset | undefined {
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE
  const byPortable = release.assets.find((a) => /portable/i.test(a.name) && a.name.endsWith('.exe'))
  const bySetup = release.assets.find((a) => /setup|install/i.test(a.name) && a.name.endsWith('.exe'))
  if (portable) return byPortable ?? bySetup ?? release.assets.find((a) => a.name.endsWith('.exe'))
  return bySetup ?? byPortable ?? release.assets.find((a) => a.name.endsWith('.exe'))
}

/* ------------------------------------------------------------------ *
 * 增量更新：只下"变化的那几 MB"
 *
 * 发布侧约定（scripts/make-delta.mjs 生成、跟安装包一起上传）：
 *   wfdelta-<旧版本>-to-<新版本>-portable.wdelta   便携版：补的是 exe 本身
 *   wfdelta-<旧版本>-to-<新版本>-asar.wdelta       安装版：补的是 resources/app.asar
 *
 * 客户端按自己的版本号和运行形态精确匹配；找不到 / 校验不过 / 任何异常都回落到整包，
 * 所以老版本用户和不满足条件的人永远不会因为增量更新而更新失败。
 * ------------------------------------------------------------------ */

/** 当前进程能补的是哪个文件 */
function deltaTargets(): { kind: DeltaKind; target: string }[] {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE
  if (portable && fs.existsSync(portable)) return [{ kind: 'portable', target: portable }]
  return [{ kind: 'asar', target: path.join(process.resourcesPath, 'app.asar') }]
}

export function findDelta(release: ReleaseInfo, current = app.getVersion()): DeltaPlan | undefined {
  for (const t of deltaTargets()) {
    const name = `wfdelta-${current}-to-${release.version}-${t.kind}.wdelta`.toLowerCase()
    const asset = release.assets.find((a) => a.name.toLowerCase() === name)
    if (asset && fs.existsSync(t.target)) {
      return { kind: t.kind, asset, target: t.target, fromVersion: current, toVersion: release.version }
    }
  }
  return undefined
}

export interface UpdateResult {
  /** 下载/落地的文件（整包是安装包路径，增量是补丁路径） */
  path: string
  via: 'delta' | 'full'
  /** 增量补丁本身的字节数（via=delta 时有效） */
  deltaBytes?: number
  /** 增量更新省下的字节数（via=delta 时有效） */
  savedBytes?: number
}

/** 打补丁 → 写替换脚本 → 退出并重启 */
async function applyDeltaUpdate(plan: DeltaPlan, onProgress?: ProgressFn): Promise<string> {
  const tmp = path.join(os.tmpdir(), `wfmc-delta-${Date.now()}.wdelta`)
  await downloadWithMirrors(plan.asset.url, tmp, '下载增量补丁', onProgress)

  onProgress?.({ key: 'update', phase: '校验增量补丁', current: 0, total: 1 })
  const delta = fs.readFileSync(tmp)
  let header
  try {
    header = readDeltaHeader(delta)
  } catch (e) {
    throw new Error(`增量补丁无效：${(e as Error).message}`)
  }
  if (header.toSize <= 0) throw new Error('增量补丁头部异常')

  onProgress?.({ key: 'update', phase: '应用增量补丁', current: 0, total: 1 })
  const oldBuf = fs.readFileSync(plan.target)
  const nextBuf = applyDelta(oldBuf, delta) // 内部会核对 fromSize/fromSha256/toSha256
  const staged = `${plan.target}.new`
  fs.writeFileSync(staged, nextBuf)

  onProgress?.({ key: 'update', phase: '准备替换文件', current: 1, total: 1 })
  backupRecords()

  const exe = targetExecutable()
  const isPortable = plan.kind === 'portable'
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'timeout /t 2 /nobreak >nul',
    ':wait',
    `tasklist /fi "PID eq ${process.pid}" | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
    // 旧文件先改名留底：新文件放进去起得来，起来后自动清掉备份
    `if exist "${plan.target}.bak" del /f /q "${plan.target}.bak"`,
    `move /y "${plan.target}" "${plan.target}.bak"`,
    `move /y "${staged}" "${plan.target}"`,
    `start "" "${exe}"`,
    'timeout /t 8 /nobreak >nul',
    `if exist "${plan.target}" del /f /q "${plan.target}.bak"`,
    'del "%~f0"'
  ]
  const script = path.join(os.tmpdir(), `wfmc-delta-${Date.now()}-${isPortable ? 'p' : 'a'}.cmd`)
  fs.writeFileSync(script, lines.join('\r\n'), 'utf-8')
  spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  setTimeout(() => app.quit(), 600)
  return tmp
}

/**
 * 更新入口：优先增量，失败静默回落整包。
 * 渲染层只要拿到结果里的 via 就能告诉用户"这次只下了 X MB"。
 */
export async function applyBestUpdate(release: ReleaseInfo, onProgress?: ProgressFn): Promise<UpdateResult> {
  const plan = findDelta(release)
  if (plan) {
    try {
      const before = fs.statSync(plan.target).size
      const path2 = await applyDeltaUpdate(plan, onProgress)
      return {
        path: path2,
        via: 'delta',
        deltaBytes: plan.asset.size,
        savedBytes: Math.max(0, before - plan.asset.size)
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      logError('updater', '增量更新失败，回落整包', msg)
      try {
        fs.rmSync(`${plan.target}.new`, { force: true })
      } catch {
        /* 清理失败无所谓 */
      }
      onProgress?.({ key: 'update', phase: `增量更新失败，改用整包（${msg}）`, current: 0, total: 1 })
    }
  }
  const asset = pickAsset(release)
  if (!asset) throw new Error('这个版本没有可下载的安装包')
  return { path: await applyUpdate(asset.url, onProgress), via: 'full' }
}

/** 检查更新时顺带告诉界面：这次能用增量补丁吗、多大 */
function attachDelta(check: ReleaseCheck): ReleaseCheck {
  if (!check.hasUpdate || !check.latest) return check
  try {
    const plan = findDelta(check.latest, check.current)
    if (!plan) return check
    check.delta = {
      kind: plan.kind,
      size: plan.asset.size,
      url: plan.asset.url,
      from: plan.fromVersion,
      to: plan.toVersion
    }
  } catch {
    /* 增量信息拿不到就当没有 */
  }
  return check
}
