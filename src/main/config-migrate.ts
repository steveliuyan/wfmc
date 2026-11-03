import type { Settings } from '../shared/types'

/**
 * 配置结构版本 + 有序迁移。
 *
 * 以前这些补丁是散在 store.load() 里的一堆 if（mirrorMigrated、downloadThreads 16/48→32…），
 * 越加越乱、也没法知道「这台机器迁到哪一步了」。现在统一成一张表：
 * 每条迁移只关心「从自己那一版升到下一版要做的事」，启动时从 settings.configVersion
 * 一路往上跑，跑完把版本号写回。以后再加迁移，只在表尾追加一条、把 CONFIG_VERSION +1 即可。
 */

export const CONFIG_VERSION = 3

export interface Migration {
  /** 升到这一版时执行 */
  version: number
  /** 日志/排查用的说明 */
  title: string
  /** 返回是否改动了设置 */
  run: (s: Settings) => boolean
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    title: '基线：开始记录配置版本',
    run: () => false
  },
  {
    version: 2,
    title: '下载源「自动」→ 国内镜像（官方源在国内又慢又容易断）',
    run: (s) => {
      // 老标记已经在的老用户别再动：他可能就是后来特意选回「自动」的
      if (s.mirrorMigrated) return false
      s.mirrorMigrated = true
      if (s.downloadSource === 'auto') s.downloadSource = 'mirror'
      return true
    }
  },
  {
    version: 3,
    title: '下载线程数 48 / 16 → 32（48 会被 CDN 限速，16 单文件只有 4 条连接）',
    run: (s) => {
      if (s.downloadThreads === 48 || s.downloadThreads === 16) {
        s.downloadThreads = 32
        return true
      }
      return false
    }
  }
]

export interface MigrateResult {
  /** 需要写盘（版本号变了就算） */
  changed: boolean
  /** 实际执行的迁移说明，供日志用 */
  applied: string[]
  from: number
  to: number
}

/** 按版本号依次升级配置（原地改 s） */
export function migrateSettings(s: Settings): MigrateResult {
  const from = typeof s.configVersion === 'number' && Number.isFinite(s.configVersion) ? s.configVersion : 0
  const applied: string[] = []
  if (from >= CONFIG_VERSION) return { changed: false, applied, from, to: from }
  for (const m of MIGRATIONS) {
    if (m.version <= from) continue
    if (m.run(s)) applied.push(`v${m.version} ${m.title}`)
    else applied.push(`v${m.version} ${m.title}（无需改动）`)
  }
  s.configVersion = CONFIG_VERSION
  return { changed: true, applied, from, to: CONFIG_VERSION }
}
