import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'

// 自带曲目：原创合成（柔和钢琴 + 长尾混响），随安装包一起打包，删不掉也占不了多少空间
import builtinCaves from '../assets/music/calm-caves.ogg'
import builtinMeadow from '../assets/music/sunrise-meadow.ogg'
import builtinRain from '../assets/music/rainy-window.ogg'
import builtinBells from '../assets/music/village-bells.ogg'

interface Track {
  /** 显示名 */
  name: string
  /** 可播放地址（内置走打包后的相对 URL，用户导入走 file://） */
  src: string
  /** 内置曲目：不能删 */
  builtin: boolean
  /** 用户曲目的原始文件名，删除时用 */
  file?: string
}

const BUILTIN: Track[] = [
  { name: 'Sunrise Meadow', src: builtinMeadow, builtin: true },
  { name: 'Calm Caves', src: builtinCaves, builtin: true },
  { name: 'Rainy Window', src: builtinRain, builtin: true },
  { name: 'Village Bells', src: builtinBells, builtin: true }
]

/** 悬浮音乐播放器：内置 4 首 Minecraft 风格环境音乐，也能听 dataDir/music 里自己导入的 */
export default function MusicPlayer({ inline = false }: { inline?: boolean }) {
  const [userTracks, setUserTracks] = useState<Track[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('music') === 'open')
  const [volume, setVolume] = useState(0.7)
  const audioRef = useRef<HTMLAudioElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)

  const tracks = [...BUILTIN, ...userTracks]

  // 点开之后鼠标能移到面板上选；移走自动收回（留一点缓冲，防止手抖闪一下）
  const openNow = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    setOpen(true)
  }
  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
  }
  const closeSoon = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 280)
  }

  useEffect(() => {
    return () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  // Esc 也能收
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const load = async () => {
    const list = await api.musicList()
    setUserTracks(
      list.map((t) => ({
        name: t.name,
        src: `file://${t.path.replace(/\\/g, '/')}`,
        builtin: false,
        file: t.name
      }))
    )
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
  }, [volume])

  const current = tracks[index]

  const play = async (i?: number) => {
    const audio = audioRef.current
    if (!audio) return
    const target = typeof i === 'number' ? i : index
    if (typeof i === 'number') setIndex(i)
    const track = tracks[target]
    if (!track) return
    audio.src = track.src
    try {
      await audio.play()
      setPlaying(true)
    } catch {
      setPlaying(false)
    }
  }

  const toggle = async () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) await play()
    else {
      audio.pause()
      setPlaying(false)
    }
  }

  const label = (t: Track) => (t.builtin ? t.name : t.name.replace(/\.[^.]+$/, ''))

  return (
    <div
      className={`music ${open ? 'open' : ''} ${inline ? 'inline' : ''}`}
      onMouseEnter={cancelClose}
      onMouseLeave={closeSoon}
    >
      <button
        className="music-toggle"
        onClick={() => (open ? setOpen(false) : openNow())}
        title={open ? '收起播放器' : '打开播放器'}
        aria-expanded={open}
      >
        {playing ? '♫' : '♪'}
      </button>

      {open && (
        <div className="music-panel">
          <div className="music-now ellipsis" title={current ? label(current) : undefined}>
            {current ? label(current) : '选一首听'}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
            <button className="btn sm" onClick={() => play((index - 1 + tracks.length) % tracks.length)}>
              ⏮
            </button>
            <button className="btn sm primary" onClick={toggle}>
              {playing ? '⏸' : '▶'}
            </button>
            <button className="btn sm" onClick={() => play((index + 1) % tracks.length)}>
              ⏭
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            style={{ width: '100%', marginTop: 8 }}
          />
          <div className="row wrap" style={{ marginTop: 8 }}>
            <button
              className="btn sm"
              onClick={async () => {
                await api.musicImport()
                await load()
              }}
            >
              导入音乐
            </button>
            <button className="btn sm" onClick={() => api.musicOpenDir()}>
              打开目录
            </button>
          </div>

          <div className="music-list">
            <div className="mini-label" style={{ marginTop: 8 }}>
              内置
            </div>
            {BUILTIN.map((t, i) => (
              <div className={`music-item ${i === index ? 'on' : ''}`} key={t.src}>
                <span className="ellipsis" onClick={() => play(i)} style={{ cursor: 'pointer' }}>
                  {i === index && playing ? '▶ ' : ''}
                  {t.name}
                </span>
                <span className="badge">自带</span>
              </div>
            ))}
            {userTracks.length > 0 && (
              <div className="mini-label" style={{ marginTop: 8 }}>
                我的音乐
              </div>
            )}
            {userTracks.map((t, i0) => {
              const i = BUILTIN.length + i0
              return (
                <div className={`music-item ${i === index ? 'on' : ''}`} key={t.src}>
                  <span className="ellipsis" onClick={() => play(i)} style={{ cursor: 'pointer' }}>
                    {i === index && playing ? '▶ ' : ''}
                    {label(t)}
                  </span>
                  <button
                    className="chip-x"
                    onClick={async () => {
                      await api.musicRemove(t.file as string)
                      await load()
                      if (i === index) {
                        setPlaying(false)
                        setIndex(0)
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {userTracks.length === 0 && (
              <div className="muted small" style={{ marginTop: 6 }}>
                想把喜欢的曲子加进来：把 mp3/ogg 放进 data/music 或点「导入音乐」。
              </div>
            )}
          </div>
        </div>
      )}

      <audio
        ref={audioRef}
        onEnded={() => {
          if (tracks.length > 1) play((index + 1) % tracks.length)
          else setPlaying(false)
        }}
      />
    </div>
  )
}
