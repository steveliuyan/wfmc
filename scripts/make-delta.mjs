#!/usr/bin/env node
/**
 * 构建期生成增量补丁。
 *
 *   node scripts/make-delta.mjs <旧文件> <新文件> [输出.wdelta]
 *
 * 不指定输出时写成 <新文件>.wdelta，并额外打印体积/耗时，方便挂在 CI 里。
 * 补丁要跟发布物一起上传，名字建议 `<产品>-<旧版本>-to-<新版本>.wdelta`，
 * 客户端按 `checkReleases` 拿到的 release 资产名去找。
 */
import { build } from 'esbuild'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const [, , oldPath, newPath, outArg] = process.argv
if (!oldPath || !newPath) {
  console.error('用法: node scripts/make-delta.mjs <旧文件> <新文件> [输出.wdelta]')
  process.exit(2)
}

/** delta.ts 是 TS，用 esbuild 现场打成 ESM 再 import（避免为脚本再引一套构建配置） */
async function loadDelta() {
  const dir = mkdtempSync(join(tmpdir(), 'wfmc-delta-'))
  const outfile = join(dir, 'delta.mjs')
  await build({
    entryPoints: [join(root, 'src/main/delta.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning'
  })
  try {
    return await import(pathToFileURL(outfile).href + `?t=${Date.now()}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const { makeDelta, readDeltaHeader } = await loadDelta()

const oldFile = resolve(oldPath)
const newFile = resolve(newPath)
const outFile = outArg ? resolve(outArg) : `${newFile}.wdelta`

console.log(`旧文件 ${oldFile} (${(statSync(oldFile).size / 1048576).toFixed(2)} MB)`)
console.log(`新文件 ${newFile} (${(statSync(newFile).size / 1048576).toFixed(2)} MB)`)

const a = readFileSync(oldFile)
const b = readFileSync(newFile)

const t0 = Date.now()
const delta = makeDelta(a, b)
const ms = Date.now() - t0
writeFileSync(outFile, delta)

const header = readDeltaHeader(delta)
const pct = (delta.length / Math.max(1, b.length)) * 100
console.log(`\n补丁 ${outFile}`)
console.log(`  大小 ${(delta.length / 1024).toFixed(1)} KB（新文件的 ${pct.toFixed(2)}%，省下 ${((1 - delta.length / b.length) * 100).toFixed(2)}%）`)
console.log(`  块大小 ${header.blockSize}B  耗时 ${ms}ms`)
console.log(`  toSha256 ${header.toSha256}`)
