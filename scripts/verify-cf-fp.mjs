// 校验 CurseForge fingerprint 算法：「空白归一化」murmur2(seed=1) 算出来的数能不能被 CF 认领。
// 算法来源：Crash Assistant 的 ModFingerprinter.java（CF 用 "Normalized" MurmurHash2）。
//   1) 剔除文件字节里的空白（\t 9 / \n 10 / \r 13 / 空格 32）
//   2) 对剩下的字节跑标准 MurmurHash2 32 位，seed=1，h0 = seed ^ 归一化长度
// 用法：node scripts/verify-cf-fp.mjs [--max N] [--batch] <jar 或目录> [...]
//   默认逐个问（CF 的 exactMatches 不给 fingerprint 字段，批量没法可靠对位）；
//   --batch 只用于看总命中率。
// key 从 %APPDATA%\wfmc\settings.json 的 curseforgeApiKey 读。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function murmur2(buf, seed = 1) {
  const m = 0x5bd1e995
  const r = 24
  const len = buf.length
  let h = (seed ^ len) >>> 0
  const len4 = len >>> 2
  for (let i = 0; i < len4; i++) {
    const i4 = i << 2
    let k = (buf[i4] | (buf[i4 + 1] << 8) | (buf[i4 + 2] << 16) | (buf[i4 + 3] << 24)) >>> 0
    k = Math.imul(k, m) >>> 0
    k ^= k >>> r
    k = Math.imul(k, m) >>> 0
    h = Math.imul(h, m) >>> 0
    h ^= k
  }
  switch (len & 3) {
    case 3:
      h ^= (buf[(len & ~3) + 2] & 0xff) << 16
    case 2:
      h ^= (buf[(len & ~3) + 1] & 0xff) << 8
    case 1:
      h ^= buf[len & ~3] & 0xff
      h = Math.imul(h, m) >>> 0
  }
  h ^= h >>> 13
  h = Math.imul(h, m) >>> 0
  h ^= h >>> 15
  return h >>> 0
}

/** CF 归一化：剔除空白字节 */
function normalize(buf) {
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 9 || b === 10 || b === 13 || b === 32) continue
    n++
  }
  if (n === buf.length) return buf
  const out = Buffer.allocUnsafe(n)
  let j = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b === 9 || b === 10 || b === 13 || b === 32) continue
    out[j++] = b
  }
  return out
}

const fingerprintOf = (file) => murmur2(normalize(fs.readFileSync(file)))

const argv = process.argv.slice(2)
let max = 30
let batch = false
const inputs = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--max') max = Number(argv[++i]) || 30
  else if (argv[i] === '--batch') batch = true
  else inputs.push(argv[i])
}

const settingsPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'wfmc', 'settings.json')
const key = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')).curseforgeApiKey?.trim()
if (!key) {
  console.error('settings.json 里没有 curseforgeApiKey')
  process.exit(2)
}

const targets = []
for (const a of inputs) {
  const st = fs.statSync(a)
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(a)) if (n.toLowerCase().endsWith('.jar')) targets.push(path.join(a, n))
  } else targets.push(a)
}
if (targets.length === 0) {
  console.error('用法：node scripts/verify-cf-fp.mjs [--max N] [--batch] <jar 或目录>')
  process.exit(2)
}
const picked = targets.slice(0, max)

const headers = { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' }

async function ask(fps) {
  const res = await fetch('https://api.curseforge.com/v1/fingerprints', {
    method: 'POST',
    headers,
    body: JSON.stringify({ fingerprints: fps }),
    signal: AbortSignal.timeout(60000)
  })
  if (!res.ok) throw new Error(`CF API ${res.status} ${await res.text()}`)
  return (await res.json()).data ?? {}
}

if (batch) {
  const fps = picked.map(fingerprintOf)
  const data = await ask(fps)
  const hits = (data.exactMatches ?? []).length
  console.log(`批量：提交 ${fps.length} | exactMatches=${hits} | 命中率 ${((hits / fps.length) * 100).toFixed(0)}%`)
} else {
  let ok = 0
  for (const t of picked) {
    const fp = fingerprintOf(t)
    const data = await ask([fp])
    const hit = (data.exactMatches ?? [])[0]
    if (hit) ok++
    const info = hit ? `${hit.file?.fileName} (modId=${hit.file?.modId} fileId=${hit.file?.id})` : '对不上'
    console.log(`  ${String(fp).padStart(10)}  ${path.basename(t)}  →  ${info}`)
  }
  console.log(`\n命中 ${ok}/${picked.length}（${((ok / picked.length) * 100).toFixed(0)}%）`)
}
