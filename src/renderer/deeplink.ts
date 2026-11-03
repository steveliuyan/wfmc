/**
 * 页面间的一次性「深链接」：Ctrl+K 里点某个模组/存档，跳到内容管理并切到那个 tab。
 * 用模块级变量而不是 props，是因为内容管理是从 App 的页面表里渲染的，不值得为此改路由。
 */
export interface DeepLink {
  /** 内容管理里切到哪个实例 */
  instanceId?: string
  /** 内容管理里切到哪个 tab */
  tab?: string
}

let pending: DeepLink | null = null

export function setDeepLink(link: DeepLink): void {
  pending = link
}

/** 取走（取完即清），保证只用一次 */
export function takeDeepLink(): DeepLink | null {
  const p = pending
  pending = null
  return p
}
