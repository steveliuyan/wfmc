/**
 * 一键发布到 GitHub Releases
 *
 * 用法（PowerShell）：
 *   $env:GH_TOKEN="ghp_xxx"; node scripts/publish-github.mjs --owner WanFan --repo wfmc --tag v1.0.0
 *
 * 做四件事：
 *   1. 校验 token（GET /user）
 *   2. 确保仓库存在（没有就按 public 建一个）
 *   3. 建/更新 release（带更新说明）
 *   4. 把 release 里的 exe 全部上传上去
 *
 * 传完会打印「更新源」应该填什么，复制进 设置 → 检查更新 → 更新源 即可。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

const token = process.env.GH_TOKEN || arg('token', '')
const owner = arg('owner', '')
const repo = arg('repo', 'wfmc')
const tag = arg('tag', '')
const notesFile = arg('notes', 'CHANGELOG.md')
const distDir = arg('dir', 'release')

const log = (...a) => console.log('[publish]', ...a)

if (!token) {
  console.error('缺少 token：设置环境变量 GH_TOKEN 或传 --token')
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
    body: body ? JSON.stringify(body) : undefined
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
    const msg = (json.message || text.slice(0, 200)) + detail
    throw new Error(`${method} ${p} → HTTP ${res.status} ${msg}`)
  }
  return json
}

/** 用 curl 传大文件（Node fetch 传 100MB 容易吃满内存） */
function uploadAsset(uploadUrl, file) {
  const name = path.basename(file)
  const size = (fs.statSync(file).size / 1024 / 1024).toFixed(1)
  log(`上传 ${name}（${size} MB）…`)
  const url = uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(name)}`)
  const out = execFileSync(
    'curl.exe',
    [
      '-sS',
      // 走系统代理时上传 90MB+ 会被代理掐断（curl: (55) Connection was reset），直连更稳
      '--noproxy',
      '*',
      '--retry',
      '3',
      '--retry-delay',
      '5',
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/octet-stream',
      '-H',
      'User-Agent: WFMC-Publisher',
      '--data-binary',
      `@${file}`,
      url
    ],
    { maxBuffer: 8 * 1024 * 1024 }
  )
  const json = JSON.parse(out.toString('utf-8'))
  if (json.errors) throw new Error(`上传 ${name} 失败：${JSON.stringify(json.errors)}`)
  // 断流时 GitHub 只返回一个空对象，别当成成功
  if (!json.id || json.state !== 'uploaded') {
    throw new Error(`上传 ${name} 没完成（state=${json.state ?? '无'}，返回 ${JSON.stringify(json).slice(0, 200)}），重跑一次即可续传`)
  }
  log(`✓ ${name} → ${json.browser_download_url ?? json.name}`)
}

const main = async () => {
  const me = await call('GET', '/user')
  log(`token 有效，账号：${me.login}`)
  const realOwner = owner || me.login

  // 1) 保证仓库存在
  try {
    await call('GET', `/repos/${realOwner}/${repo}`)
    log(`仓库已存在：${realOwner}/${repo}`)
  } catch (e) {
    if (!String(e.message).includes('404')) throw e
    log(`创建仓库 ${realOwner}/${repo} …`)
    await call('POST', '/user/repos', {
      name: repo,
      description: 'WFMC · 万凡 Minecraft 启动器（Electron + React + @xmcl）',
      private: false,
      has_issues: true,
      has_wiki: false
    })
  }

  // 1.5) 空仓库不能建 release：先塞一个 README 造出默认分支
  let needInit = false
  try {
    await call('GET', `/repos/${realOwner}/${repo}/commits?per_page=1`)
  } catch (e) {
    if (String(e.message).includes('404') || String(e.message).includes('409')) needInit = true
    else if (String(e.message).includes('409')) needInit = true
  }
  if (needInit) {
    log('仓库是空的，先提交一个 README 建立 main 分支…')
    const readme = [
      '# WFMC · 万凡 Minecraft 启动器',
      '',
      '下载请到 Releases 页面。',
      '',
      '本软件为第三方启动器，与 Mojang Studios / Microsoft 无隶属关系，详见 DISCLAIMER.md。'
    ].join('\n')
    await call('PUT', `/repos/${realOwner}/${repo}/contents/README.md`, {
      message: 'init: WFMC readme',
      content: Buffer.from(readme, 'utf-8').toString('base64')
    })
  }

  // 2) 版本号与说明
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  const version = tag ? tag.replace(/^v/i, '') : pkg.version
  const releaseTag = tag || `v${version}`
  const body = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf-8') : `WFMC ${version}`

  // 3) 建或更新 release
  let release
  try {
    release = await call('GET', `/repos/${realOwner}/${repo}/releases/tags/${releaseTag}`)
    log(`release ${releaseTag} 已存在，更新说明`)
    release = await call('PATCH', `/repos/${realOwner}/${repo}/releases/${release.id}`, { body, name: `WFMC ${version}` })
  } catch (e) {
    if (!String(e.message).includes('404')) throw e
    log(`创建 release ${releaseTag}`)
    release = await call('POST', `/repos/${realOwner}/${repo}/releases`, {
      tag_name: releaseTag,
      name: `WFMC ${version}`,
      body,
      draft: false,
      prerelease: false
    })
  }

  // 4) 上传附件
  const files = fs
    .readdirSync(distDir)
    .filter((f) => f.endsWith('.exe') && f.includes(`-${version}.exe`))
    .map((f) => path.join(distDir, f))
  if (files.length === 0) throw new Error(`${distDir} 里没有 exe，先 npm run dist`)
  const existing = new Set((release.assets ?? []).map((a) => a.name))
  for (const file of files) {
    const name = path.basename(file)
    if (existing.has(name)) {
      log(`跳过（已存在）：${name}`)
      continue
    }
    uploadAsset(release.upload_url, file)
  }

  log('—'.repeat(40))
  log(`发布完成：https://github.com/${realOwner}/${repo}/releases`)
  log(`更新源填这个：${realOwner}/${repo}`)
  log(`（或完整地址：${api(`/repos/${realOwner}/${repo}/releases`)}）`)
}

main().catch((e) => {
  console.error('[publish] 失败：', e.message)
  process.exit(1)
})
