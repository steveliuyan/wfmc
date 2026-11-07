/**
 * 1.3.0 核心纯函数断言（不启 Electron，跑 `npm run test:core`）。
 *
 * 覆盖六个方向里「逻辑最容易写错、又不依赖真实游戏文件」的部分：
 *   - nbt.ts：自研 NBT 的写→读往返（含长整型 / 列表 / 中文名 / 压缩方式保留）
 *   - modgraph.ts：成环检测、缺前置占位点、breaks 边
 *   - roommanifest.ts：清单编解码往返、差分三分（缺 / 版本不一致 / 多出来）、环境不一致直接拒绝
 *   - saveedit.ts：改存档白名单字段的路径必须是 `Data.xxx` 两段
 *
 * 这里只断言「纯」的部分；要读写真实实例目录的函数（listSaves / patchLevel）留给真机冒烟。
 */
import assert from 'node:assert/strict'
import {
  decompress,
  getPath,
  parseNbtBytes,
  parsePath,
  serializeNbt,
  setPath,
  toPlain,
  tagByte,
  tagNumber,
  tagString,
  TAG,
  type NbtFile
} from '../../src/main/nbt'
import { buildGraphFromMods, findCycles } from '../../src/main/modgraph'
import type { ModMeta } from '../../src/main/moddoctor'
import { decodeManifest, diffManifest, encodeManifest, MANIFEST_PREFIX } from '../../src/main/roommanifest'
import { LEVEL_FIELDS } from '../../src/main/saveedit'
import type { ModRef } from '../../src/main/serversync'
import type { RoomManifestPayload } from '../../src/shared/types'

let passed = 0
const ok = (name: string) => {
  passed++
  console.log(`  ok  ${name}`)
}

/* ------------------------------ NBT 往返 ------------------------------ */

const root = {
  t: TAG.compound,
  v: [
    {
      name: 'Data',
      tag: {
        t: TAG.compound,
        v: [
          { name: 'LevelName', tag: tagString('新世界') },
          { name: 'GameType', tag: tagNumber(1, TAG.int) },
          { name: 'Difficulty', tag: tagByte(2) },
          { name: 'hardcore', tag: tagByte(0) },
          { name: 'Time', tag: { t: TAG.long, v: BigInt(987654321) } },
          {
            name: 'PlayerPos',
            tag: {
              t: TAG.list,
              item: TAG.double,
              v: [tagNumber(1.5, TAG.double), tagNumber(64, TAG.double), tagNumber(-3.25, TAG.double)]
            }
          }
        ]
      }
    }
  ]
}

const kinds: NbtFile['compression'][] = ['none', 'gzip', 'zlib']
for (const compression of kinds) {
  const file: NbtFile = { name: '', root, compression }
  const bytes = serializeNbt(file)
  // 走和 readNbtFile 一样的路：先自动认压缩，再解析
  const un = decompress(bytes)
  assert.equal(un.compression, compression, `压缩方式没认出来（${compression}）`)
  const back = parseNbtBytes(un.data, un.compression)
  assert.deepEqual(toPlain(back.root), toPlain(root), `NBT 往返内容不一致（${compression}）`)
  assert.equal(back.compression, compression)
  ok(`NBT 写→读往返（${compression}）`)
}

// 路径读写
const levelName = getPath(root, 'Data.LevelName')
assert.equal(levelName?.t, TAG.string)
assert.equal(setPath(root, 'Data.Difficulty', tagByte(3)), true)
assert.equal((getPath(root, 'Data.Difficulty') as { v: number }).v, 3)
ok('NBT 路径读写（getPath / setPath）')

// 坏字节要报错，不能静默返回空档
assert.throws(() => parseNbtBytes(Buffer.from([0x0a, 0x00, 0x00, 0x01]), 'none'))
ok('NBT 截断/坏字节直接报错')

/* ------------------------------ 依赖图 ------------------------------ */

const dag = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' }
]
assert.deepEqual(findCycles(['a', 'b', 'c'], dag), [])
const ring = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
  { from: 'c', to: 'a' }
]
const ringCycles = findCycles(['a', 'b', 'c'], ring)
assert.equal(ringCycles.length, 1, '三节点环应该只报一次')
assert.deepEqual([...ringCycles[0]].sort(), ['a', 'b', 'c'])
assert.equal(findCycles(['x'], [{ from: 'x', to: 'x' }]).length, 1, '自环也算环')
ok('依赖图成环检测（DAG / 三元环 / 自环）')

