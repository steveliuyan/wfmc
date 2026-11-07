#!/usr/bin/env node
/**
 * i18n 覆盖率扫描（CI 用）。
 *
 * 现在的做法不是逐条 t()，而是「运行时换文案」：
 *   - `src/renderer/i18n-zh.ts` + `src/renderer/i18n-parts/*.ts` 是「中文 → English」
 *     的对照表（PAIRS），运行期按 trim 后整段精确匹配；
 *   - `src/renderer/i18n-dynamic.ts` 里是一组正则，处理带变量的模板串
 *     （`安装失败：${e.message}`、`已备份 ${n} 个存档`）；
 *   - `src/renderer/autoI18n.ts` 在 language === 'en' 时依次尝试
 *     精确命中 → 动态规则 → 长词（≥4 字）逐词替换。
 *
 * 所以判定顺序也照抄这三层：模板串先代入变量再跑一次动态规则，能翻就算命中。
 * 动态规则直接从 i18n-dynamic.ts 取（Node 24 能直接 import .ts，老版本回落到
 * esbuild 转译），不在这里另抄一份，免得慢慢跑偏。
 *
 * 用法：
 *   node scripts/i18n-scan.mjs             # 报表
 *   node scripts/i18n-scan.mjs --list      # 报表 + 逐条列出漏掉的文案
 *   node scripts/i18n-scan.mjs --min 90    # 覆盖率低于 90% 就非 0 退出（CI 卡口）
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const rendererDir = path.join(root, 'src', 'renderer')
const dictFile = path.join(rendererDir, 'i18n-zh.ts')
const dynamicFile = path.join(rendererDir, 'i18n-dynamic.ts')

const argv = process.argv.slice(2)
const wantList = argv.includes('--list')
const minIdx = argv.indexOf('--min')
const minPercent = minIdx >= 0 ? Number(argv[minIdx + 1]) || 0 : 0

const CJK = /[\u4e00-\u9fa5]/
/** 不用翻的：注释、import、类型声明 */
const SKIP_LINE = /^\s*(\/\/|\/\*|\*|import |export type |export interface )/
/** 这些文件本身是词典/引擎，不参与统计 */
const SKIP_FILES = new Set(['i18n-zh.ts', 'autoI18n.ts', 'i18n.ts', 'i18n-dynamic.ts'])

function unescape(s) {
  return s.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
}

/** 把一张表文件的元组吃进 map（i18n-zh.ts 和各 i18n-parts/*.ts 都是这个格式） */
function eatPairs(map, file) {
  const text = fs.readFileSync(file, 'utf8')
  const re = /\[\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*\]/g
  let m
  while ((m = re.exec(text)) !== null) map.set(unescape(m[1]).trim(), unescape(m[2]))
}

/** 从 i18n-zh.ts + i18n-parts/*.ts 里把对照表读全（后面的覆盖前面的，和运行期一致） */
function loadDict() {
  const map = new Map()
  eatPairs(map, dictFile)
  const partsDir = path.join(rendererDir, 'i18n-parts')
  if (fs.existsSync(partsDir)) {
    for (const name of fs.readdirSync(partsDir)) {
      if (name.endsWith('.ts') && name !== 'index.ts') eatPairs(map, path.join(partsDir, name))
    }
  }
  return map
}

/** 运行期动态规则：优先直接 import .ts（Node ≥ 23 原生支持），否则用 esbuild 转译 */
async function loadDynamic() {
  try {
    const mod = await import(pathToFileURL(dynamicFile).href)
    if (typeof mod.convertDynamic === 'function') return mod.convertDynamic
  } catch {
    /* 老 Node 不认 .ts，走下面的 esbuild */
  }
  try {
    const { transformSync } = await import('esbuild')
    const code = transformSync(fs.readFileSync(dynamicFile, 'utf8'), { loader: 'ts', format: 'esm' }).code
    const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
    if (typeof mod.convertDynamic === 'function') return mod.convertDynamic
  } catch {
    /* 两个都不行就只能按静态表算，会在报表里提示 */
  }
  console.warn('[i18n-scan] 读不到 i18n-dynamic.ts 的动态规则，模板串会一律算没翻')
  return () => undefined
}

