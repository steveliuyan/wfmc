/**
 * 「升级公告」（what's new）：换了版本之后第一次打开时弹一次。
 *
 * 为什么不用服务端公告（NoticePopup）：那条路要有网络 + 登录（cloud:announcements），
 * 而「这次更新了什么」恰恰是断网、没账号的人最想看的一句话。所以内容写死在本地，
 * 跟着包一起发，改版时只要在数组头部加一条。
 *
 * 只弹「最新一条」：用户从 1.1.3 直接跳到 1.3.0 时没必要看 1.2.0 的旧公告。
 */
export type WhatsNewEntry = { version: string; items: string[] }

/** 记「哪个版本的公告已经看过了」。localStorage 而不是 settings：这是纯本地 UI 状态，不值得同步。 */
const SEEN_KEY = 'whatsNewSeen'

export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: '1.2.0',
    items: [
      '内容管理新增「依赖」页：谁缺前置、谁跟谁冲突一眼看清，还能一键补齐。',
      '联机页可以共享模组清单，好友粘贴后自动对齐版本、补上缺的模组（只增不删）。',
      '开服支持定时备份、定时重启、日志轮转，进程掉了会自动拉起。',
      '存档页能改难度、游戏规则、时间和出生点，改之前自动打一份快照。',
      '截图页每张图都能做成分享卡，可以存到截图目录或直接复制图片。',
      '设置里可以切英文界面。'
    ]
  }
]

/** 有需要弹的公告就返回最新一条，否则 undefined（已经看过 / localStorage 不可用）。 */
export function pendingWhatsNew(): WhatsNewEntry | undefined {
  const latest = WHATS_NEW[0]
  if (!latest) return undefined
  try {
    if (localStorage.getItem(SEEN_KEY) === latest.version) return undefined
  } catch {
    // 隐私模式 / 存储被禁：宁可弹一次，也不要整页崩
  }
  return latest
}

export function markWhatsNewSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version)
  } catch {
    // 写不进去就算了，下次还会弹，不影响使用
  }
}
