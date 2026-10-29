import { ZH_KEYS, ZH_TO_EN } from './i18n-zh'

/**
 * 运行时文案替换：切到 English 时，把页面上命中的中文文本整体换成英文。
 *
 * 为什么这么做：界面文案散在 10 个页面里，逐条包 t() 改动面太大；
 * 这里用「词典 + 文本节点替换」一次覆盖，新代码仍可以继续用 useT()。
 *
 * 规则：
 * 1. 文本节点 trim 后精确命中 → 整段替换
 * 2. 没精确命中但包含长词（≥4 字）→ 逐词替换，处理「已看 24 / 共 N 个」这类拼接串
 * 3. placeholder / title / aria-label 一起处理
 * 4. 关掉英文时按原值还原（WeakMap 记着原文）
 */

const ATTRS = ['placeholder', 'title', 'aria-label'] as const

let observer: MutationObserver | null = null
let enabled = false

const textOriginal = new WeakMap<Text, string>()
const attrOriginal = new WeakMap<Element, Partial<Record<(typeof ATTRS)[number], string>>>()

const LONG_KEYS = ZH_KEYS.filter((k) => k.length >= 4)


/* ------------------------------------------------------------------ *
 * 动态文案规则：处理带变量的字符串（模板串拼出来的那些）
 * ------------------------------------------------------------------ */

const VERBS: Record<string, string> = {
  安装: 'Install',
  安装整合包: 'Install modpack',
  卸载: 'Uninstall',
  下载: 'Download',
  备份: 'Backup',
  导出: 'Export',
  导入: 'Import',
  读取: 'Read',
  检查: 'Check',
  启动: 'Launch',
  切换: 'Switch',
  清除: 'Clear',
  上传: 'Upload',
  登录: 'Sign in',
  进服: 'Join',
  创建: 'Create',
  保存: 'Save',
  操作: 'Action',
  穿透: 'Tunnel',
  分享: 'Share',
  更新: 'Update',
  体检: 'Check-up',
  套用: 'Apply',
  删除: 'Delete',
  解压: 'Extract',
  房间码: 'Room code',
  'CF 搜索': 'CurseForge search',
  拉取加载器版本: 'Load loader versions',
  获取版本: 'Fetch version',
  扫描: 'Scan',
  导入实例: 'Import instance',
  导出整合包: 'Export modpack',
  打开目录: 'Open folder'
}

function verb(word: string): string {
  return VERBS[word.trim()] ?? word.trim()
}

/** 动态串翻译：命中返回英文，否则 undefined（交给后面的通用替换） */
function convertDynamic(value: string): string | undefined {
  const v = value.trim()
  let m: RegExpMatchArray | null

  // 通用「X失败：原因」/「X成功：结果」
  if ((m = v.match(/^(.{1,20}?)(失败|出错)：(.+)$/))) return `${verb(m[1])} failed: ${m[3]}`
  if ((m = v.match(/^(.{1,20}?)成功：(.+)$/))) return `${verb(m[1])} ok: ${m[2]}`

  if ((m = v.match(/^开始安装 (.+)…$/))) return `Installing ${m[1]}…`
  if ((m = v.match(/^开始下载 (.+)…$/))) return `Downloading ${m[1]}…`
  if ((m = v.match(/^(.+) 安装完成$/))) return `${m[1]} installed`
  if ((m = v.match(/^(.+) 已更新（旧文件保留为 \.old）$/))) return `${m[1]} updated (old file kept as .old)`
  if ((m = v.match(/^发现 (\d+) 个可更新模组$/))) return `${m[1]} mods can be updated`
  if ((m = v.match(/^发现新版本 (.+)$/))) return `Update available: ${m[1]}`
  if ((m = v.match(/^已看 (.+?) \/ 共 (\S+) 个$/))) return `Seen ${m[1]} of ${m[2]}`
  if ((m = v.match(/^已看 (.+)$/))) return `Seen ${m[1]}`
  if ((m = v.match(/^体检完成：扫描 (\d+) 个 mod$/))) return `Check-up done: scanned ${m[1]} mods`
  if ((m = v.match(/^清理了 (\d+) 个临时文件，释放 (.+)$/))) return `Cleaned ${m[1]} temp files, freed ${m[2]}`
  if ((m = v.match(/^公网地址：(.+)$/))) return `Public address: ${m[1]}`
  if ((m = v.match(/^房间码无效：(.+)$/))) return `Invalid room code: ${m[1]}`
  if ((m = v.match(/^把 (\S+) 端口映射到公网$/))) return `Map port ${m[1]}`
  if ((m = v.match(/^当前实例：(.+)$/))) return `Current instance: ${m[1]}`
  if ((m = v.match(/^进服实例：(.+)$/))) return `Join with: ${m[1]}`
  if ((m = v.match(/^安装目标：(.+)$/))) return `Target: ${m[1]}`
  if ((m = v.match(/^搜索(.{1,8})…$/))) return `Search ${m[1]}…`
  if ((m = v.match(/^删掉版本 (.+) 的文件？$/))) return `Delete files of ${m[1]}?`
  if ((m = v.match(/^删掉 (.+)？$/))) return `Delete ${m[1]}?`
  if ((m = v.match(/^「(.+)」会连同游戏文件一起删除，确定？$/)))
    return `“${m[1]}” will be deleted with its game files. Continue?`
  if ((m = v.match(/^「(.+)」的存档会一起删掉，确定？$/)))
    return `Saves of “${m[1]}” will be deleted too. Continue?`
  if ((m = v.match(/^版本 (.+)$/))) return `Version ${m[1]}`
  if ((m = v.match(/^建议使用(镜像源|官方源)$/))) return `Recommended: ${m[1] === '镜像源' ? 'mirror' : 'official'}`
  if ((m = v.match(/^（本地 (.+) → 最新 (.+)）$/))) return `(local ${m[1]} → latest ${m[2]})`
  if ((m = v.match(/^启动版本切换为 (.+)$/))) return `Launch version switched to ${m[1]}`
  if ((m = v.match(/^实例 · (.+)$/))) return `Instance · ${m[1]}`
  if ((m = v.match(/^authlib-injector (已就绪|就绪)[： ]?(.*)$/))) return `authlib-injector ready ${m[2]}`
  if ((m = v.match(/^(\d+)\/(\d+) 人$/))) return `${m[1]}/${m[2]} players`
  if ((m = v.match(/^在线玩家：(.+)$/))) return `Players online: ${m[1]}`
  if ((m = v.match(/^已装模组（(\d+)）$/))) return `Installed mods (${m[1]})`
  if ((m = v.match(/^已装(.{1,6})（(\d+)）$/))) return `Installed ${m[1]} (${m[2]})`
  if ((m = v.match(/^(\d+) 个实例，总时长 (.+)$/))) return `${m[1]} instances, playtime ${m[2]}`
  if ((m = v.match(/^共 (\d+) 个实例$/))) return `${m[1]} instances`
  if ((m = v.match(/^已安装 (\d+) 个$/))) return `${m[1]} installed`
  if ((m = v.match(/^还剩 (.+)$/))) return `${m[1]} left`
  if ((m = v.match(/^TUNNEL (.+)$/))) return value
  return undefined
}
function convert(value: string): string | undefined {
  const key = value.trim()
  if (!key) return undefined
  const exact = ZH_TO_EN.get(key)
  if (exact !== undefined) {
    const at = value.indexOf(key)
    return value.slice(0, at) + exact + value.slice(at + key.length)
  }
  const dynamic = convertDynamic(key)
  if (dynamic !== undefined) {
    const at = value.indexOf(key)
    return value.slice(0, at) + dynamic + value.slice(at + key.length)
  }
  // 拼接串：只替换较长的词，避免把短词拆得到处都是
  let out = value
  let touched = false
  for (const k of LONG_KEYS) {
    if (!out.includes(k)) continue
    const en = ZH_TO_EN.get(k)
    if (!en) continue
    out = out.split(k).join(en)
    touched = true
  }
  return touched ? out : undefined
}

