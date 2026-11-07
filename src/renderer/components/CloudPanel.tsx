import React, { useCallback, useEffect, useState } from 'react'
import { api, formatSize, friendlyError } from '../api'
import { useLauncher } from '../store'
import type { CloudBackup, CloudSettings, CloudStatus, StorageKind } from '../../shared/types'

/**
 * 备份面板（本地优先）。
 *
 * 这一块**只有 UI**：所有网络请求都在主进程（cloudsync.ts → storage/* / cloudsnap.ts），
 * 登录令牌、WebDAV 密码永远不进渲染层。
 *
 * 顺序刻意做成「本地在前、账号在后」：
 *   1. 备份**永远先存本地**，本机目录可换（也能指向 OneDrive 之类的同步盘）
 *   2. 登录统一账号之后，同一次备份会顺带往云端传一份（多一份保险，不是替代）
 *   3. 保留份数由服务器统一定（自动 3 / 手动 5），客户端只读，不提供输入框
 *   4. 服务器地址不显示也不可改 —— 对用户来说这里就是「我的账号」
 */
const STORAGE_CHOICES: { kind: StorageKind; label: string; hint: string }[] = [
  { kind: 'local', label: '本地文件夹（推荐）', hint: '存本机任何目录；指向 OneDrive / 坚果云同步目录就等于自动上云' },
  { kind: 'webdav', label: '我自己的 WebDAV 网盘', hint: '坚果云 / Nextcloud / 群晖 / InfiniCLOUD 都行，用你自己的账号' }
]

