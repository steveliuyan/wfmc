import React, { useEffect, useMemo, useState } from 'react'
import { api, friendlyError, type ReleaseCheck, type ReleaseInfo } from '../api'
import { useLauncher, useT } from '../store'

/**
 * 更新中心：启动时自动检查、有新版本时漂亮展示、可翻历史版本。
 * 数据来自 settings.updateUrl（GitHub 仓库 `用户名/仓库名` 或 releases 地址）。
 */

function fmtSize(bytes: number): string {
  if (!bytes) return ''
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 行内格式：**粗体**、`代码`、[文字](链接) */
function RichText({ text }: { text: string }) {
  const parts: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) parts.push(<b key={key++}>{tok.slice(2, -2)}</b>)
    else if (tok.startsWith('`')) parts.push(<code key={key++}>{tok.slice(1, -1)}</code>)
    else {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (mm)
        parts.push(
          <a
            key={key++}
            href={mm[2]}
            onClick={(e) => {
              e.preventDefault()
              api.openExternal(mm[2])
            }}
          >
            {mm[1]}
          </a>
        )
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** markdown 说明 → 排版（标题 / 列表 / 表格 / 代码块 / 段落） */
function Notes({ text }: { text: string }) {
  const blocks = useMemo(() => {
    type Block =
      | { kind: 'h'; text: string }
      | { kind: 'li'; text: string }
      | { kind: 'p'; text: string }
      | { kind: 'code'; text: string }
      | { kind: 'table'; rows: string[][] }
    const lines = (text || "").replace(/\r/g, "").split("\n")
    const out: Block[] = []
    let inCode = false
    let codeBuf: string[] = []
    let tableBuf: string[] = []

    const flushTable = () => {
      if (tableBuf.length === 0) return
      const rows = tableBuf
        .filter((l) => !/^\|[\s:|-]+\|$/.test(l.trim()))
        .map((l) =>
          l
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((c) => c.trim())
        )
      if (rows.length) out.push({ kind: 'table', rows })
      tableBuf = []
    }

    for (const raw of lines) {
      const line = raw.trimEnd()
      if (line.trim().startsWith('```')) {
        flushTable()
        if (inCode) {
          out.push({ kind: 'code', text: codeBuf.join('\n') })
          codeBuf = []
        }
        inCode = !inCode
        continue
      }
      if (inCode) {
        codeBuf.push(line)
        continue
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        tableBuf.push(line)
        continue
      }
      flushTable()
      if (!line.trim()) continue
      if (/^#{1,6}\s/.test(line)) out.push({ kind: 'h', text: line.replace(/^#{1,6}\s*/, '') })
      else if (/^[-*+]\s/.test(line)) out.push({ kind: 'li', text: line.replace(/^[-*+]\s*/, '') })
      else out.push({ kind: 'p', text: line })
    }
    flushTable()
    if (codeBuf.length) out.push({ kind: 'code', text: codeBuf.join('\n') })
    return out
  }, [text])

  if (!text) return <p className="muted small">这个版本没有写更新说明。</p>

  return (
    <div className="rel-notes">
      {blocks.map((b, i) => {
        if (b.kind === 'h') return <h4 key={i}><RichText text={b.text} /></h4>
        if (b.kind === 'li')
          return (
            <div className="rel-li" key={i}>
              <RichText text={b.text} />
            </div>
          )
        if (b.kind === 'code') return <pre key={i}>{b.text}</pre>
        if (b.kind === 'table')
          return (
            <table className="rel-table" key={i}>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) =>
                      r === 0 ? <th key={c}><RichText text={cell} /></th> : <td key={c}><RichText text={cell} /></td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        return (
          <p key={i}>
            <RichText text={b.text} />
          </p>
        )
      })}
    </div>
  )
}

export default function UpdateCenter() {
  const { settings, saveSettings, toast } = useLauncher()
  const t = useT()
  const [data, setData] = useState<ReleaseCheck | undefined>()
  const [busy, setBusy] = useState<'check' | 'install' | ''>('')
  const [openHistory, setOpenHistory] = useState(false)
  const [expanded, setExpanded] = useState<string | undefined>()
  const [auto, setAuto] = useState(settings?.autoCheckUpdate ?? true)
  const [url, setUrl] = useState(settings?.updateUrl ?? '')

  const check = async (silent = false) => {
    setBusy('check')
    try {
      const res = await api.checkReleases()
      setData(res)
      if (!silent) {
        if (res.error) toast(res.error, 'error')
        else if (res.hasUpdate && res.latest) toast(`发现新版本 ${res.latest.version}`, 'success')
        else toast('已经是最新版本', 'success')
      }
    } catch (e) {
      if (!silent) toast(`检查更新失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy('')
    }
  }

  useEffect(() => {
    if (settings?.updateUrl) check(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.updateUrl])

  const install = async (rel: ReleaseInfo) => {
    setBusy('install')
    try {
      await api.applyRelease(rel)
      toast('开始下载新版本，完成后会自动替换并重启', 'success')
    } catch (e) {
      toast(`更新失败：${friendlyError(e)}`, 'error')
    } finally {
      setBusy('')
    }
  }

  const latest = data?.latest
  const history = data?.history ?? []

  return (
    <div className="card update-center">
      <div className="upd-head">
        <div>
          <h3 style={{ margin: 0 }}>{t('检查更新', 'Check for updates')}</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            {t('当前版本', 'Current version')} <b>{data?.current ?? '1.0.0'}</b>
            {data?.source === 'github' && data.history.length > 0 && (
              <> · {t('已发布', 'published')} {data.history.length} {t('个版本', 'releases')}</>
            )}
          </p>
        </div>
        <div className="row">
          <button className="btn sm" disabled={busy !== ''} onClick={() => check(false)}>
            {busy === 'check' ? t('检查中…', 'Checking…') : t('立即检查', 'Check now')}
          </button>
        </div>
      </div>

      {data?.error && <div className="inline-notice">{data.error}</div>}

      {latest && data?.hasUpdate && (
        <div className="upd-hero">
          <div className="upd-hero-glow" />
          <div className="upd-hero-main">
            <div className="upd-badge">{t('新版本可用', 'Update available')}</div>
            <div className="upd-version">
              <span className="upd-old">v{data.current}</span>
              <span className="upd-arrow">→</span>
              <span className="upd-new">v{latest.version}</span>
            </div>
            <div className="upd-meta">
              {latest.publishedAt && <span>{fmtDate(latest.publishedAt)}</span>}
              {latest.assets.length > 0 && <span>{latest.assets.length} {t('个安装包', 'assets')}</span>}
              {latest.prerelease && <span className="upd-pre">pre-release</span>}
            </div>
          </div>
          <div className="upd-hero-actions">
            <button className="btn primary" disabled={busy !== ''} onClick={() => install(latest)}>
              {busy === 'install' ? t('准备下载…', 'Preparing…') : t('下载并安装', 'Download & install')}
            </button>
            <button className="btn sm ghost" onClick={() => setOpenHistory((v) => !v)}>
              {openHistory ? t('收起历史版本', 'Hide versions') : t('查看历史版本', 'Version history')}
            </button>
          </div>
        </div>
      )}

      {latest && !data?.hasUpdate && !data?.error && (
        <div className="upd-latest">
          <span className="dot-ok" />
          {t('已经是最新版本', 'You are up to date')}
          {latest.version && <span className="muted small"> · v{latest.version}</span>}
        </div>
      )}

      {latest && (data?.hasUpdate || openHistory) && (
        <div className="upd-notes-wrap">
          <div className="mini-label">{t('更新内容', "What's new")} · v{latest.version}</div>
          <Notes text={latest.notes} />
        </div>
      )}

      {openHistory && history.length > 0 && (
        <div className="upd-history">
          <div className="mini-label">{t('历史版本', 'All versions')}</div>
          <div className="rel-timeline">
            {history.map((r) => {
              const isOpen = expanded === r.version
              return (
                <div className={`rel-item ${isOpen ? 'open' : ''}`} key={r.tag}>
                  <button className="rel-row" onClick={() => setExpanded(isOpen ? undefined : r.version)}>
                    <span className="rel-ver">v{r.version}</span>
                    <span className="rel-date">{fmtDate(r.publishedAt)}</span>
                    <span className="rel-tags">
                      {r.version === latest?.version && <span className="pill on">{t('最新', 'latest')}</span>}
                      {r.prerelease && <span className="pill">pre</span>}
                      {r.version === data?.current && <span className="pill">{t('当前', 'current')}</span>}
                    </span>
                    <span className="rel-caret">{isOpen ? '▴' : '▾'}</span>
                  </button>
                  {isOpen && (
                    <div className="rel-body">
                      <Notes text={r.notes} />
                      {r.assets.length > 0 && (
                        <div className="rel-assets">
                          {r.assets
                            .filter((a) => a.name.endsWith('.exe') || a.name.endsWith('.zip'))
                            .map((a) => (
                              <button
                                key={a.name}
                                className="btn sm"
                                onClick={() => api.openExternal(a.url)}
                                title={a.url}
                              >
                                {a.name.replace(/^WFMC-/, '')} {a.size ? `· ${fmtSize(a.size)}` : ''}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="upd-config">
        <label className="full">
          {t('更新源', 'Update source')}
          <input
            value={url}
            placeholder="steveliuyan/wfmc"
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => saveSettings({ updateUrl: url.trim() })}
          />
        </label>
        <div className="row wrap" style={{ alignItems: 'center' }}>
          <button
            className={`chip ${auto ? 'on' : ''}`}
            onClick={() => {
              setAuto(!auto)
              saveSettings({ autoCheckUpdate: !auto })
            }}
          >
            {t('开机自动检查更新', 'Check for updates at startup')}
          </button>
          <span className="muted small">
            {t('支持 GitHub Releases，填「用户名/仓库名」或 releases 地址', 'Works with GitHub Releases: a user/repo or a releases URL')}
          </span>
        </div>
      </div>
    </div>
  )
}