/** 把模板串里的 ${...} 换成占位值（支持嵌套大括号），用来试跑动态规则 */
function sampleTemplate(lit) {
  let out = ''
  for (let i = 0; i < lit.length; i++) {
    if (lit[i] === '$' && lit[i + 1] === '{') {
      let depth = 1
      let j = i + 2
      while (j < lit.length && depth > 0) {
        if (lit[j] === '{') depth++
        else if (lit[j] === '}') depth--
        j++
      }
      out += '«v»'
      i = j - 1
    } else {
      out += lit[i]
    }
  }
  return out
}

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // i18n-parts 本身就是对照表，不算「界面里还没翻的文案」
      if (e.name === 'i18n-parts') continue
      out.push(...walk(p))
    } else if ((e.name.endsWith('.tsx') || e.name.endsWith('.ts')) && !SKIP_FILES.has(e.name)) out.push(p)
  }
  return out
}

/** 一行里所有含中文的字符串字面量（已反转义，`\n` 变成真换行，和运行期文本一致） */
function chineseLiterals(line) {
  const found = []
  const re = /(['"`])((?:[^'"`\\]|\\.)*?)\1/g
  let m
  while ((m = re.exec(line)) !== null) {
    if (CJK.test(m[2])) found.push(unescape(m[2]))
  }
  return found
}

const dict = loadDict()
const convertDynamic = await loadDynamic()
const longKeys = [...dict.keys()].filter((k) => k.length >= 4)

const rows = []
const missing = []
let total = 0
let exactHit = 0
let dynamicHit = 0
let partialHit = 0

for (const file of walk(rendererDir)) {
  const rel = path.relative(root, file).replace(/\\/g, '/')
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  let hit = 0
  let dyn = 0
  let part = 0
  let miss = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (SKIP_LINE.test(line)) continue
    for (const lit of chineseLiterals(line)) {
      const key = lit.trim()
      total++
      if (dict.has(key)) {
        hit++
        exactHit++
      } else if (convertDynamic(sampleTemplate(key)) !== undefined) {
        dyn++
        dynamicHit++
      } else if (longKeys.some((k) => key.includes(k))) {
        part++
        partialHit++
      } else {
        miss++
        missing.push({ file: rel, line: i + 1, text: key.length > 44 ? `${key.slice(0, 44)}…` : key })
      }
    }
  }
  if (hit + dyn + part + miss === 0) continue
  const n = hit + dyn + part + miss
  rows.push({ rel, hit, dyn, part, miss, pct: Math.round(((hit + dyn + part) / n) * 100) })
}

rows.sort((a, b) => b.miss - a.miss)
const covered = exactHit + dynamicHit + partialHit
const pct = total ? Math.round((covered / total) * 100) : 100

console.log(
  `渲染层中文字面量 ${total} 条：精确命中 ${exactHit}，动态规则命中 ${dynamicHit}，靠长词部分命中 ${partialHit}，完全没翻 ${total - covered}`
)
console.log(`覆盖率 ${pct}%（阈值 ${minPercent}%）\n`)
console.log('按「完全没翻」排序：')
for (const r of rows) {
  console.log(`  ${String(r.miss).padStart(4)}  ${String(r.pct).padStart(3)}%  ${r.rel}`)
}

if (wantList) {
  console.log('\n完全没翻的文案（往 src/renderer/i18n-parts/*.ts 或 i18n-dynamic.ts 里加）：')
  for (const n of missing) console.log(`  ${n.file}:${n.line}  ${n.text.replace(/\n/g, '\\n')}`)
}

if (minPercent && pct < minPercent) {
  console.error(`\n覆盖率 ${pct}% 低于阈值 ${minPercent}%`)
  process.exit(1)
}