export default function CloudPanel() {
  const { toast } = useLauncher()
  const [cfg, setCfg] = useState<CloudSettings | null>(null)
  const [status, setStatus] = useState<CloudStatus | null>(null)
  const [localBackups, setLocalBackups] = useState<CloudBackup[]>([])
  const [cloudBackups, setCloudBackups] = useState<CloudBackup[]>([])
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  // WebDAV 表单（密码单独放：主进程加密存，渲染层只负责递过去）
  const [wd, setWd] = useState({ url: '', username: '', dir: '', password: '' })
  const [localDir, setLocalDir] = useState('')

  const storage: StorageKind = cfg?.storage === 'webdav' ? 'webdav' : 'local'
  const loggedIn = !!status?.account?.loggedIn

  const refresh = useCallback(async () => {
    try {
      const s = await api.cloudStatus()
      setStatus(s)
      setLocalBackups(s.localBackups ?? [])
      setCloudBackups(s.backups ?? [])
    } catch (e) {
      setStatus({ configured: false, hasToken: false, backups: [], error: friendlyError(e) })
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const c = await api.cloudSettings()
      const next: CloudSettings =
        c ?? { enabled: true, storage: 'local', autoBackup: true, intervalH: 6, announcements: true }
      setCfg({ ...next, storage: next.storage === 'webdav' ? 'webdav' : 'local' })
      setWd({
        url: next.webdav?.url ?? '',
        username: next.webdav?.username ?? '',
        dir: next.webdav?.dir ?? '',
        password: ''
      })
      setLocalDir(next.localDir ?? '')
      await refresh()
    })()
  }, [refresh])

  const save = async (patch: Partial<CloudSettings>) => {
    if (!cfg) return
    setCfg({ ...cfg, ...patch })
    try {
      setCfg(await api.saveCloudSettings(patch))
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
    // 换了备份位置之后状态栏（当前放在 / 备份列表）必须跟着换
    await refresh()
  }

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key)
    try {
      setMsg(await fn())
    } catch (e) {
      const m = friendlyError(e)
      setMsg(m)
      toast(m, 'error')
    } finally {
      setBusy('')
      await refresh()
    }
  }

  /** WebDAV 参数保存（密码留空 = 不改） */
  const saveWebdav = async (patch: Partial<typeof wd>) => {
    const next = { ...wd, ...patch }
    setWd(next)
    try {
      setCfg(
        await api.saveWebdav({
          url: next.url,
          username: next.username,
          dir: next.dir,
          password: next.password || undefined
        })
      )
      setWd({ ...next, password: '' })
      await refresh()
    } catch (e) {
      toast(friendlyError(e), 'error')
    }
  }

  if (!cfg) return <p className="set-note">读取设置…</p>

  const manualKeep = status?.limits?.manualKeep ?? 5
  const autoKeep = status?.limits?.autoKeep ?? 3

  return (
    <>
      <div className="set-head">
        <div className="set-icon">⛁</div>
        <div className="set-titles">
          <div className="set-title">备份</div>
          <div className="set-desc">
            把设置、账号列表、服务器列表和实例信息打成一个配置包备份起来，换电脑时一键还原。
            <b>每次都先存本地</b>，所以没登录、没网也不影响你有备份；
            想多一份保险就登录账号，同一份备份会顺带存到云端（云端留最近几份由服务器统一管理）。
            登录令牌不上传（换了机器本来也解不开），还原后需要重新登录一次。
          </div>
        </div>
      </div>

      {/* ------------------------------------------------ 备份位置（本地优先） */}
      <div className="set-block">
        <div className="set-block-title">
          本地备份位置
          <span className={status?.storageTarget ? 'cloud-badge ok' : 'cloud-badge'}>
            {status?.storageLabel ?? '本地文件夹'}
          </span>
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          {STORAGE_CHOICES.map((c) => (
            <button
              key={c.kind}
              className={`chip ${storage === c.kind ? 'on' : ''}`}
              onClick={() => void save({ storage: c.kind })}
            >
              {c.label}
            </button>
          ))}
        </div>
        <p className="set-note" style={{ marginTop: 0 }}>
          {STORAGE_CHOICES.find((c) => c.kind === storage)?.hint}
        </p>

        {/* WebDAV 参数 */}
        {storage === 'webdav' && (
          <div className="set-grid">
            <label className="full">
              WebDAV 地址
              <input
                type="text"
                value={wd.url}
                placeholder="https://dav.jianguoyun.com/dav"
                spellCheck={false}
                onChange={(e) => setWd({ ...wd, url: e.target.value })}
                onBlur={() => void saveWebdav({ url: wd.url })}
              />
            </label>
            <label>
              账号
              <input
                type="text"
                value={wd.username}
                placeholder="坚果云就是你的登录邮箱"
                spellCheck={false}
                onChange={(e) => setWd({ ...wd, username: e.target.value })}
                onBlur={() => void saveWebdav({ username: wd.username })}
              />
            </label>
            <label>
              密码
              <input
                type="password"
                value={wd.password}
                placeholder={status?.webdavHasPass ? '已保存（留空不改）' : '应用密码'}
                onChange={(e) => setWd({ ...wd, password: e.target.value })}
                onBlur={() => {
                  if (wd.password) void saveWebdav({ password: wd.password })
                }}
              />
            </label>
            <label className="full">
              存放目录（远端）
              <input
                type="text"
                value={wd.dir}
                placeholder="默认 /wfmc（不存在会自动建）"
                spellCheck={false}
                onChange={(e) => setWd({ ...wd, dir: e.target.value })}
                onBlur={() => void saveWebdav({ dir: wd.dir })}
              />
            </label>
            <p className="set-note full" style={{ margin: 0 }}>
              坚果云要用「账户信息 → 安全选项 → 添加应用」生成的<b>应用密码</b>，登录密码不行。
              Nextcloud / 群晖的地址一般要带 <code>/remote.php/dav/files/用户名</code>。
              密码用系统凭据加密存在本机，不会进配置包。
            </p>
          </div>
        )}

        {/* 本地文件夹参数 */}
        {storage === 'local' && (
          <div className="key-row">
            <input
              type="text"
              value={localDir}
              placeholder="留空 = 启动器数据目录下的 backups"
              spellCheck={false}
              onChange={(e) => setLocalDir(e.target.value)}
              onBlur={() =>
                void run('localdir', async () => {
                  setCfg(await api.saveLocalDir(localDir))
                  return localDir ? `备份将存到 ${localDir}` : '已恢复默认目录'
                })
              }
            />
            <button
              className="btn sm"
              disabled={busy === 'pick'}
              onClick={() =>
                void run('pick', async () => {
                  const dir = await api.pickLocalDir()
                  if (!dir) return '已取消'
                  setLocalDir(dir)
                  return `备份将存到 ${dir}`
                })
              }
            >
              {busy === 'pick' ? '选择中…' : '选择文件夹'}
            </button>
          </div>
        )}

        <div className="set-actions" style={{ marginTop: 10 }}>
          <button
            className="btn sm"
            disabled={busy === 'stest'}
            onClick={() =>
              void run('stest', async () => {
                const r = await api.storageTest()
                toast(r.message, r.ok ? 'success' : 'error')
                return r.message
              })
            }
          >
            {busy === 'stest' ? '测试中…' : '测试能不能写进去'}
          </button>
        </div>
        <p className="set-note">
          {status?.error ? `上次出错：${status.error}` : `当前放在：${status?.storageTarget ?? '—'}`}
          {`（本地保留最近 ${manualKeep} 份，更早的自动删）`}
        </p>
      </div>

      {/* 登录入口只留一处：设置 → 账号（WfmcAccountPanel）。
          这里只显示状态，不再放第二个「用浏览器登录」。 */}
      <div className="set-block">
        <div className="set-block-title">
          云端账号
          <span className={loggedIn ? 'cloud-badge ok' : 'cloud-badge'}>{loggedIn ? '已登录' : '未登录'}</span>
        </div>
        <p className="set-note" style={{ marginTop: 0 }}>
          {loggedIn
            ? `已登录：${status?.account?.displayName || status?.account?.email || '（账号）'}。云端保留自动 ${autoKeep} 份 / 手动 ${manualKeep} 份，由服务器统一管理。`
            : '登录之后，每次备份会额外往云端存一份，换电脑时能直接还原；不登录也一切正常，只是备份只在本地。'}
        </p>
        <div className="set-actions">
          <button
            className="btn sm"
            onClick={() => window.dispatchEvent(new CustomEvent('wfmc:goto-section', { detail: 'wfmc' }))}
          >
            {loggedIn ? '管理账号' : '去「账号」里登录'}
          </button>
          <button
            className="btn sm ghost"
            disabled={busy === 'test'}
            onClick={() =>
              void run('test', async () => {
                const r = await api.testCloud()
                toast(r.message, r.authorized ? 'success' : 'error')
                return r.message
              })
            }
          >
            {busy === 'test' ? '测试中…' : '测试连接'}
          </button>
        </div>
        <p className="set-note">登录、退出登录、改密码都在上面「账号」那一栏里，这里只显示状态。</p>
      </div>

      <div className="set-block">
        <div className="set-block-title">开关</div>
        <div className="chips" style={{ marginBottom: 10 }}>
          <button className={`chip ${cfg.enabled ? 'on' : ''}`} onClick={() => void save({ enabled: true })}>
            启用备份
          </button>
          <button className={`chip ${!cfg.enabled ? 'on' : ''}`} onClick={() => void save({ enabled: false })}>
            完全关闭
          </button>
        </div>
        <div className="chips" style={{ marginBottom: 10 }}>
          <button className={`chip ${cfg.autoBackup ? 'on' : ''}`} onClick={() => void save({ autoBackup: true })}>
            启动后自动备份
          </button>
          <button className={`chip ${!cfg.autoBackup ? 'on' : ''}`} onClick={() => void save({ autoBackup: false })}>
            只手动备份
          </button>
        </div>
        <div className="chips">
          <button
            className={`chip ${cfg.announcements !== false ? 'on' : ''}`}
            onClick={() => void save({ announcements: true })}
          >
            接收公告
          </button>
          <button
            className={`chip ${cfg.announcements === false ? 'on' : ''}`}
            onClick={() => void save({ announcements: false })}
          >
            不接收
          </button>
        </div>
        <div className="set-actions" style={{ marginTop: 10 }}>
          <span style={{ fontSize: 12, opacity: 0.75 }}>每</span>
          <input
            type="number"
            min={1}
            max={48}
            style={{ width: 72 }}
            value={cfg.intervalH}
            onChange={(e) => setCfg({ ...cfg, intervalH: Number(e.target.value) || 6 })}
            onBlur={() => void save({ intervalH: cfg.intervalH })}
          />
          <span style={{ fontSize: 12, opacity: 0.75 }}>小时自动备份一次</span>
        </div>
      </div>

      {/* ------------------------------------------------ 备份列表 */}
      <div className="set-block">
        <div className="set-block-title">
          备份
          <span className="set-actions">
            <button
              className="btn sm primary"
              disabled={!cfg.enabled || busy === 'upload'}
              onClick={() =>
                void run('upload', async () => {
                  const r = await api.cloudUpload()
                  toast(r.message, 'success')
                  return r.message
                })
              }
            >
              {busy === 'upload' ? '备份中…' : '立即备份'}
            </button>
            <button className="btn sm ghost" onClick={() => void refresh()}>
              刷新
            </button>
          </span>
        </div>

        <div className="set-note" style={{ marginBottom: 4 }}>
          本地（最近 {manualKeep} 份）
        </div>
        {localBackups.length === 0 ? (
          <p className="set-note">本地还没有备份。</p>
        ) : (
          <div className="cloud-list">
            {localBackups.map((b) => (
              <div className="cloud-item" key={'l-' + b.id}>
                <div>
                  <div>{new Date(b.createdAt).toLocaleString()}</div>
                  <div className="set-note" style={{ margin: 0 }}>
                    {formatSize(b.size)} · {b.appVersion ? `启动器 ${b.appVersion}` : '版本未知'}
                  </div>
                </div>
                <div className="set-actions">
                  <button
                    className="btn sm"
                    disabled={busy === 'rlocal:' + b.id}
                    onClick={() =>
                      void run('rlocal:' + b.id, async () => {
                        const ok = window.confirm(
                          '还原会用这份备份覆盖本机设置、账号列表、服务器列表。\n' +
                            '游戏实例和存档不会被动。\n\n还原前会自动把当前配置另存一份。\n\n继续？'
                        )
                        if (!ok) return '已取消'
                        const r = await api.cloudRestoreLocal(b.id)
                        toast(r.message, r.ok ? 'success' : 'error')
                        return r.message
                      })
                    }
                  >
                    {busy === 'rlocal:' + b.id ? '还原中…' : '还原'}
                  </button>
                  <button
                    className="btn sm ghost"
                    onClick={() =>
                      void run('dlocal:' + b.id, async () => {
                        if (!window.confirm('删掉这份本地备份？')) return '已取消'
                        await api.cloudDeleteLocal(b.id)
                        return '已删除'
                      })
                    }
                  >
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {loggedIn && (
          <>
            <div className="set-note" style={{ margin: '12px 0 4px' }}>
              云端（自动 {autoKeep} 份 / 手动 {manualKeep} 份）
            </div>
            {cloudBackups.length === 0 ? (
              <p className="set-note">云端还没有备份。</p>
            ) : (
              <div className="cloud-list">
                {cloudBackups.map((b) => (
                  <div className="cloud-item" key={'c-' + b.id}>
                    <div>
                      <div>{new Date(b.createdAt).toLocaleString()}</div>
                      <div className="set-note" style={{ margin: 0 }}>
                        {formatSize(b.size)}
                        {b.note ? ` · ${b.note}` : ''}
                      </div>
                    </div>
                    <div className="set-actions">
                      <button
                        className="btn sm"
                        disabled={busy === 'restore:' + b.id}
                        onClick={() =>
                          void run('restore:' + b.id, async () => {
                            const ok = window.confirm(
                              '从云端还原会用这份备份覆盖本机设置、账号列表、服务器列表。\n' +
                                '游戏实例和存档不会被动。\n\n还原前会自动把当前配置另存一份。\n\n继续？'
                            )
                            if (!ok) return '已取消'
                            const r = await api.cloudRestore(b.id)
                            toast(r.message, r.ok ? 'success' : 'error')
                            return r.message
                          })
                        }
                      >
                        {busy === 'restore:' + b.id ? '还原中…' : '还原'}
                      </button>
                      <button
                        className="btn sm ghost"
                        onClick={() =>
                          void run('del:' + b.id, async () => {
                            if (!window.confirm('删掉这份云端备份？')) return '已取消'
                            await api.cloudDelete(b.id)
                            return '已删除'
                          })
                        }
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <p className="set-note">
          {cfg.lastBackupAt ? `上次备份成功：${new Date(cfg.lastBackupAt).toLocaleString()}` : '还没备份过'}
        </p>
      </div>

      {msg && <p className="set-note">{msg}</p>}
    </>
  )
}
