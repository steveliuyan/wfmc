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
import fs from 'node:fs'
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
import { cfFingerprint, cfNormalize, fingerprintOf } from '../../src/main/cfexport'
import { libraryRelPath } from '../../src/main/game'
import {
  fixLibraryDownloads,
  loaderTargetVersionId,
  makeCleanroomVersionJson,
  makeLegacyFabricVersionJson
} from '../../src/main/minecraft'

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

/* ------------------------------ CurseForge 指纹 ------------------------------ */

// CF 认的是「空白归一化」的 murmur2：同一份 jar 改了换行/缩进，指纹必须不变。
// 真值来源：CF API 的 fileFingerprint（0World2Create 那条实测 1211594411）。
assert.equal(
  cfFingerprint(Buffer.from('\t\r\n alice  bob\t\r\n', 'utf-8')),
  cfFingerprint(Buffer.from('alicebob', 'utf-8')),
  '空白字节必须被归一化掉'
)
assert.equal(cfNormalize(Buffer.from('a\tb\nc\rd e', 'utf-8')).toString('utf-8'), 'abcde', '只剔 \\t \\n \\r 空格')
assert.equal(cfNormalize(Buffer.from([0, 9, 10, 13, 32, 1])).length, 2, '0x00 / 0x01 不算空白')
assert.equal(cfFingerprint(Buffer.alloc(0)), 1540447798, '空文件的指纹锁死（seed 1 / len 0 的 murmur2）')

const REAL_JAR =
  'F:\\wfmc-data\\instances\\create-delight-remake\\minecraft\\mods\\0World2Create-Universal-1.19-1.20.X-1.0.0.jar'
if (fs.existsSync(REAL_JAR)) {
  assert.equal(fingerprintOf(REAL_JAR), 1211594411, '真实 jar 的指纹必须等于 CF 的 fileFingerprint')
  ok('CurseForge 指纹（真实 jar 对齐 CF 真值）')
} else {
  ok('CurseForge 指纹（空白归一化 + 空文件；本机没有真实 jar，跳过真值对齐）')
}

/* --------------------------- 加载器版本 json 合成 --------------------------- */

// maven 坐标 → 仓库相对路径：Cleanroom 的 natives 那批 classifiers 只给 url 不给 path，
// 少了这条兜底，installLibraries 里 path.join(..., undefined) 会直接抛 TypeError。
assert.equal(
  libraryRelPath('net.fabricmc:fabric-loader:0.16.10'),
  'net/fabricmc/fabric-loader/0.16.10/fabric-loader-0.16.10.jar'
)
assert.equal(
  libraryRelPath('org.lwjgl:lwjgl:3.4.3:natives-windows'),
  'org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-windows.jar'
)
assert.equal(libraryRelPath('com.example:mod:1.0@zip'), 'com/example/mod/1.0/mod-1.0.zip')
assert.equal(libraryRelPath('啥也不是'), undefined, '坐标不完整时不能瞎拼')
ok('maven 坐标 → 库相对路径（含 classifier / @ext）')

// Cleanroom：空 url 按 repositories 最长前缀补、classifier 缺 path 补齐、id 换掉且不留 inheritsFrom
// 找不到匹配的仓库前缀时宁可不补：指向错仓库只会变成 404，比报错更难查
const orphan = [{ name: 'unknown.group:thing:1.0', downloads: { artifact: { path: 'p/x.jar', url: '' } } }]
const orphanFix = fixLibraryDownloads(orphan as never, { com: 'https://a/' })
assert.equal(orphanFix.urlFixed, 0, '前缀对不上就不该补')
assert.equal(orphan[0].downloads.artifact.url, '', '原样留着')
ok('空 url 补地址的护栏（前缀对不上不瞎补）')

