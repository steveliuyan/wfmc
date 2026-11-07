/**
 * 存档工坊（E 方向）
 *
 * 只改 level.dat 里白名单的那几个字段，改之前强制快照，改完复读校验。
 * 区块数据只统计不修改 —— 那是另一档风险。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { api, type LevelPatch, type SaveInspect, type SaveWorld } from '../api'
import { useLauncher } from '../store'

const GAME_MODES = ['生存', '创造', '冒险', '旁观']
const DIFFICULTIES = ['和平', '简单', '普通', '困难']

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const diff = Date.now() - ms
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60000))} 分钟前`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)} 小时前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function SaveWorkshop({ instanceId }: { instanceId: string }) {
  const { toast, askConfirm } = useLauncher()
  const [worlds, setWorlds] = useState<SaveWorld[]>([])
  const [pick, setPick] = useState('')
  const [info, setInfo] = useState<SaveInspect | null>(null)
  const [busy, setBusy] = useState('')

  const [levelName, setLevelName] = useState('')
  const [gameType, setGameType] = useState<number | ''>('')
  const [difficulty, setDifficulty] = useState<number | ''>('')
  const [allowCommands, setAllowCommands] = useState<boolean | null>(null)
  const [hardcore, setHardcore] = useState<boolean | null>(null)
  const [dayTime, setDayTime] = useState('')
  const [time, setTime] = useState('')

  const refresh = async () => {
    setBusy('list')
    try {
      const list = await api.saveWorlds(instanceId)
      setWorlds(list)
      if (list.length && !list.some((w) => w.folder === pick)) setPick(list[0].folder)
    } catch (e) {
      toast(`读存档列表失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    void refresh()
    // 换实例就重来
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId])

  useEffect(() => {
    if (!pick) {
      setInfo(null)
      return
    }
    let alive = true
    void (async () => {
      setBusy('inspect')
      try {
        const r = await api.inspectWorld(instanceId, pick)
        if (!alive) return
        setInfo(r)
        setLevelName(r.level?.levelName ?? '')
        setGameType(r.level?.gameType ?? '')
        setDifficulty(r.level?.difficulty ?? '')
        setAllowCommands(r.level?.allowCommands ?? null)
        setHardcore(r.level?.hardcore ?? null)
        setDayTime(r.level?.dayTime ?? '')
        setTime(r.level?.time ?? '')
      } catch (e) {
        if (alive) toast(`读世界信息失败：${(e as Error).message}`, 'error')
      } finally {
        if (alive) setBusy('')
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick, instanceId])

  const patch = useMemo<LevelPatch>(() => {
    const p: LevelPatch = {}
    if (info?.level) {
      if (levelName && levelName !== info.level.levelName) p.levelName = levelName
      if (gameType !== '' && gameType !== info.level.gameType) p.gameType = Number(gameType)
      if (difficulty !== '' && difficulty !== info.level.difficulty) p.difficulty = Number(difficulty)
      if (allowCommands !== null && allowCommands !== info.level.allowCommands) p.allowCommands = allowCommands
      if (hardcore !== null && hardcore !== info.level.hardcore) p.hardcore = hardcore
      if (dayTime !== '' && dayTime !== info.level.dayTime) p.dayTime = Number(dayTime)
      if (time !== '' && time !== info.level.time) p.time = Number(time)
    }
    return p
  }, [info, levelName, gameType, difficulty, allowCommands, hardcore, dayTime, time])

  const dirty = Object.keys(patch).length > 0

  const save = async () => {
    if (!pick || !dirty) return
    const ok = await askConfirm({
      title: '改存档',
      message: `要改「${info?.world.name ?? pick}」的 ${Object.keys(patch).length} 个字段。\n\n动手前会先把 level.dat 整份快照一份（存到 backups/levels/），改完还会读回来校验一遍；校验不过会自动还原。`
    })
    if (!ok) return
    setBusy('save')
    try {
      const r = await api.patchLevel(instanceId, pick, patch)
      if (r.changed.length) toast(`改好了：${r.changed.map((f) => f.replace('Data.', '')).join('、')}`, 'success')
      else toast('没有字段被改动', 'info')
      if (r.skipped.length) toast(`${r.skipped.length} 项没改：${r.skipped[0].reason}`, 'info')
      const again = await api.inspectWorld(instanceId, pick)
      setInfo(again)
    } catch (e) {
      toast(`${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const snap = async () => {
    if (!pick) return
    setBusy('snap')
    try {
      const file = await api.snapshotLevel(instanceId, pick)
      toast(`快照已保存：${file}`, 'success')
      void api.revealBackup(file)
    } catch (e) {
      toast(`快照失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const editable = new Set(info?.editable ?? [])
  const has = (f: string) => editable.has(f)

  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>存档工坊</h3>
        <button className="btn" onClick={refresh} disabled={busy === 'list'}>
          {busy === 'list' ? '读取中…' : '刷新'}
        </button>
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        只改白名单字段（世界名 / 游戏模式 / 难度 / 作弊 / 硬核 / 时间），改前自动快照，改完复读校验。区块文件只统计不改。
      </div>

      {!worlds.length && <div className="muted small">这个实例还没有存档。</div>}

      {!!worlds.length && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {worlds.map((w) => (
              <button
                key={w.folder}
                className={'btn' + (pick === w.folder ? ' primary' : '')}
                onClick={() => setPick(w.folder)}
                title={w.folder}
              >
                {w.name}
                <span className="muted small"> · {fmtBytes(w.bytes)}</span>
              </button>
            ))}
          </div>

          {pick && info && (
            <div className="card inner" style={{ marginTop: 12 }}>
              <div className="mini-label">世界信息</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
                <div className="stat">
                  <span>文件夹</span>
                  <b>{info.world.folder}</b>
                </div>
                <div className="stat">
                  <span>大小</span>
                  <b>{fmtBytes(info.world.bytes)}</b>
                </div>
                <div className="stat">
                  <span>文件数</span>
                  <b>{info.world.files}</b>
                </div>
                <div className="stat">
                  <span>最后改动</span>
                  <b>{fmtTime(info.world.mtime)}</b>
                </div>
                {info.level?.versionName && (
                  <div className="stat">
                    <span>游戏版本</span>
                    <b>{info.level.versionName}</b>
                  </div>
                )}
                {info.raw && (
                  <div className="stat">
                    <span>level.dat</span>
                    <b>
                      {fmtBytes(info.raw.bytes)} · {info.raw.compression}
                    </b>
                  </div>
                )}
              </div>
              {info.raw && <div className="muted small" style={{ marginTop: 6 }}>sha1 {info.raw.sha1}</div>}

              <div className="mini-label" style={{ marginTop: 12 }}>可改字段（只列存档里真有的）</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10, marginTop: 6, alignItems: 'flex-end' }}>
                <label>
                  世界名
                  <input
                    value={levelName}
                    disabled={!has('Data.LevelName')}
                    onChange={(e) => setLevelName(e.target.value)}
                  />
                </label>
                <label>
                  游戏模式
                  <select
                    value={gameType}
                    disabled={!has('Data.GameType')}
                    onChange={(e) => setGameType(e.target.value === '' ? '' : Number(e.target.value))}
                  >
                    <option value="">不变</option>
                    {GAME_MODES.map((m, i) => (
                      <option key={m} value={i}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  难度
                  <select
                    value={difficulty}
                    disabled={!has('Data.Difficulty')}
                    onChange={(e) => setDifficulty(e.target.value === '' ? '' : Number(e.target.value))}
                  >
                    <option value="">不变</option>
                    {DIFFICULTIES.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  DayTime
                  <input
                    value={dayTime}
                    disabled={!has('Data.DayTime')}
                    onChange={(e) => setDayTime(e.target.value.replace(/[^\d-]/g, ''))}
                    style={{ width: 110 }}
                  />
                </label>
                <label>
                  Time
                  <input
                    value={time}
                    disabled={!has('Data.Time')}
                    onChange={(e) => setTime(e.target.value.replace(/[^\d-]/g, ''))}
                    style={{ width: 110 }}
                  />
                </label>
                <label className="row" style={{ alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={!!allowCommands}
                    disabled={!has('Data.allowCommands')}
                    onChange={(e) => setAllowCommands(e.target.checked)}
                  />
                  允许作弊
                </label>
                <label className="row" style={{ alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={!!hardcore}
                    disabled={!has('Data.hardcore')}
                    onChange={(e) => setHardcore(e.target.checked)}
                  />
                  硬核
                </label>
              </div>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" disabled={!dirty || busy === 'save'} onClick={save}>
                  {busy === 'save' ? '保存中…' : dirty ? `保存 ${Object.keys(patch).length} 项改动` : '没有改动'}
                </button>
                <button className="btn" disabled={busy === 'snap'} onClick={snap}>
                  打个快照
                </button>
                <span className="muted small">改之前会自动快照，这个按钮只是你想多留一份时用</span>
              </div>

              {!!info.regions.length && (
                <>
                  <div className="mini-label" style={{ marginTop: 12 }}>
                    区块文件（{info.regions.length} 个 · 共{' '}
                    {fmtBytes(info.regions.reduce((s, r) => s + r.bytes, 0))}）
                  </div>
                  <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18, maxHeight: 140, overflow: 'auto' }}>
                    {info.regions.slice(0, 40).map((r) => (
                      <li key={r.name}>
                        {r.name} · {fmtBytes(r.bytes)} · {r.chunks} 个区块 · {fmtTime(r.mtime)}
                      </li>
                    ))}
                    {info.regions.length > 40 && <li>…还有 {info.regions.length - 40} 个</li>}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
