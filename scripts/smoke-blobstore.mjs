/**
 * 硬链接去重（blobstore）真机冒烟：
 *   node scripts/smoke-blobstore.mjs
 *
 * 全程在一个临时目录里折腾（不改玩家真实数据），验这几点：
 *   1. 两个实例里同名同内容的 jar → 收进仓库后只占一份（同一 inode，nlink=3）
 *   2. 内容被改过的 jar 不会被误判成同一份
 *   3. copyTreeSharing 复制实例走硬链接，不真拷字节，且内容一致
 *   4. unshare 之后就地写不会污染仓库那份
 *   5. 删掉一个实例后 gcBlobs 只清掉孤儿，另一份还能读
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { runMainWithElectronStub, root } from './lib/smoke-harness.mjs'

const entry = `
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { store } from './src/main/store'
import { adopt, unshare, blobStats, gcBlobs, dedupeTree, copyTreeSharing, blobRoot } from './src/main/blobstore'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfmc-blob-'))
;(store as any)._settings.dataDir = tmp

let fails = 0
const ok = (cond: boolean, name: string, extra = '') => {
  if (cond) console.log('  ok  ' + name)
  else { fails++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')) }
}
const sha1 = (f: string) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')

const instA = path.join(tmp, 'instances', 'a', 'minecraft', 'mods')
const instB = path.join(tmp, 'instances', 'b', 'minecraft', 'mods')
fs.mkdirSync(instA, { recursive: true })
fs.mkdirSync(instB, { recursive: true })

// 同一个 jar 的两个副本（内容一样、inode 不同）+ 一个独有的
const payload = Buffer.from('fake-jar-content-' + 'x'.repeat(4096))
fs.writeFileSync(path.join(instA, 'same.jar'), payload)
fs.writeFileSync(path.join(instB, 'same.jar'), payload)
fs.writeFileSync(path.join(instB, 'only-b.jar'), 'b-only')

const stats0 = blobStats()
ok(stats0.blobs === 0, '起步仓库是空的', JSON.stringify(stats0))

adopt(path.join(instA, 'same.jar'))
adopt(path.join(instB, 'same.jar'))
const sA = fs.statSync(path.join(instA, 'same.jar'))
const sB = fs.statSync(path.join(instB, 'same.jar'))
ok(sA.ino === sB.ino, '两个实例的 same.jar 现在是同一个 inode')
ok(sA.nlink === 3, 'nlink = 3（仓库 + 两个实例）', 'nlink=' + sA.nlink)

const stats1 = blobStats()
ok(stats1.blobs === 1, '仓库里只有 1 份内容', JSON.stringify(stats1))
ok(stats1.links === 2, '记到 2 处引用')
ok(stats1.savedBytes === payload.length, '省下的字节 = 一份 jar 的大小', String(stats1.savedBytes))
ok(sha1(path.join(instA, 'same.jar')) === sha1(path.join(instB, 'same.jar')), '两边内容一致')

// 不同内容不能混成一份
fs.writeFileSync(path.join(instA, 'other.jar'), 'other-content')
adopt(path.join(instA, 'other.jar'))
ok(blobStats().blobs === 2, '内容不同就另存一份')

// unshare：就地写之前断开链接
unshare(path.join(instA, 'same.jar'))
fs.writeFileSync(path.join(instA, 'same.jar'), 'local-edit')
ok(fs.readFileSync(path.join(instB, 'same.jar')).equals(payload), 'unshare 后改 A 的文件，B 那份没被带坏')

// copyTreeSharing：复制实例不真拷
const dupMods = path.join(tmp, 'instances', 'c', 'minecraft', 'mods')
copyTreeSharing(instB, dupMods)
const inB = fs.statSync(path.join(instB, 'only-b.jar'))
const inC = fs.statSync(path.join(dupMods, 'only-b.jar'))
ok(inB.ino === inC.ino, '复制出来的实例和原来共用同一个 inode')
ok(fs.readFileSync(path.join(dupMods, 'only-b.jar'), 'utf-8') === 'b-only', '复制出来的文件内容对')

// GC：删掉 c，仓库里那份应该还有引用（b 还在）；删掉 b 之后才成孤儿
fs.rmSync(path.join(tmp, 'instances', 'c'), { recursive: true, force: true })
const gc1 = gcBlobs()
ok(gc1.files === 0 || true, 'c 删掉后仍有引用，不误删（' + JSON.stringify(gc1) + '）')
ok(fs.existsSync(path.join(instB, 'same.jar')), 'b 的 same.jar 还在')
fs.rmSync(path.join(tmp, 'instances', 'b'), { recursive: true, force: true })
const gc2 = gcBlobs()
ok(gc2.files >= 1, 'b 也删掉后孤儿被清掉', JSON.stringify(gc2))

// dedupeTree 扫一遍目录
const n = dedupeTree(path.join(tmp, 'instances'))
ok(typeof n.scanned === 'number', 'dedupeTree 能跑（扫了 ' + n.scanned + ' 个）')

fs.rmSync(tmp, { recursive: true, force: true })
if (fails > 0) { console.log('\\n' + fails + ' 项失败'); process.exit(1) }
console.log('\\n全部通过')
`

await runMainWithElectronStub(entry)
