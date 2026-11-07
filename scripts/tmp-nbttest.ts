// 临时单测：NBT 完整读写 + 字节级往返 + 定点改。验证完即删。
import assert from 'node:assert'
import zlib from 'node:zlib'
import { getPath, parseNbtBytes, serializeNbt, setPath, tagNumber, tagString, toPlain } from '../src/main/nbt'
import type { NbtCompound, NbtFile, Tag } from '../src/main/nbt'

// 造一棵啥都有的树（含中文、emoji、负数、大 long、空列表、列表里的 compound）
const tree: NbtFile = {
  name: '',
  compression: 'gzip',
  root: {
    t: 10,
    v: [
      { name: 'Data', tag: { t: 10, v: [
        { name: 'LevelName', tag: tagString('我的世界 😀 存档') },
        { name: 'GameType', tag: tagNumber(1, 3) },
        { name: 'Difficulty', tag: { t: 1, v: 2 } },
        { name: 'hardcore', tag: { t: 1, v: 0 } },
        { name: 'allowCommands', tag: { t: 1, v: 1 } },
        { name: 'DayTime', tag: tagNumber(6000, 4) },
        { name: 'Time', tag: tagNumber(1234567890123, 4) },
        { name: 'shortOne', tag: { t: 2, v: -1234 } },
        { name: 'floatOne', tag: { t: 5, v: 0.5 } },
        { name: 'doubleOne', tag: { t: 6, v: 3.141592653589793 } },
        { name: 'bytes', tag: { t: 7, v: [-1, 0, 127] } },
        { name: 'ints', tag: { t: 11, v: [1, -2, 3] } },
        { name: 'longs', tag: { t: 12, v: [1n, -2n] } },
        { name: 'empty', tag: { t: 9, item: 0, v: [] } },
        { name: 'strs', tag: { t: 9, item: 8, v: [tagString('a'), tagString('中文')] } },
        { name: 'nested', tag: { t: 9, item: 10, v: [
          { t: 10, v: [{ name: 'x', tag: tagNumber(7, 3) }] },
          { t: 10, v: [] }
        ] } }
      ] as Tag[] } }
    ] as Tag[]
  }
}

// 1) 写 → 读，值要对
const bytes1 = serializeNbt(tree)
const back = parseNbtBytes(zlib.gunzipSync(bytes1), 'gzip')
assert.equal((getPath(back.root, 'Data.LevelName') as { v: string }).v, '我的世界 😀 存档', '中文 + emoji 要原样往返')
assert.equal((getPath(back.root, 'Data.DayTime') as { v: bigint }).v, 6000n)
assert.equal((getPath(back.root, 'Data.shortOne') as { v: number }).v, -1234)
assert.equal((getPath(back.root, 'Data.doubleOne') as { v: number }).v, 3.141592653589793)
assert.equal((getPath(back.root, 'Data.empty') as { item: number }).item, 0, '空列表的元素类型要保留')
assert.equal((getPath(back.root, 'Data.strs[1]') as { v: string }).v, '中文', '路径里能用 [i]（TAG_List）')
assert.equal(getPath(back.root, 'Data.ints[1]'), undefined, 'int 数组下标暂不支持（已知限制）')
assert.equal((getPath(back.root, 'Data.nested[0].x') as { v: number }).v, 7)

// 2) 字节级往返：原样写回去必须一模一样（这是「不顺手改坏存档」的底线）
const bytes2 = serializeNbt(back)
assert.deepEqual(bytes2, bytes1, '同一棵树写两遍字节必须一致')

// 3) 定点改：只动一个字段，其余字节不变
setPath(back.root, 'Data.GameType', tagNumber(0, 3))
setPath(back.root, 'Data.LevelName', tagString('改名了'))
const bytes3 = serializeNbt(back)
assert.notDeepEqual(bytes3, bytes1)
const third = parseNbtBytes(zlib.gunzipSync(bytes3), 'gzip')
assert.equal((getPath(third.root, 'Data.GameType') as { v: number }).v, 0)
assert.equal((getPath(third.root, 'Data.LevelName') as { v: string }).v, '改名了')
assert.equal((getPath(third.root, 'Data.DayTime') as { v: bigint }).v, 6000n, '别的字段不许动')
// 改回去应该又能得到原字节
setPath(third.root, 'Data.GameType', tagNumber(1, 3))
setPath(third.root, 'Data.LevelName', tagString('我的世界 😀 存档'))
assert.deepEqual(serializeNbt(third), bytes1, '改回原值后字节应完全一致')

// 4) 不存在字段不许新造（返回 false，上层据此拒绝）
const before = serializeNbt(third)
assert.equal(setPath(third.root, 'Data.不存在', tagNumber(1)), false)
assert.deepEqual(serializeNbt(third), before)

// 5) toPlain 大数组要截断（别把几千个方块塞进 IPC）
const big: NbtCompound = { t: 10, v: [{ name: 'a', tag: { t: 11, v: Array.from({ length: 5000 }, (_, i) => i) } }] }
const plain = toPlain(big, 0, 32) as Record<string, unknown>
assert.ok(Array.isArray(plain.a))
assert.equal((plain.a as unknown[]).length, 33, '截断到 32 项 + 一句提示')

console.log(`[nbt-test] 全部通过；gzip 后 ${bytes1.length} 字节，往返字节一致`)
