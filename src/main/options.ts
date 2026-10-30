import fs from 'node:fs'
import path from 'node:path'

/**
 * 让新实例第一次进游戏就是中文。
 *
 * Minecraft 第一次启动时会自己生成 options.txt，里面 lang 默认是 en_us，
 * 于是每个新下载的版本都要手动进 Options → Language 改一次。
 * 这里在启动前先把 lang 写进去（只在没有 lang 时写，用户自己改过就不动）。
 */
export function ensureGameLanguage(gameDir: string, lang = 'zh_cn'): 'created' | 'patched' | 'kept' {
  const file = path.join(gameDir, 'options.txt')
  try {
    fs.mkdirSync(gameDir, { recursive: true })
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `lang:${lang}\n`, 'utf-8')
      return 'created'
    }
    const text = fs.readFileSync(file, 'utf-8')
    if (/^lang:/m.test(text)) return 'kept'
    const next = text.length === 0 || text.endsWith('\n') ? `${text}lang:${lang}\n` : `${text}\nlang:${lang}\n`
    fs.writeFileSync(file, next, 'utf-8')
    return 'patched'
  } catch {
    return 'kept'
  }
}

/**
 * 把一个资源包塞进 options.txt 的 resourcePacks 里并启用（汉化包就是资源包）。
 * MC 里资源包的写法是 `file/<zip 文件名>`，原版包用 `vanilla`。
 */
export function enableResourcePack(gameDir: string, zipName: string, lang = 'zh_cn'): 'enabled' | 'kept' {
  const file = path.join(gameDir, 'options.txt')
  const entry = `file/${zipName}`
  try {
    fs.mkdirSync(gameDir, { recursive: true })
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    const lines = text.length > 0 ? text.split(/\r?\n/) : []
    let packs: string[] = ['vanilla']
    let hasKey = false
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('resourcePacks:')) continue
      hasKey = true
      try {
        const arr = JSON.parse(lines[i].slice('resourcePacks:'.length)) as unknown
        if (Array.isArray(arr)) packs = arr.filter((x): x is string => typeof x === 'string')
      } catch {
        /* 解析失败就当成空的，下面重建 */
      }
      if (!packs.includes('vanilla')) packs.unshift('vanilla')
      if (!packs.includes(entry)) packs.push(entry)
      lines[i] = `resourcePacks:${JSON.stringify(packs)}`
    }
    if (!hasKey) {
      if (!packs.includes(entry)) packs.push(entry)
      lines.push(`resourcePacks:${JSON.stringify(packs)}`)
    }
    // 汉化包要靠中文语言才生效
    let hasLang = false
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('lang:')) continue
      hasLang = true
      lines[i] = `lang:${lang}`
    }
    if (!hasLang) lines.push(`lang:${lang}`)
    fs.writeFileSync(file, lines.filter((l) => l.length > 0).join('\n') + '\n', 'utf-8')
    return packs.includes(entry) ? 'enabled' : 'kept'
  } catch {
    return 'kept'
  }
}
