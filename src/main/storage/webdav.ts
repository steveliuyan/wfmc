// 通用 WebDAV 后端（坚果云 / Nextcloud / 群晖 / InfiniCLOUD / 任何标准 WebDAV）
//
// 只用了最基本的几个方法：MKCOL（建目录）、PUT（上传）、GET（下载/读索引）、
// DELETE（删除）。没有引入第三方包 —— 主进程是 esbuild `packages: 'external'` 打的，
// 多一个运行时依赖就要改打包配置，而我们需要的功能就这么点。
//
// 目录结构（远端 <dir> 下）：
//   index.json      元数据数组
//   b_<id>.zip      备份本体

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudBackup } from '../../shared/types'
import {
  INDEX_FILE,
  fileNameOf,
  newBackupId,
  normalizeDir,
  parseIndex,
  sortByNewest,
  type BackupIndex,
  type BackupMeta,
  type ProviderTest,
  type StorageProvider
} from './common'

export interface WebdavOptions {
  /** 形如 https://dav.jianguoyun.com/dav */
  url: string
  username?: string
  password?: string
  /** 远端子目录，默认 /wfmc */
  dir?: string
  timeoutMs?: number
}

const DEFAULT_DIR = '/wfmc'

export class WebdavProvider implements StorageProvider {
  readonly kind = 'webdav' as const
  readonly label = 'WebDAV'

  private readonly base: string
  private readonly dir: string
  private readonly auth?: string
  private readonly timeoutMs: number

