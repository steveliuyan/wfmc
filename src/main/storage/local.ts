// 本地文件夹后端：备份就放在本机某个目录里（可以是 OneDrive / 坚果云同步盘目录）。
//
// 目录结构与 WebDAV 后端完全一致（index.json + b_<id>.zip），这样两者的备份可以互相
// 直接拷来拷去。

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CloudBackup } from '../../shared/types'
import {
  INDEX_FILE,
  emptyIndex,
  fileNameOf,
  newBackupId,
  parseIndex,
  sortByNewest,
  type BackupIndex,
  type BackupMeta,
  type ProviderTest,
  type StorageProvider
} from './common'

export class LocalProvider implements StorageProvider {
  readonly kind = 'local' as const
  readonly label = '本地文件夹'
  readonly root: string

  constructor(root: string) {
    const dir = String(root ?? '').trim()
    if (!dir) throw new Error('还没选本地文件夹')
    this.root = dir
  }

  private fileOf(name: string): string {
    return path.join(this.root, name)
  }

  private ensureRoot(): void {
    fs.mkdirSync(this.root, { recursive: true })
  }

  private readIndex(): BackupIndex {
    const file = this.fileOf(INDEX_FILE)
    if (!fs.existsSync(file)) return emptyIndex()
    return parseIndex(fs.readFileSync(file, 'utf8'))
  }

  private writeIndex(index: BackupIndex): void {
    this.ensureRoot()
    const tmp = `${this.fileOf(INDEX_FILE)}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: index.items }, null, 1), 'utf8')
    fs.renameSync(tmp, this.fileOf(INDEX_FILE))
  }

  async list(opts: { limit?: number; kind?: 'config' | 'instance' } = {}): Promise<CloudBackup[]> {
    let items = sortByNewest(this.readIndex().items)
    if (opts.kind) items = items.filter((i) => (i.kind ?? 'config') === opts.kind)
    // 顺手剔除已经被手工删掉的文件
    items = items.filter((i) => fs.existsSync(this.fileOf(fileNameOf(i.id))))
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit)
    return items
  }

  async put(localZip: string, meta: BackupMeta = {}): Promise<CloudBackup> {
    this.ensureRoot()
    const buf = await fs.promises.readFile(localZip)
    const createdAt = meta.createdAt ?? Date.now()
    const id = newBackupId(createdAt)
    const sha256 = meta.sha256 ?? crypto.createHash('sha256').update(buf).digest('hex')
    const tmp = `${this.fileOf(fileNameOf(id))}.part`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, this.fileOf(fileNameOf(id)))
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
    const index = this.readIndex()
    index.items = sortByNewest([item, ...index.items.filter((i) => i.id !== id)])
    this.writeIndex(index)
    return item
  }

  async get(id: string, destPath: string): Promise<{ bytes?: number; sha256?: string }> {
    const src = this.fileOf(fileNameOf(id))
    if (!fs.existsSync(src)) throw new Error('这份备份的文件不见了（可能被手工删掉）')
    const buf = await fs.promises.readFile(src)
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    const item = this.readIndex().items.find((i) => i.id === id)
    if (item?.sha256 && item.sha256.toLowerCase() !== sha256) {
      throw new Error('备份文件校验失败（sha256 对不上）：文件可能被改过或没同步完')
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const tmp = `${destPath}.part`
    fs.writeFileSync(tmp, buf)
    fs.renameSync(tmp, destPath)
    return { bytes: buf.length, sha256 }
  }

  async remove(id: string): Promise<void> {
    const file = this.fileOf(fileNameOf(id))
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* 删不掉就算了，索引照样清 */
    }
    const index = this.readIndex()
    const next = index.items.filter((i) => i.id !== id)
    if (next.length !== index.items.length) {
      index.items = next
      this.writeIndex(index)
    }
  }

  async test(): Promise<ProviderTest> {
    try {
      this.ensureRoot()
      const probe = this.fileOf('.__wfmc_write_test')
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      const items = await this.list()
      const usedBytes = items.reduce((s, i) => s + (i.size || 0), 0)
      return { ok: true, message: `本地文件夹可写：已有 ${items.length} 份备份`, items: items.length, usedBytes }
    } catch (e) {
      return { ok: false, message: `本地文件夹不可写：${(e as Error)?.message ?? String(e)}` }
    }
  }

  async prune(keep: number): Promise<number> {
    const index = this.readIndex()
    const sorted = sortByNewest(index.items)
    const extra = sorted.slice(Math.max(1, keep))
    if (!extra.length) return 0
    for (const item of extra) {
      try {
        fs.rmSync(this.fileOf(fileNameOf(item.id)), { force: true })
      } catch {
        /* 忽略 */
      }
    }
    const keepIds = new Set(sorted.slice(0, Math.max(1, keep)).map((i) => i.id))
    index.items = index.items.filter((i) => keepIds.has(i.id))
    this.writeIndex(index)
    return extra.length
  }
}
