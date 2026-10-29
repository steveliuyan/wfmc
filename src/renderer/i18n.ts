/** 轻量 i18n：只做界面外壳（导航 / 主要按钮 / 提示），内容页仍是中文文案 */
export type Lang = 'zh' | 'en'

type Dict = Record<string, string>

const zh: Dict = {
  'nav.home': '首页',
  'nav.instances': '实例',
  'nav.download': '下载游戏',
  'nav.resources': '模组 · 光影',
  'nav.servers': '服务器',
  'nav.online': '联机',
  'nav.hosting': '一键开服',
  'nav.skin': '皮肤 · 外置登录',
  'nav.manage': '内容管理',
  'nav.settings': '设置',
  'action.launch': '启动游戏',
  'action.reinstall': '重新安装',
  'action.verify': '校验文件',
  'action.openDir': '打开目录',
  'action.install': '安装',
  'action.update': '更新',
  'action.delete': '删除',
  'action.cancel': '取消',
  'action.save': '保存',
  'action.refresh': '刷新',
  'action.search': '搜索',
  'label.currentInstance': '当前实例',
  'label.account': '账号',
  'label.theme': '主题',
  'label.language': '语言',
  'theme.light': '浅色',
  'theme.dark': '深色',
  'theme.system': '跟随系统',
  'hint.pickInstance': '先在左侧选一个实例'
}

const en: Dict = {
  'nav.home': 'Home',
  'nav.instances': 'Instances',
  'nav.download': 'Download',
  'nav.resources': 'Mods & Shaders',
  'nav.servers': 'Servers',
  'nav.online': 'Multiplayer',
  'nav.hosting': 'Host Server',
  'nav.skin': 'Skin & Auth',
  'nav.manage': 'Content',
  'nav.settings': 'Settings',
  'action.launch': 'Launch',
  'action.reinstall': 'Reinstall',
  'action.verify': 'Verify files',
  'action.openDir': 'Open folder',
  'action.install': 'Install',
  'action.update': 'Update',
  'action.delete': 'Delete',
  'action.cancel': 'Cancel',
  'action.save': 'Save',
  'action.refresh': 'Refresh',
  'action.search': 'Search',
  'label.currentInstance': 'Instance',
  'label.account': 'Account',
  'label.theme': 'Theme',
  'label.language': 'Language',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
  'hint.pickInstance': 'Pick an instance on the left first'
}

const dicts: Record<Lang, Dict> = { zh, en }

export function translate(lang: Lang | undefined, key: string, fallback?: string): string {
  const table = dicts[lang ?? 'zh'] ?? zh
  return table[key] ?? zh[key] ?? fallback ?? key
}
