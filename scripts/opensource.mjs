/**
 * 把源码一次性推到 GitHub（无需本地 git）
 *
 * 用法：$env:GH_TOKEN="ghp_xxx"; node scripts/opensource.mjs --repo wfmc
 *
 * 原理：Git Data API —— 一个请求建 tree（每个文件内联 content）→ 建 commit → 更新 main 指针。
 * 只推源码：node_modules / dist / release / WFMC-Data / 日志都不进去（见 .gitignore 同规则）。
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : d
}
const token = process.env.GH_TOKEN || arg('token', '')
const repo = arg('repo', 'wfmc')
const branch = arg('branch', 'main')
const message = arg('message', 'feat: WFMC 1.0.2 源码开源')

if (!token) {
  console.error('缺少 token：设置 GH_TOKEN 或传 --token')
  process.exit(1)
}

const api = (p) => `https://api.github.com${p}`
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'WFMC-Publisher',
  'X-GitHub-Api-Version': '2022-11-28'
}

async function call(method, p, body) {
  const res = await fetch(api(p), {
    method,
    headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000)
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const detail = json.errors ? ' ' + JSON.stringify(json.errors) : ''
    throw new Error(`${method} ${p} → HTTP ${res.status} ${json.message ?? text.slice(0, 300)}${detail}`)
  }
  return json
}

/* ---------------- 收集要上传的文件 ---------------- */

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', '.git', 'WFMC-Data', '.vscode', '.tmp-shot', '.github'])
const SKIP_FILES = [/^\.tmp-/, /^\.publish.*\.log$/, /^npm-debug\.log/, /\.log$/i, /^\.tree/, /^\.open\.log$/]
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|json|css|html|md|txt|yml|yaml|bat|ps1|gitignore|npmrc)$/i

const root = process.cwd()
const entries = []

function walk(dir, rel) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${item.name}` : item.name
    if (item.isDirectory()) {
      if (SKIP_DIRS.has(item.name)) continue
      walk(path.join(dir, item.name), relPath)
      continue
    }
    if (SKIP_FILES.some((re) => re.test(item.name))) continue
    const name = item.name === '.gitignore' || item.name === '.npmrc' ? item.name : item.name
    const isText = TEXT_EXT.test(item.name) || name === '.gitignore' || name === '.npmrc'
    if (!isText) continue
    const full = path.join(dir, item.name)
    const buf = fs.readFileSync(full)
    if (buf.length > 1.8 * 1024 * 1024) {
      console.log(`跳过（>1.8MB）：${relPath}`)
      continue
    }
    entries.push({ path: relPath, mode: '100644', type: 'blob', content: buf.toString('utf-8') })
  }
}

walk(root, '')
// 确保这些关键文件在
for (const must of ['LICENSE', '.gitignore', 'README.md', 'DISCLAIMER.md', 'HANDOFF.md', 'CHANGELOG.md']) {
  if (!entries.some((e) => e.path === must) && fs.existsSync(path.join(root, must))) {
    entries.push({ path: must, mode: '100644', type: 'blob', content: fs.readFileSync(path.join(root, must), 'utf-8') })
  }
}

console.log(`[open] 待推送文件：${entries.length} 个，共 ${(entries.reduce((s, e) => s + e.content.length, 0) / 1024).toFixed(0)} KB`)

/* ---------------- 推送 ---------------- */

const main = async () => {
  const me = await call('GET', '/user')
  const owner = arg('owner', me.login)
  console.log(`[open] 账号：${me.login} → 仓库 ${owner}/${repo}`)

  // 逐个建 blob（一次性塞 1MB 的 tree 请求会被拒），并发 6
  const blobs = []
  let done = 0
  const queue = [...entries]
  const workers = Array.from({ length: 6 }, async () => {
    for (;;) {
      const e = queue.shift()
      if (!e) return
      let sha
      for (let attempt = 1; attempt <= 3 && !sha; attempt++) {
        try {
          const b = await call('POST', `/repos/${owner}/${repo}/git/blobs`, {
            content: Buffer.from(e.content, 'utf-8').toString('base64'),
            encoding: 'base64'
          })
          sha = b.sha
        } catch (err) {
          if (attempt === 3) throw new Error(`${e.path} 上传失败：${err.message}`)
          await new Promise((r) => setTimeout(r, 800 * attempt))
        }
      }
      blobs.push({ path: e.path, mode: e.mode, type: 'blob', sha })
      done++
      if (done % 20 === 0) console.log(`[open] blob 进度 ${done}/${entries.length}`)
    }
  })
  await Promise.all(workers)
  console.log(`[open] blob 全部就绪：${blobs.length} 个`)

  const tree = await call('POST', `/repos/${owner}/${repo}/git/trees`, { tree: blobs })
  console.log(`[open] tree 已建：${tree.sha.slice(0, 10)}`)

  // 接着现有历史走（有 main 就用它当父提交，没有就是首个提交）
  let parents = []
  try {
    const ref = await call('GET', `/repos/${owner}/${repo}/git/refs/heads/${branch}`)
    if (ref?.object?.sha) parents = [ref.object.sha]
  } catch {
    parents = []
  }
  const commit = await call('POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents
  })
  console.log(`[open] commit 已建：${commit.sha.slice(0, 10)}`)

  try {
    await call('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true })
    console.log(`[open] 已更新 ${branch} 指针`)
  } catch (e) {
    if (String(e.message).includes('404')) {
      await call('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
      console.log(`[open] 已创建分支 ${branch}`)
    } else throw e
  }

  const info = await call('GET', `/repos/${owner}/${repo}`)
  console.log('[open] 完成 ————————————————————')
  console.log(`  仓库：${info.html_url}`)
  console.log(`  分支：${info.default_branch}   大小：${info.size} KB`)
  console.log(`  首页：${info.html_url}#readme`)
}

main().catch((e) => {
  console.error('[open] 失败：', e.message)
  process.exit(1)
})
