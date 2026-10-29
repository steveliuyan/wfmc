import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'

interface Track {
  name: string
  path: string
  size: number
}

/** 悬浮音乐播放器：歌单来自 dataDir/music，点一下就能边玩边听 */
export default function MusicPlayer({ inline = false }: { inline?: boolean }) {
  const [tracks, setTracks] = useState<Track[]>([])
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [open, setOpen] = useState(() => new URLSearchParams(window.location.search).get('music') === 'open')
  const [volume, setVolume] = useState(0.7)
  const audioRef = useRef<HTMLAudioElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)

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

  const load = async () => setTracks(await api.musicList())

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
    audio.src = `file://${track.path.replace(/\\/g, '/')}`
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
          <div className="music-now ellipsis" title={current?.name}>
            {current ? current.name.replace(/\.[^.]+$/, '') : '还没导入音乐'}
          </div>
          <div className="row" style={{ justifyContent: 'center', gap: 6 }}>
            <button
              className="btn sm"
              disabled={tracks.length === 0}
              onClick={() => play((index - 1 + tracks.length) % Math.max(tracks.length, 1))}
            >
              ⏮
            </button>
            <button className="btn sm primary" disabled={tracks.length === 0} onClick={toggle}>
              {playing ? '⏸' : '▶'}
            </button>
            <button
              className="btn sm"
              disabled={tracks.length === 0}
              onClick={() => play((index + 1) % Math.max(tracks.length, 1))}
            >
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
                setTracks(await api.musicImport())
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
            {tracks.length === 0 && (
              <div className="muted small">把 mp3/ogg 放进 data/music 或点「导入音乐」。</div>
            )}
            {tracks.map((t, i) => (
              <div className={`music-item ${i === index ? 'on' : ''}`} key={t.path}>
                <span className="ellipsis" onClick={() => play(i)} style={{ cursor: 'pointer' }}>
                  {i === index && playing ? '▶ ' : ''}
                  {t.name.replace(/\.[^.]+$/, '')}
                </span>
                <button
                  className="chip-x"
                  onClick={async () => {
                    setTracks(await api.musicRemove(t.name))
                    if (i === index) setPlaying(false)
                  }}
                >
                  ×
                </button>
              </div>
            ))}
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