const mods: ModMeta[] = [
  { file: 'a.jar', path: 'mods/a.jar', id: 'a', name: 'A', version: '1.0.0', loader: 'fabric', depends: ['b'] },
  {
    file: 'b.jar',
    path: 'mods/b.jar',
    id: 'b',
    name: 'B',
    version: '2.0.0',
    loader: 'fabric',
    depends: ['c'],
    breaks: ['d']
  },
  { file: 'd.jar', path: 'mods/d.jar', id: 'd', name: 'D', version: '3.0.0', loader: 'fabric' }
]
const graph = buildGraphFromMods(
  mods,
  new Map([
    ['a.jar', 111],
    ['b.jar', 222]
  ])
)
assert.equal(graph.stats.mods, 3)
assert.equal(graph.stats.missingCount, 1, 'c 没装，应该有一个缺前置占位点')
const missingNode = graph.nodes.find((n) => n.missing)
assert.ok(missingNode, '缺前置节点没生成')
assert.equal(missingNode?.key, 'missing:c')
assert.ok(
  graph.edges.some((e) => e.kind === 'missing' && e.from === 'b.jar'),
  'b → 缺前置 的边应该是 missing 类型'
)
assert.ok(
  graph.edges.some((e) => e.kind === 'breaks' && e.from === 'b.jar' && e.to === 'd.jar'),
  '声明的不兼容应该是 breaks 类型的边'
)
assert.equal(graph.nodes.find((n) => n.key === 'a.jar')?.bytes, 111, '文件大小没带进节点')
ok('依赖图节点/边/缺前置占位（buildGraphFromMods）')

/* ------------------------------ 联机清单 ------------------------------ */

const payload: RoomManifestPayload = {
  v: 1,
  name: '房主的实例',
  mcVersion: '1.20.1',
  loader: 'fabric',
  loaderVersion: '0.15.0',
  gamePort: 25565,
  at: 1700000000000,
  mods: [
    { file: 'same.jar', sha1: 'a'.repeat(40), size: 100 },
    { file: 'diff.jar', sha1: 'b'.repeat(40), size: 200 },
    { file: 'gone.jar', sha1: 'c'.repeat(40), size: 300 }
  ]
}
const code = encodeManifest(payload)
assert.ok(code.startsWith(MANIFEST_PREFIX), '短码要有 WFMC1: 前缀')
const decoded = decodeManifest(code)
assert.equal(decoded.name, payload.name)
assert.equal(decoded.mcVersion, payload.mcVersion)
assert.equal(decoded.mods.length, 3)
assert.equal(decoded.mods[0].sha1, 'a'.repeat(16), '编码时 sha1 应该裁到 16 位')
assert.throws(() => decodeManifest('WFMC1:not-base64!!'), '坏码要报错')
assert.throws(() => decodeManifest('hello'), '前缀不对要报错')
ok('清单编解码往返（encodeManifest / decodeManifest）')

const local = new Map<string, ModRef>([
  ['same.jar', { file: 'same.jar', sha1: 'a'.repeat(40), size: 100 }],
  ['diff.jar', { file: 'diff.jar', sha1: 'f'.repeat(40), size: 210 }],
  ['extra.jar', { file: 'extra.jar', sha1: 'e'.repeat(40), size: 50 }]
])
const diff = diffManifest(local, decoded, { mcVersion: '1.20.1', loader: 'fabric' })
assert.deepEqual(
  diff.missing.map((m) => m.file),
  ['gone.jar']
)
assert.deepEqual(
  diff.mismatch.map((m) => m.want.file),
  ['diff.jar']
)
assert.deepEqual(
  diff.extra.map((m) => m.file),
  ['extra.jar']
)
assert.equal(diff.refuse, undefined, '环境一致时不该拒绝')
assert.equal(diff.downloadBytes, 500, '要下的体积 = 缺的 300 + 要换掉的 200')
ok('清单差分三分（缺 / 版本不一致 / 多出来）')

const wrongEnv = diffManifest(local, decoded, { mcVersion: '1.21', loader: 'fabric' })
assert.ok(wrongEnv.refuse && wrongEnv.refuse.includes('1.21'), '版本不一致要直接拒绝')
const wrongLoader = diffManifest(local, decoded, { mcVersion: '1.20.1', loader: 'forge' })
assert.ok(wrongLoader.refuse, '加载器不一致要直接拒绝')
ok('清单差分环境护栏（版本 / 加载器不一致直接拒绝）')

/* ------------------------------ 存档白名单字段 ------------------------------ */

assert.ok(LEVEL_FIELDS.length >= 5, '白名单字段太少了')
for (const field of LEVEL_FIELDS) {
  const segs = parsePath(field)
  assert.equal(segs.length, 2, `${field} 应该是 Data.xxx 两段`)
  assert.equal(field.startsWith('Data.'), true, `${field} 必须落在 Data 下面`)
}
ok(`存档白名单字段路径规整（${LEVEL_FIELDS.length} 项）`)

console.log(`\n核心断言 ${passed} 组全部通过`)
