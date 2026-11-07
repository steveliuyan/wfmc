import { ZH_KEYS, ZH_TO_EN } from './i18n-zh'
import { convertDynamic } from './i18n-dynamic'

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

/* 动态文案规则集中在 i18n-dynamic.ts（扫描器也用同一套，避免跑偏） */

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
