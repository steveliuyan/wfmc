import { PAIRS as MANAGE } from './manage'
import { PAIRS as SETTINGS } from './settings'
import { PAIRS as RESOURCES } from './resources'
import { PAIRS as ONLINE } from './online'
import { PAIRS as INSTANCES } from './instances'
import { PAIRS as APP } from './app'
import { PAIRS as HOSTING } from './hosting'
import { PAIRS as MISC } from './misc'

/**
 * 各区域补翻的词条，按顺序拼起来。
 * 拆成多个文件是为了能分头补、互不冲突；同一条重复出现时后面的覆盖前面的。
 * 新加区域时：在这里 import 并追加到数组末尾即可。
 */
export const PARTS: [string, string][] = [
  ...MANAGE,
  ...SETTINGS,
  ...RESOURCES,
  ...ONLINE,
  ...INSTANCES,
  ...APP,
  ...HOSTING,
  ...MISC
]