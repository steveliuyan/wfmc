import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ProgressFn } from '../shared/types'
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

/** 下载新包 → 写一个替换脚本 → 退出并重启 */
export async function applyUpdate(url: string, onProgress?: ProgressFn): Promise<string> {
  const exe = targetExecutable()
  const tmp = path.join(os.tmpdir(), `wfmc-update-${Date.now()}.exe`)
  const candidates = mirrorCandidates(url)
  let lastErr: unknown
  let ok = false
  for (let i = 0; i < candidates.length && !ok; i++) {
    try {
      onProgress?.({
        key: 'update',
        phase: i === 0 ? '下载新版本' : `直连失败，改走镜像 ${i}`,
        current: 0,
        total: 1
      })
      await downloadFile(
        candidates[i],
        tmp,
        (cur, total) => onProgress?.({ key: 'update', phase: '下载新版本', current: cur, total }),
        { skipIfExists: false }
      )
      ok = true
    } catch (e) {
      lastErr = e
    }
  }
  if (!ok) throw new Error(`新版本下载失败：${(lastErr as Error)?.message ?? '网络不通'}`)
  onProgress?.({ key: 'update', phase: '准备替换文件', current: 1, total: 1 })

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

export interface ReleaseCheck {
  current: string
  hasUpdate: boolean
  latest?: ReleaseInfo
  /** 全部历史版本（含最新） */
  history: ReleaseInfo[]
  source: 'github' | 'json' | 'none'
  error?: string
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
    return {
      current,
      hasUpdate: info.hasUpdate,
      latest: one,
      history: one ? [one] : [],
      source: 'json',
      error: info.error
    }
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
    return { current, hasUpdate, latest, history: releases, source: 'github' }
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