  constructor(opts: WebdavOptions) {
    this.base = String(opts.url ?? '').trim().replace(/\/+$/, '')
    if (!this.base) throw new Error('还没填 WebDAV 地址')
    if (!/^https?:\/\//i.test(this.base)) throw new Error('WebDAV 地址要以 http:// 或 https:// 开头')
    this.dir = normalizeDir(opts.dir, DEFAULT_DIR)
    this.timeoutMs = opts.timeoutMs ?? 20000
    const user = String(opts.username ?? '')
    if (user) {
      this.auth = `Basic ${Buffer.from(`${user}:${String(opts.password ?? '')}`).toString('base64')}`
    }
  }

  // ------------------------------------------------------------ HTTP 基础

  private urlOf(sub = ''): string {
    const s = sub.replace(/^\/+/, '')
    return s ? `${this.base}${this.dir}/${s}` : `${this.base}${this.dir}`
  }

  private async request(method: string, sub = '', init: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      return await fetch(this.urlOf(sub), {
        method,
        headers: {
          ...(this.auth ? { authorization: this.auth } : {}),
          ...(init.headers ?? {})
        },
        body: init.body as BodyInit | undefined,
        signal: ctrl.signal,
        redirect: 'follow'
      })
    } catch (e) {
      const err = e as Error
      if (err?.name === 'AbortError') throw new Error('WebDAV 连接超时（20 秒没有响应），检查地址和网络')
      throw new Error(`连不上 WebDAV：${err?.message ?? e}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 把 HTTP 状态码翻译成人能看懂的话 */
  private describe(res: Response): string {
    const s = res.status
    if (s === 401) return '认证失败（HTTP 401）：坚果云要用「应用密码」而不是登录密码，用户名是完整邮箱'
    if (s === 403) return '没有权限（HTTP 403）：检查账号是否被限制，或目录是否只读'
    if (s === 404) return '路径不存在（HTTP 404）：检查地址，群晖/Nextcloud 通常要带 /remote.php/dav/files/<用户名>'
    if (s === 405) return '服务器不接受这个操作（HTTP 405）：这个目录可能不是 WebDAV 目录'
    if (s === 409) return '上级目录不存在（HTTP 409）：检查地址里的目录层级'
    if (s === 423) return '文件被锁定（HTTP 423）：稍后再试'
    if (s === 507) return '云端空间不足（HTTP 507）：清理网盘或减少保留份数'
    if (s >= 500) return `网盘服务器出错（HTTP ${s}）：稍后再试`
    return `请求失败（HTTP ${s}）`
  }

  /** 逐级 MKCOL；目录已存在时服务器一般回 405，视为成功 */
  private async ensureDir(): Promise<void> {
    const segs = this.dir.split('/').filter(Boolean)
    let acc = ''
    for (const seg of segs) {
      acc += `/${seg}`
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      let res: Response
      try {
        res = await fetch(`${this.base}${acc}`, {
          method: 'MKCOL',
          headers: { ...(this.auth ? { authorization: this.auth } : {}) },
          signal: ctrl.signal,
          redirect: 'follow'
        })
      } catch (e) {
        clearTimeout(timer)
        throw new Error(`建目录失败：${(e as Error)?.message ?? e}`)
      }
      clearTimeout(timer)
      if (res.status === 401 || res.status === 403) throw new Error(this.describe(res))
      if (res.status === 409) throw new Error(this.describe(res))
      if (res.status === 404) throw new Error('WebDAV 地址不对（HTTP 404）：目录的上一级都不存在，检查地址')
      // 201 新建成功 / 405 已存在 / 200 已存在 / 301,302 跳转 → 都继续
    }
  }

  // ------------------------------------------------------------ 索引

  private async readIndex(): Promise<BackupIndex> {
    const res = await this.request('GET', INDEX_FILE)
    if (res.status === 404) return parseIndex('')
    if (!res.ok) throw new Error(this.describe(res))
    return parseIndex(await res.text())
  }

  private async writeIndex(index: BackupIndex): Promise<void> {
    const res = await this.request('PUT', INDEX_FILE, {
      body: JSON.stringify({ version: 1, items: index.items }, null, 1),
      headers: { 'content-type': 'application/json; charset=utf-8' }
    })
    if (!res.ok) throw new Error(this.describe(res))
  }

  // ------------------------------------------------------------ StorageProvider

  async list(opts: { limit?: number; kind?: 'config' | 'instance' } = {}): Promise<CloudBackup[]> {
    const index = await this.readIndex()
    let items = sortByNewest(index.items)
    if (opts.kind) items = items.filter((i) => (i.kind ?? 'config') === opts.kind)
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit)
    return items
  }

  async put(localZip: string, meta: BackupMeta = {}): Promise<CloudBackup> {
    const buf = await fs.promises.readFile(localZip)
    const createdAt = meta.createdAt ?? Date.now()
    const id = newBackupId(createdAt)
    const sha256 = meta.sha256 ?? crypto.createHash('sha256').update(buf).digest('hex')

    await this.ensureDir()
    const up = await this.request('PUT', fileNameOf(id), {
      body: buf,
      headers: { 'content-type': 'application/zip' }
    })
    if (!up.ok) throw new Error(`上传失败：${this.describe(up)}`)

    const item: CloudBackup = {
      id,
      kind: meta.kind ?? 'config',
      size: buf.length,
      sha256,
      createdAt,
      appVersion: meta.appVersion,
      instanceName: meta.instanceName,
      note: meta.note
    }
    const index = await this.readIndex()
    index.items = sortByNewest([item, ...index.items.filter((i) => i.id !== id)])
    await this.writeIndex(index)
    return item
  }

  async get(id: string, destPath: string): Promise<{ bytes?: number; sha256?: string }> {
    const index = await this.readIndex()
    const item = index.items.find((i) => i.id === id)
    const res = await this.request('GET', fileNameOf(id))
    if (!res.ok) throw new Error(`下载失败：${this.describe(res)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    if (item?.sha256 && item.sha256.toLowerCase() !== sha256) {
      throw new Error('下载的文件校验失败（sha256 对不上），已丢弃。可能是传输中断或文件被改过')
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const tmp = `${destPath}.part`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, destPath)
    return { bytes: buf.length, sha256 }
  }

  async remove(id: string): Promise<void> {
    const res = await this.request('DELETE', fileNameOf(id))
    if (!res.ok && res.status !== 404) throw new Error(`删除失败：${this.describe(res)}`)
    const index = await this.readIndex()
    const next = index.items.filter((i) => i.id !== id)
    if (next.length !== index.items.length) {
      index.items = next
      await this.writeIndex(index)
    }
  }

  async test(): Promise<ProviderTest> {
    try {
      await this.ensureDir()
      const probe = '.__wfmc_write_test'
      const put = await this.request('PUT', probe, { body: 'ok', headers: { 'content-type': 'text/plain' } })
      if (!put.ok) throw new Error(`不能写入：${this.describe(put)}`)
      await this.request('DELETE', probe).catch(() => undefined)
      const index = await this.readIndex()
      const usedBytes = index.items.reduce((s, i) => s + (i.size || 0), 0)
      return {
        ok: true,
        message: `WebDAV 可读写：${this.dir} 下已有 ${index.items.length} 份备份`,
        items: index.items.length,
        usedBytes
      }
    } catch (e) {
      return { ok: false, message: (e as Error)?.message ?? String(e) }
    }
  }

  async prune(keep: number): Promise<number> {
    const index = await this.readIndex()
    const sorted = sortByNewest(index.items)
    const extra = sorted.slice(Math.max(1, keep))
    if (!extra.length) return 0
    let removed = 0
    for (const item of extra) {
      try {
        await this.request('DELETE', fileNameOf(item.id))
        removed++
      } catch {
        /* 单份删不掉不影响其它 */
      }
    }
    const keepIds = new Set(sorted.slice(0, Math.max(1, keep)).map((i) => i.id))
    index.items = index.items.filter((i) => keepIds.has(i.id))
    await this.writeIndex(index)
    return removed
  }
}
