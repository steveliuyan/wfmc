import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'

// 自带曲目：程序合成的原创环境音乐（scripts/gen-music.py 合成 wav → ffmpeg 转 ogg，脚本随源码公开，
// 所以能追溯来源）。**不是** Minecraft 原版配乐：原版音乐版权在 C418 / Mojang 手里，不能打包分发。
// 想听原版就自己放文件进来（「导入音乐」或丢进 data/music），导入的曲子只在你自己电脑上播。
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

/** 播放音量固定 0.7：音量交给系统音量键，播放器里不再放音量条 */
const FIXED_VOLUME = 0.7

/** 秒 → m:ss */
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '--:--'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 悬浮音乐播放器：内置 4 首合成环境音乐，也能听 dataDir/music 里自己导入的 */
export default function MusicPlayer({ inline = false }: { inline?: boolean }) {
  const [userTracks, setUserTracks] = useState<Track[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('music') === 'open')
  // 播放进度（秒）：这才是进度条该显示的东西，不是音量
  const [cur, setCur] = useState(0)
  const [dur, setDur] = useState(0)
  // 拖动时先跟手（别被 timeupdate 拽回去），松手后再交还给音频时间
  const [dragging, setDragging] = useState(false)
  const [dragVal, setDragVal] = useState(0)
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
    if (audio) audio.volume = FIXED_VOLUME
  }, [])

  const current = tracks[index]

  const play = async (i?: number) => {
    const audio = audioRef.current
    if (!audio) return
    const target = typeof i === 'number' ? i : index
    if (typeof i === 'number') setIndex(i)
    const track = tracks[target]
    if (!track) return
    audio.src = track.src
    setCur(0)
    setDur(0)
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

  const seek = (v: number) => {
    const audio = audioRef.current
    if (!audio) return
    setCur(v)
    setDragVal(v)
    try {
      audio.currentTime = v
    } catch {
      /* 元数据还没到时设 currentTime 会抛，忽略即可 */
    }
  }

  const label = (t: Track) => (t.builtin ? t.name : t.name.replace(/\.[^.]+$/, ''))

  return (
    <div
      className={`music ${open ? 'open' : ''} ${inline ? 'inline' : ''}`}
      onMouseEnter={cancelClose}
      onMouseLeave={() => {
        // 正在拖进度条的时候别收回面板，否则拖到一半就没了
        if (dragging) return
        closeSoon()
      }}
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

          {/* 播放进度条：拖到哪就从哪放（音量请在系统里调） */}
          <div className="music-seek">
            <input
              type="range"
              min={0}
              max={dur > 0 ? dur : 1}
              step={0.1}
              value={dragging ? dragVal : Math.min(cur, dur > 0 ? dur : 0)}
              disabled={dur <= 0}
              onPointerDown={() => {
                cancelClose()
                setDragVal(cur)
                setDragging(true)
              }}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onBlur={() => setDragging(false)}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="播放进度"
            />
            <div className="music-time muted small">
              <span>{fmtTime(dragging ? dragVal : cur)}</span>
              <span>{dur > 0 ? fmtTime(dur) : '--:--'}</span>
            </div>
          </div>

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
            <div className="muted small" style={{ marginTop: 4, opacity: 0.75 }}>
              出处：内置曲为程序合成原创（scripts/gen-music.py），非 Minecraft 原版配乐。
            </div>
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
        onTimeUpdate={(e) => {
          if (!dragging) setCur(e.currentTarget.currentTime || 0)
        }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          setDur(Number.isFinite(a.duration) ? a.duration : 0)
          setCur(a.currentTime || 0)
        }}
        onDurationChange={(e) => {
          const a = e.currentTarget
          setDur(Number.isFinite(a.duration) ? a.duration : 0)
        }}
        onEnded={() => {
          if (tracks.length > 1) play((index + 1) % tracks.length)
          else setPlaying(false)
        }}
      />
    </div>
  )
}
