// 验证自带 zip 读取器 + natives 解压 + 真启动
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)
const core = require('@xmcl/core')
const user = require('@xmcl/user')
const { Version, MinecraftFolder, LaunchPrecheck } = core

function listZipEntries(buf) {
  const EOCD = 0x06054b50,
    CEN = 0x02014b50
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('bad zip')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN) break
    const nameLen = buf.readUInt16LE(off + 28)
    out.push({
      name: buf.slice(off + 46, off + 46 + nameLen).toString('utf8'),
      method: buf.readUInt16LE(off + 10),
      compressedSize: buf.readUInt32LE(off + 20),
      localOffset: buf.readUInt32LE(off + 42)
    })
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  return out
}
function readEntry(buf, e) {
  const at = e.localOffset
  const nameLen = buf.readUInt16LE(at + 26)
  const extraLen = buf.readUInt16LE(at + 28)
  const start = at + 30 + nameLen + extraLen
  const raw = buf.slice(start, start + e.compressedSize)
  return e.method === 8 ? zlib.inflateRawSync(raw) : raw
}

const root = process.argv[2] || 'C:\\Users\\steveliuyan\\AppData\\Local\\Temp\\zhudong-e2e'
const javaPath = process.argv[3] || 'C:\\Program Files\\Zulu\\zulu-17\\bin\\java.exe'
const version = await Version.parse(root, '1.20.1')
const folder = new MinecraftFolder(root)

const nativesDir = folder.getNativesRoot(version.id)
await fs.promises.mkdir(nativesDir, { recursive: true })

const t0 = Date.now()
let total = 0
for (const lib of version.libraries.filter((l) => l.isNative)) {
  const jarPath = folder.getLibraryByPath(lib.download.path)
  if (!fs.existsSync(jarPath)) {
    console.log('  缺包', path.basename(jarPath))
    continue
  }
  const buf = fs.readFileSync(jarPath)
  const excluded = lib.extractExclude ?? []
  for (const e of listZipEntries(buf)) {
    if (e.name.endsWith('/') || e.name.includes('META-INF/') || e.name.endsWith('.sha1')) continue
    if (excluded.some((p) => e.name.startsWith(p))) continue
    const dest = path.join(nativesDir, e.name)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.writeFile(dest, readEntry(buf, e))
    total++
  }
}
console.log(`✅ natives 解压 ${total} 个文件，${Date.now() - t0}ms`)
console.log('   目录内容:', fs.readdirSync(nativesDir).slice(0, 8).join(', '))

const profile = user.offline('TestPlayer')
const option = {
  gamePath: root,
  resourcePath: root,
  javaPath,
  version,
  gameProfile: { name: 'TestPlayer', id: profile.selectedProfile.id },
  accessToken: profile.accessToken,
  userType: 'mojang',
  launcherName: 'ZhuDongLauncher',
  launcherBrand: '诛冬启动器',
  minMemory: 1024,
  maxMemory: 2048,
  prechecks: [LaunchPrecheck.checkVersion, LaunchPrecheck.checkLibraries, LaunchPrecheck.linkAssets]
}
console.log('launch() ...')
const proc = await core.launch(option)
console.log('✅ spawn ok pid=', proc.pid)

let ready = false
const tail = []
proc.stdout?.on('data', (c) => tail.push(c.toString()))
proc.stderr?.on('data', (c) => tail.push(c.toString()))
const w = core.createMinecraftProcessWatcher(proc)
w.on('minecraft-window-ready', () => {
  ready = true
  console.log('✅✅ 游戏窗口已出现 —— 端到端启动成功')
})
w.on('error', (e) => console.log('spawn error', e?.message ?? e))
w.on('minecraft-exit', (e) => {
  console.log('退出 code=', e.code)
  if (!ready) console.log(tail.join('').split('\n').slice(-25).join('\n'))
  process.exit(ready ? 0 : 2)
})
setTimeout(() => {
  if (!ready) console.log('⚠ 45s 未见窗口\n' + tail.join('').split('\n').slice(-30).join('\n'))
  else console.log('✅ 45s 仍存活，主动结束')
  proc.kill()
  process.exit(ready ? 0 : 3)
}, 45_000)
