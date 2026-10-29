import fs from 'node:fs'
import path from 'node:path'
import { store } from './store'

/** 本地歌单：把音频放在 dataDir/music 里，播放器只认文件名 */
export interface Track {
  name: string
  path: string
  size: number
}

const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.flac', '.m4a', '.aac']

export function musicDir(): string {
  const dir = path.join(store.dataDir, 'music')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function listTracks(): Track[] {
  const dir = musicDir()
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && AUDIO_EXT.includes(path.extname(d.name).toLowerCase()))
    .map((d) => {
      const full = path.join(dir, d.name)
      return { name: d.name, path: full, size: fs.statSync(full).size }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 把外部音频复制进歌单目录 */
export function importTracks(files: string[]): Track[] {
  const dir = musicDir()
  for (const file of files) {
    if (!AUDIO_EXT.includes(path.extname(file).toLowerCase())) continue
    const dest = path.join(dir, path.basename(file))
    if (path.resolve(dest) === path.resolve(file)) continue
    fs.copyFileSync(file, dest)
  }
  return listTracks()
}

export function removeTrack(name: string): Track[] {
  const dir = musicDir()
  const full = path.join(dir, path.basename(name))
  if (full.startsWith(dir + path.sep)) fs.rmSync(full, { force: true })
  return listTracks()
}
