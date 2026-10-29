import { session } from 'electron'

/**
 * 应用代理设置。
 * 支持 http://host:port、socks5://host:port；留空 = 直连（并清掉旧代理）。
 */
export async function applyProxy(proxy: string): Promise<void> {
  const value = (proxy ?? '').trim()
  try {
    const ses = session.defaultSession
    if (!value) {
      await ses.setProxy({ mode: 'direct' })
      return
    }
    // 允许用户只填 127.0.0.1:7890
    const rules = /^[a-z0-9+]+:\/\//i.test(value) ? value : `http://${value}`
    await ses.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' })
  } catch {
    /* 代理设置失败不影响启动器本体 */
  }
}
