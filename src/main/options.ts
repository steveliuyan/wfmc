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
