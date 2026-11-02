// 核心链路冒烟测试：不启动 Electron，直接验证 @xmcl 内核能否真实下载 / 解析 / 生成启动参数
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const core = require('@xmcl/core')
const installer = require('@xmcl/installer')
const modrinth = require('@xmcl/modrinth')
const user = require('@xmcl/user')

const { Version, generateArguments } = core
const { install, installVersion, installLibraries, getVersionList, getLoaderArtifactListFor, installFabric } = installer

const root = path.join(os.tmpdir(), 'zhudong-smoke')
fs.mkdirSync(root, { recursive: true })

// 与 app 内一致：默认走 BMCLAPI 镜像（libraries.minecraft.net 在国内常年超时，
// 而 repo1.maven.org 上根本没有 launchwrapper 这类旧库），WFMC_SMOKE_MIRROR=0 可关掉直连官方源。
const useMirror = process.env.WFMC_SMOKE_MIRROR !== '0'
const MIRROR = {
  mavenHost: 'https://bmclapi2.bangbang93.com/maven',
  assetsHost: 'https://bmclapi2.bangbang93.com/assets',
  json: (v) => `https://bmclapi2.bangbang93.com/version/${v.id}/json`,
  client: (v) => `https://bmclapi2.bangbang93.com/version/${v.id}/client`
}
const installOpt = useMirror ? MIRROR : {}
const libOpt = useMirror ? { mavenHost: MIRROR.mavenHost } : {}
console.log(useMirror ? '下载源：BMCLAPI 镜像' : '下载源：官方原站')

function ok(msg) {
  console.log(`  [OK] ${msg}`)
}
function step(msg) {
  console.log(`\n== ${msg}`)
}

step('1. 拉取版本清单')
const list = await getVersionList()
ok(`拿到 ${list.versions.length} 个版本，最新正式版 = ${list.latest.release}`)

step('2. 安装老版本 1.0（完整：json + jar + libraries + assets）')
const small = list.versions.find((v) => v.id === '1.0')
if (!small) throw new Error('没找到 1.0')
const t0 = Date.now()
const resolvedOld = await install(small, root, installOpt)
ok(`1.0 安装完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
ok(`mainClass = ${resolvedOld.mainClass}`)
ok(`libraries = ${resolvedOld.libraries.length} 个`)
ok(`assets = ${resolvedOld.assets}`)

step('3. 只装新版本 1.20.1 的 json+jar+libraries（跳过全量 assets）')
const modern = list.versions.find((v) => v.id === '1.20.1')
if (!modern) throw new Error('没找到 1.20.1')
const v1201 = await installVersion(modern, root, installOpt)
await installLibraries(v1201, libOpt)
ok(`1.20.1 版本文件就绪，libraries = ${v1201.libraries.length} 个，assets 索引 = ${v1201.assetIndex?.id}`)

step('4. 解析版本并生成 JVM / 游戏启动参数')
const parsed = await Version.parse(root, '1.20.1')
const args = await generateArguments({
  gamePath: root,
  resourcePath: root,
  javaPath: 'java',
  version: parsed,
  gameProfile: { name: 'Steve', id: user.offline('Steve').selectedProfile.id },
  accessToken: 'offline-token',
  userType: 'mojang',
  launcherName: 'ZhuDongLauncher',
  maxMemory: 4096,
  minMemory: 1024
})
ok(`生成 ${args.length} 个参数`)
console.log('    样例:', args.slice(0, 6).join(' '), '...')
ok(`包含 mainClass: ${args.includes(parsed.mainClass)}`)
ok(`包含 -Xmx: ${args.some((a) => a.startsWith('-Xmx'))}`)

step('5. Fabric 加载器：拉取版本并写入版本 json')
// meta.fabricmc.net 在部分网络下不可达，app 内走的是 BMCLAPI 的 fabric-meta 转存；
// 这里同样直取镜像（@xmcl 的 getLoaderArtifactListFor 只认 dispatcher、无法改 host）。
const fabricMetaUrl = useMirror
  ? 'https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.20.1'
  : 'https://meta.fabricmc.net/v2/versions/loader/1.20.1'
const artifacts = await (await fetch(fabricMetaUrl)).json()
ok(`1.20.1 可用 Fabric loader ${artifacts.length} 个，最新 = ${artifacts[0]?.loader.version}`)
const versionId = await installFabric(artifacts[0], root, { versionId: `fabric-test-1.20.1` })
const fabricParsed = await Version.parse(root, versionId)
ok(`Fabric 版本解析成功，mainClass = ${fabricParsed.mainClass}`)
ok(`Fabric 合并后 libraries = ${fabricParsed.libraries.length} 个`)

step('6. Modrinth 搜索（整合包 / 光影）')
const client = new modrinth.ModrinthV2Client()
const packs = await client.searchProjects({ query: 'optimized', facets: JSON.stringify([['project_type:modpack']]), limit: 3 })
ok(`整合包搜索命中 ${packs.total_hits} 个，首条 = ${packs.hits[0]?.title}`)
const shaders = await client.searchProjects({ query: 'shader', facets: JSON.stringify([['project_type:shader'], ['versions:1.20.1']]), limit: 3 })
ok(`光影搜索命中 ${shaders.total_hits} 个，首条 = ${shaders.hits[0]?.title}`)
const versions = await client.getProjectVersions(shaders.hits[0].project_id, { gameVersions: ['1.20.1'] })
ok(`首条光影有 ${versions.length} 个适配 1.20.1 的版本，文件 = ${versions[0]?.files[0]?.filename}`)

step('7. Java 探测')
const { getPotentialJavaLocations, resolveJava } = installer
const paths = await getPotentialJavaLocations()
const javas = []
for (const p of paths) {
  const info = await resolveJava(p).catch(() => undefined)
  if (info) javas.push(info)
}
ok(`系统 Java ${javas.length} 个：${javas.map((j) => j.majorVersion).join(', ') || '无'}`)

console.log(`\n全部冒烟项通过。测试目录：${root}`)