const crProfile = {
  repositories: {
    com: 'https://wrong.example/',
    'com.cleanroommc': 'https://maven.cleanroommc.com/'
  }
}
const crVersion = {
  id: 'Cleanroom-0.7.14-alpha',
  type: 'release',
  inheritsFrom: '1.12.2', // 上游万一带了，必须被删掉（父子 minecraftArguments 会被拼接）
  mainClass: 'top.outlands.foundation.boot.Foundation',
  minecraftArguments:
    '--username ${auth_player_name} --tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker',
  javaVersion: { component: 'java-runtime-epsilon', majorVersion: 25 },
  libraries: [
    {
      name: 'com.cleanroommc:cleanroom:0.7.14-alpha:universal',
      downloads: {
        artifact: {
          path: 'com/cleanroommc/cleanroom/0.7.14-alpha/cleanroom-0.7.14-alpha-universal.jar',
          url: ''
        }
      }
    },
    {
      name: 'org.lwjgl:lwjgl:3.4.3:natives-windows',
      downloads: { classifiers: { 'natives-windows': { url: 'https://example.com/lwjgl.jar' } } }
    },
    {
      name: 'com.mojang:text2speech:1.10.3',
      downloads: {
        artifact: { path: 'com/mojang/text2speech/1.10.3/text2speech-1.10.3.jar', url: 'https://libraries.minecraft.net/x.jar' }
      }
    }
  ]
}
const made = makeCleanroomVersionJson(crProfile, crVersion as never, 'cleanroom-0.7.14-alpha')
const madeJson = made.json as typeof crVersion
assert.equal(made.urlFixed, 1, '只有 cleanroom universal 那条真的缺 url')
assert.equal(made.pathFixed, 1, '只有那条 natives classifier 缺 path')
assert.equal(made.libraries, 3)
assert.equal(made.json.id, 'cleanroom-0.7.14-alpha')
assert.equal(made.json.type, 'release')
assert.equal('inheritsFrom' in made.json, false, 'Cleanroom 必须自包含，不能继承（否则 tweakClass 会被拼两遍）')
const madeLibs = madeJson.libraries!
assert.equal(
  madeLibs[0].downloads!.artifact!.url,
  'https://maven.cleanroommc.com/com/cleanroommc/cleanroom/0.7.14-alpha/cleanroom-0.7.14-alpha-universal.jar',
  '空 url 要按 group 的最长前缀挑仓库'
)
assert.equal(
  (madeLibs[1].downloads!.classifiers as Record<string, { path?: string }>)['natives-windows'].path,
  'org/lwjgl/lwjgl/3.4.3/lwjgl-3.4.3-natives-windows.jar',
  'classifier 缺 path 要按坐标补'
)
assert.equal(madeLibs[2].downloads!.artifact!.url, 'https://libraries.minecraft.net/x.jar', '本来有 url 的不能动')
assert.equal(madeJson.javaVersion.majorVersion, 25, 'Java 25 必须留着，启动时按它选 JVM')
assert.equal((madeJson.minecraftArguments.match(/--tweakClass/g) ?? []).length, 1, 'tweakClass 只能出现一次')
ok('Cleanroom 版本 json 合成（补 url / 补 classifier 路径 / 去 inheritsFrom / 保 Java 25）')

const lfJson = makeLegacyFabricVersionJson(
  {
    id: 'fabric-loader-0.16.10-1.12.2',
    inheritsFrom: '1.12.2',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: []
  },
  'legacyfabric-loader-0.16.10-1.12.2',
  '1.12.2'
)
assert.equal(lfJson.id, 'legacyfabric-loader-0.16.10-1.12.2', '官方给的 id 会和官方 Fabric 撞名，必须换')
assert.equal(lfJson.inheritsFrom, '1.12.2', '要靠继承拿 1.12.2 的 legacy minecraftArguments')
assert.equal(lfJson.type, 'release')
ok('Legacy Fabric 版本 json 合成（改名 + 继承原版）')

assert.equal(loaderTargetVersionId('legacyfabric', '1.12.2', '0.16.10'), 'legacyfabric-loader-0.16.10-1.12.2')
assert.equal(loaderTargetVersionId('cleanroom', '1.12.2', '0.7.14-alpha'), 'cleanroom-0.7.14-alpha')
ok('加载器 versionId 命名（不与官方 Fabric 冲突）')

console.log(`\n核心断言 ${passed} 组全部通过`)
