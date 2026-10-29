/**
 * 中文名 → 英文名 的别名表。
 *
 * 为什么需要：Modrinth 和 CurseForge 的搜索只认项目原名（基本都是英文），
 * 「幸运方块」「暮色森林」这种中文打进去必然 0 结果。PCL2 之类启动器能搜中文，
 * 是自己在客户端维护了一份中文译名索引；这里用同一套思路，做一张常用词表，
 * 中文关键词先翻译成英文再送进 API。
 *
 * 规则：
 *  - 键可以是短词也可以是短语，匹配时按长度从长到短，长词优先（「幸运方块」先于「方块」）。
 *  - 一个键可以对应多个英文候选，全都查，结果合并去重。
 *  - 表里没有的词，退化成原样搜索，并告诉上层「没认出来」，让界面提示用户换英文。
 */

/** 中文（含常见别称） → 英文搜索候选 */
const ALIAS: Record<string, string[]> = {
  // 经典模组
  幸运方块: ['lucky block'],
  幸运方塊: ['lucky block'],
  等价交换: ['projecte', 'equivalent exchange'],
  无尽贪婪: ['avaritia'],
  匠魂: ['tinkers construct', 'tinkers'],
  暮色森林: ['twilight forest'],
  格雷科技: ['gregtech'],
  工业时代: ['industrialcraft', 'ic2'],
  工业: ['industrialcraft', 'ic2'],
  建筑: ['buildcraft'],
  热力膨胀: ['thermal expansion'],
  应用能源: ['applied energistics'],
  林业: ['forestry'],
  神秘时代: ['thaumcraft'],
  神秘: ['thaumcraft'],
  血魔法: ['blood magic'],
  植物魔法: ['botania'],
  星辉魔法: ['astral sorcery'],
  以太: ['the aether'],
  深渊国度: ['abyssalcraft'],
  更好的下界: ['better nether'],
  更好的末地: ['better end'],
  机械动力: ['create'],
  沉浸工程: ['immersive engineering'],
  通用机械: ['mekanism'],
  核电工艺: ['nuclearcraft'],
  农夫乐事: ['farmers delight'],
  更多箱子: ['iron chests'],
  储物抽屉: ['storage drawers'],
  精致存储: ['refined storage'],
  简单存储: ['simple storage network'],
  旅行地图: ['journeymap'],
  小地图: ['xaeros minimap', 'journeymap'],
  一键砍树: ['falling tree', 'treecapitator'],
  连锁挖矿: ['vein mining'],
  死亡不掉落: ['gravestone', 'corail tombstone'],
  墓碑: ['gravestone'],
  结构: ['structure'],
  更多生物: ['alexs mobs'],
  背包: ['travelers backpack', 'backpack'],
  附魔描述: ['enchantment descriptions'],
  物品管理器: ['roughly enough items', 'jei'],
  配方查看: ['roughly enough items', 'jei'],
  光影前置: ['iris', 'optifine'],
  汉化: ['chinese', 'translation'],
  中文: ['chinese', 'translation'],

  // 优化类
  优化: ['optimization', 'performance'],
  钠: ['sodium'],
  锂: ['lithium'],
  磷: ['phosphor'],
  锶: ['starlight'],
  铷: ['rubidium'],
  镁: ['magnesium'],
  现代修复: ['modernfix'],
  精简: ['modernfix'],
  剔除: ['entity culling'],
  实体剔除: ['entity culling'],
  光影: ['shaders'],
  着色器: ['shaders'],
  高清修复: ['optifine'],
  苹果皮: ['appleskin'],
  苹果核: ['applecore'],
  资源包: ['resource pack'],
  材质包: ['resource pack'],
  整合包: ['modpack'],

  // 功能性
  血量显示: ['damage indicators', 'torohealth'],
  伤害显示: ['damage indicators', 'torohealth'],
  皮肤: ['skin'],
  皮肤层: ['skin layers'],
  服务器: ['server'],
  传送: ['teleport', 'waystones'],
  指路石: ['waystones'],
  家园: ['home'],
  地图: ['map'],
  世界: ['world'],
  种子: ['seed'],
  生物群系: ['biomes'],
  地形: ['terrain'],
  村庄: ['villages'],
  武器: ['weapons'],
  工具: ['tools'],
  装备: ['equipment'],
  食物: ['food'],
  药水: ['potions'],
  附魔: ['enchantment'],
  战利品: ['loot'],
  刷怪: ['mob farm'],
  漏斗: ['hopper'],
  箱子: ['chests'],
  熔炉: ['furnace'],
  能源: ['energy'],
  电力: ['electricity'],
  管道: ['pipes'],
  流体: ['fluids'],
  存储: ['storage'],
  自动: ['automation'],
  农业: ['agriculture', 'farming'],
  钓鱼: ['fishing'],

  // 平台 / 基础库
  法布瑞克: ['fabric api'],
  前置: ['api'],
  核心: ['core', 'api'],
  库: ['library']
}

/** 按长度倒序的键，保证「幸运方块」在「方块」之前被匹配到 */
const KEYS = Object.keys(ALIAS).sort((a, b) => b.length - a.length)

/**
 * 太泛的词只认「整句就是这个」（不然「随便一个中文」会被翻成 chinese 搜出一堆汉化包）。
 */
const WHOLE_ONLY = new Set(['中文', '汉化'])

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

export function hasChinese(s: string): boolean {
  return CJK.test(s)
}

/**
 * 把中文查询展开成若干英文查询。
 * @returns matched=false 表示表里一个词都没认出来（界面该提示用户换英文）
 */
export function expandCnQuery(query: string): { matched: boolean; used: string[] } {
  const q = (query ?? '').trim()
  if (!q || !hasChinese(q)) return { matched: false, used: [] }

  const used: string[] = []
  const push = (s: string) => {
    const v = s.trim()
    if (v && !used.includes(v)) used.push(v)
  }

  // 1) 整句命中（最常见：「幸运方块」）
  const whole = ALIAS[q]
  if (whole) whole.forEach(push)

  // 2) 命中长词后把命中的中文剔掉，看剩下的英文/数字还能不能带上（「幸运方块1.12」）
  let rest = q
  for (const key of KEYS) {
    if (!rest.includes(key)) continue
    if (WHOLE_ONLY.has(key)) continue
    ALIAS[key].forEach(push)
    rest = rest.replace(new RegExp(key, 'g'), ' ').trim()
    if (used.length >= 3) break
  }

  // 3) 剩下的碎片里如果还有英文/数字，当作补充查询（保留原语言混搜）
  const leftover = rest.replace(/\s+/g, ' ').trim()
  if (leftover && !hasChinese(leftover) && leftover.length >= 2 && used.length === 0) push(leftover)

  return { matched: used.length > 0, used: used.slice(0, 3) }
}