function translateText(node: Text) {
  const next = convert(node.nodeValue ?? '')
  if (next === undefined) return
  if (!textOriginal.has(node)) textOriginal.set(node, node.nodeValue ?? '')
  if (node.nodeValue !== next) node.nodeValue = next
}

function translateAttrs(el: Element) {
  for (const attr of ATTRS) {
    const raw = el.getAttribute(attr)
    if (!raw) continue
    const next = convert(raw)
    if (next === undefined) continue
    const store = attrOriginal.get(el) ?? {}
    if (store[attr] === undefined) store[attr] = raw
    attrOriginal.set(el, store)
    if (next !== raw) el.setAttribute(attr, next)
  }
}

function walk(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return
  const el = root as Element
  // 跳过脚本/样式/输入值
  const tag = el.tagName
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || tag === 'CODE' || tag === 'PRE') {
    if (tag === 'TEXTAREA' || tag === 'PRE') translateAttrs(el)
    return
  }
  translateAttrs(el)
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  let node: Node | null = walker.nextNode()
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) translateText(node as Text)
    else translateAttrs(node as Element)
    node = walker.nextNode()
  }
}

function restore() {
  if (!observer) return
  observer.disconnect()
  observer = null
  // 还原文本
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  let node = walker.nextNode()
  while (node) {
    const original = textOriginal.get(node as Text)
    if (original !== undefined) (node as Text).nodeValue = original
    node = walker.nextNode()
  }
  // 还原属性
  const elWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  let el = elWalker.nextNode()
  while (el) {
    const store = attrOriginal.get(el as Element)
    if (store) {
      for (const [attr, val] of Object.entries(store)) {
        if (val !== undefined) (el as Element).setAttribute(attr, val)
      }
    }
    el = elWalker.nextNode()
  }
}

/** 开关：settings.language === 'en' 时打开 */
export function setAutoI18n(on: boolean): void {
  if (on === enabled) {
    if (on) walk(document.body)
    return
  }
  enabled = on
  if (!on) {
    restore()
    return
  }
  if (!document.body) return
  walk(document.body)
  observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        r.addedNodes.forEach((n) => walk(n))
      } else if (r.type === 'characterData' && r.target.nodeType === Node.TEXT_NODE) {
        translateText(r.target as Text)
      } else if (r.type === 'attributes' && r.target.nodeType === Node.ELEMENT_NODE) {
        translateAttrs(r.target as Element)
      }
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS]
  })
}

export function isAutoI18nOn(): boolean {
  return enabled
}
