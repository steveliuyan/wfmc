/**
 * 联机 2.0：房间环境清单（B 方向）
 *
 * 房主：把「进这服要哪些 mod」压成一段短码发出去。
 * 好友：粘进来 → 看到缺什么 / 哪个不一样 / 多什么 → 一键补齐（只增不删，下完校验 sha1）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { api, type RoomManifestDiff, type RoomManifestPayload } from '../api'
import { useLauncher } from '../store'

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export default function RoomManifestCard({
  instanceId,
  instanceName,
  defaultHost,
  defaultPort
}: {
  instanceId?: string
  instanceName?: string
  defaultHost?: string
  defaultPort?: number
}) {
  const { toast, askConfirm } = useLauncher()
  const [code, setCode] = useState('')
  const [summary, setSummary] = useState<{ mods: number; bytes: number } | null>(null)

  const [input, setInput] = useState('')
  const [addr, setAddr] = useState('')
  const [payload, setPayload] = useState<RoomManifestPayload | null>(null)
  const [diff, setDiff] = useState<RoomManifestDiff | null>(null)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const addrTouched = useRef(false)

  // 默认拿「游戏端口 + 1」（房主侧清单服务就起在那）拼地址，用户改过就不覆盖
  useEffect(() => {
    if (addrTouched.current) return
    if (defaultHost && defaultPort) setAddr(`http://${defaultHost}:${defaultPort + 1}`)
  }, [defaultHost, defaultPort])

  useEffect(() => {
    const off = api.onRoomManifestProgress((p) => {
      setProgress(p.total ? { done: p.done, total: p.total } : null)
    })
    return off
  }, [])

  const gen = async () => {
    if (!instanceId) return toast('先在左侧选一个实例（发出去的就是它的 mods 清单）', 'error')
    setBusy('gen')
    try {
      const r = await api.roomManifest(instanceId)
      setCode(r.code)
      setSummary({ mods: r.payload.mods.length, bytes: r.payload.mods.reduce((s, m) => s + (m.size || 0), 0) })
      toast(`清单码已生成：${r.payload.mods.length} 个 mod`, 'success')
    } catch (e) {
      toast(`生成失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const parse = async () => {
    const text = input.trim()
    if (!text) return
    setBusy('parse')
    setDiff(null)
    try {
      const p = await api.roomManifestParse(text)
      setPayload(p)
      if (!instanceId) {
        toast('清单解析好了，但要先在左侧选一个实例才能比对', 'info')
        return
      }
      const d = await api.roomManifestDiff(instanceId, p)
      setDiff(d)
      if (d.refuse) toast(d.refuse, 'error')
      else if (!d.missing.length && !d.mismatch.length) toast('环境已经对上了，直接进服就行', 'success')
      else toast(`缺 ${d.missing.length} 个、版本对不上 ${d.mismatch.length} 个`, 'info')
    } catch (e) {
      toast(`${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const fix = async () => {
    if (!payload || !diff || !instanceId) return
    const base = addr.trim()
    if (!base) return toast('填一下房主的清单服务地址（一般是 http://对方IP:游戏端口+1）', 'error')
    if (diff.needsConfirm) {
      const ok = await askConfirm({
        title: '要下载的东西有点多',
        message: `要下载 ${fmtBytes(diff.downloadBytes)}（${diff.missing.length + diff.mismatch.length} 个文件）。\n\n超过 500MB 会占不少时间和硬盘，确定现在下？\n\n地址：${base}`
      })
      if (!ok) return
    }
    setBusy('fix')
    setProgress({ done: 0, total: diff.downloadBytes })
    try {
      const r = await api.roomManifestFix(instanceId, payload, base)
      if (r.errors.length) {
        toast(`下了 ${r.downloaded} 个（${fmtBytes(r.bytes)}），有 ${r.errors.length} 个失败：${r.errors[0].file} —— ${r.errors[0].message}`, 'error')
      } else {
        toast(`补齐完成：${r.downloaded} 个文件（${fmtBytes(r.bytes)}）`, 'success')
      }
      const d = await api.roomManifestDiff(instanceId, payload)
      setDiff(d)
    } catch (e) {
      toast(`补齐失败：${(e as Error).message}`, 'error')
    } finally {
      setBusy('')
      setProgress(null)
    }
  }

  const pending = diff ? diff.missing.length + diff.mismatch.length : 0

  return (
    <div className="card">
      <h3>房间环境清单</h3>
      <div className="muted small" style={{ marginBottom: 10 }}>
        把版本 / 加载器 / mod 清单压成一段码发好友，对方粘进来就能看到缺什么、一键补齐（只往你这边加，不会删你的 mod）。
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="mini-label">我是房主 · 发清单</div>
          <div className="muted small" style={{ margin: '4px 0 8px' }}>
            当前实例：{instanceName ?? '未选'}
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy === 'gen' || !instanceId} onClick={gen}>
              {busy === 'gen' ? '生成中…' : '生成清单码'}
            </button>
            {code && (
              <button
                className="btn"
                onClick={() => {
                  navigator.clipboard.writeText(code)
                  toast('清单码已复制，发给好友就行', 'success')
                }}
              >
                复制
              </button>
            )}
          </div>
          {code && (
            <div className="card inner" style={{ marginTop: 8 }}>
              <div className="mini-label">
                {summary ? `${summary.mods} 个 mod · ${fmtBytes(summary.bytes)}` : '清单'}
              </div>
              <textarea readOnly value={code} rows={3} style={{ width: '100%', fontSize: 12 }} />
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 280 }}>
          <div className="mini-label">我是好友 · 补环境</div>
          <textarea
            placeholder="把房主发的清单码粘到这里（WFMC1: 开头）"
            rows={3}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setPayload(null)
              setDiff(null)
            }}
            style={{ width: '100%', fontSize: 12, marginTop: 4 }}
          />
          <label style={{ marginTop: 8 }}>
            房主清单服务地址（补齐用）
            <input
              placeholder="http://192.168.1.5:25566"
              value={addr}
              onChange={(e) => {
                addrTouched.current = true
                setAddr(e.target.value)
              }}
            />
          </label>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn primary" disabled={busy === 'parse' || !input.trim()} onClick={parse}>
              {busy === 'parse' ? '比对中…' : '比对一下'}
            </button>
            {diff && pending > 0 && !diff.refuse && (
              <button className="btn" disabled={busy === 'fix'} onClick={fix}>
                {busy === 'fix' ? '下载中…' : `补齐缺的（${pending} 个 · ${fmtBytes(diff.downloadBytes)}）`}
              </button>
            )}
          </div>
          {progress && (
            <div className="muted small" style={{ marginTop: 6 }}>
              已下载 {fmtBytes(progress.done)} / {fmtBytes(progress.total)}
            </div>
          )}
        </div>
      </div>

      {payload && (
        <div className="card inner" style={{ marginTop: 12 }}>
          <div className="mini-label">房间环境</div>
          <div className="muted small">
            {payload.name} · {payload.mcVersion} · {payload.loader}
            {payload.loaderVersion ? ' ' + payload.loaderVersion : ''} · {payload.mods.length} 个 mod
          </div>
          {diff?.refuse && (
            <div style={{ marginTop: 8, color: 'var(--danger, #c0392b)' }}>{diff.refuse}</div>
          )}
          {diff && !diff.refuse && (
            <div style={{ marginTop: 8 }}>
              <div className="small">
                缺 <b>{diff.missing.length}</b> 个 · 版本不一样 <b>{diff.mismatch.length}</b> 个 · 多出来{' '}
                <b>{diff.extra.length}</b> 个
              </div>
              {!!diff.missing.length && (
                <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {diff.missing.slice(0, 8).map((m) => (
                    <li key={m.file}>
                      缺 {m.file}（{fmtBytes(m.size)}）
                    </li>
                  ))}
                  {diff.missing.length > 8 && <li>…还有 {diff.missing.length - 8} 个</li>}
                </ul>
              )}
              {!!diff.mismatch.length && (
                <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {diff.mismatch.slice(0, 8).map((m) => (
                    <li key={m.want.file}>同名不同内容：{m.want.file}（会换成房间那份，旧文件留备份）</li>
                  ))}
                  {diff.mismatch.length > 8 && <li>…还有 {diff.mismatch.length - 8} 个</li>}
                </ul>
              )}
              {!!diff.manual.length && (
                <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {diff.manual.map((m, i) => (
                    <li key={i}>
                      {m.title} —— {m.reason}
                    </li>
                  ))}
                </ul>
              )}
              {!pending && <div className="muted small" style={{ marginTop: 6 }}>没缺什么了，直接进服试试。</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
