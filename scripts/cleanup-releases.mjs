/**
 * 清理旧版本：只保留最新一个 release（+ 它的 tag），其余连 tag 一起删掉。
 *
 *   $env:GH_TOKEN="ghp_..."; node scripts/cleanup-releases.mjs --owner steveliuyan --repo wfmc
 *   ... --keep v1.0.10     指定保留哪个
 *   ... --dry              只看会删什么，不动手
 */
const args = process.argv.slice(2)
const get = (k, d) => {
  const i = args.indexOf('--' + k)
  return i >= 0 ? args[i + 1] : d
}
const flag = (k) => args.includes('--' + k)

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
const OWNER = get('owner')
const REPO = get('repo')
const KEEP = get('keep')
const DRY = flag('dry')

if (!TOKEN) {
  console.error('[clean] 缺 GH_TOKEN')
  process.exit(1)
}
if (!OWNER || !REPO) {
  console.error('[clean] 用法：--owner <用户> --repo <仓库> [--keep v1.0.10] [--dry]')
  process.exit(1)
}

const API = `https://api.github.com/repos/${OWNER}/${REPO}`
const H = {
  Authorization: `token ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'wfmc-cleanup'
}

const cmp = (a, b) => {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function main() {
  const r = await fetch(`${API}/releases?per_page=100`, { headers: H })
  if (!r.ok) throw new Error(`列 release 失败 ${r.status} ${(await r.text()).slice(0, 200)}`)
  const list = await r.json()
  if (list.length === 0) {
    console.log('[clean] 没有 release')
    return
  }
  list.sort((a, b) => cmp(b.tag_name, a.tag_name))
  const keepTag = KEEP || list[0].tag_name
  console.log(`[clean] 共 ${list.length} 个 release，保留 ${keepTag}`)

  const doomed = list.filter((x) => x.tag_name !== keepTag)
  if (doomed.length === 0) {
    console.log('[clean] 没有要删的，已经只剩一个')
    return
  }
  for (const rel of doomed) {
    const line = `  ${rel.tag_name}（${rel.name || ''}｜${rel.assets.length} 个附件）`
    if (DRY) {
      console.log('[dry] 会删' + line)
      continue
    }
    const d = await fetch(`${API}/releases/${rel.id}`, { method: 'DELETE', headers: H })
    if (d.status !== 204) {
      console.log(`  ✗ ${rel.tag_name} 删除失败 ${d.status} ${(await d.text()).slice(0, 160)}`)
      continue
    }
    // release 删了 tag 还在，单独删掉，避免列表里留一堆空标签
    const t = await fetch(`${API}/git/refs/tags/${encodeURIComponent(rel.tag_name)}`, {
      method: 'DELETE',
      headers: H
    })
    console.log(`  ✓ 已删${line}${t.status === 204 ? ' + tag' : `（tag 删除 ${t.status}）`}`)
  }
  console.log('[clean] 完成')
}

main().catch((e) => {
  console.error('[clean] 失败：', e.message)
  process.exit(1)
})
