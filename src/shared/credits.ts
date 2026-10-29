// 致敬名单：本启动器参考/依赖的开源项目、数据源与素材
export type CreditKind = 'launcher' | 'library' | 'data' | 'asset'

export interface CreditEntry {
  name: string
  author: string
  license: string
  url: string
  /** 我们具体借用了什么 */
  borrowed: string
  kind: CreditKind
}

export const CREDITS: CreditEntry[] = [
  // ---------- 启动器 ----------
  {
    name: 'XMCL / x-minecraft-launcher',
    author: 'Voxelum',
    license: 'MIT',
    url: 'https://github.com/Voxelum/x-minecraft-launcher',
    borrowed:
      '本项目的内核底座：@xmcl/core 解析版本与启动、@xmcl/installer 装加载器、@xmcl/user 登录、@xmcl/modrinth 资源市场，以及「实例=独立 .minecraft」的设计。',
    kind: 'launcher'
  },
  {
    name: 'Daybreak 破晓启动器',
    author: 'gan4012',
    license: 'MIT',
    url: 'https://github.com/gan4012/Daybreak',
    borrowed:
      '功能对标：服务器列表 + SRV 解析 + 一键进服、崩溃诊断规则思路、首启三步引导、主题三选一、实例级 JVM/内存覆盖、存档与内容管理。仅借鉴设计与规则，未复制代码。',
    kind: 'launcher'
  },
  {
    name: 'HMCL',
    author: 'HMCL-dev',
    license: 'GPL-3.0',
    url: 'https://github.com/HMCL-dev/HMCL',
    borrowed: '功能分区与信息架构（版本 / 下载 / 模组 / 日志），Java 自动匹配策略，镜像源思路。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'PCL2 ｜ Plain Craft Launcher',
    author: 'Meloong-Git / 龙腾猫跃',
    license: '自定义（非标准开源许可）',
    url: 'https://github.com/Meloong-Git/PCL',
    borrowed: '交互参考：单页卡片式首页、下载页「选版本→一键装」、加载器与版本并列选择。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'PrismLauncher',
    author: 'PrismLauncher Team',
    license: 'GPL-3.0',
    url: 'https://github.com/PrismLauncher/PrismLauncher',
    borrowed: '实例隔离与实例级设置面板的形态（内存 / Java / 窗口 / JVM 参数），内容管理与日志查看。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'MultiMC',
    author: 'MultiMC Contributors',
    license: '自定义（非标准开源许可）',
    url: 'https://github.com/MultiMC/Launcher',
    borrowed: '「一个实例一套独立目录」的原始设计理念（Prism 的前身）。',
    kind: 'launcher'
  },
  {
    name: 'ATLauncher',
    author: 'ATLauncher',
    license: 'GPL-3.0',
    url: 'https://github.com/ATLauncher/ATLauncher',
    borrowed: '整合包导入与管理的信息组织方式。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'HeliosLauncher',
    author: 'Daniel Scalzi',
    license: 'MIT',
    url: 'https://github.com/dscalzi/HeliosLauncher',
    borrowed: 'Electron 架构下的启动器工程结构与安装/更新流程思路。',
    kind: 'launcher'
  },
  {
    name: 'GDLauncher',
    author: 'GorillaDevs',
    license: 'GPL-3.0',
    url: 'https://github.com/gorilla-devs/GDLauncher',
    borrowed: '现代化实例卡片与资源浏览的 UI 布局参考。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'PandoraLauncher',
    author: 'Moulberry',
    license: 'MIT',
    url: 'https://github.com/Moulberry/PandoraLauncher',
    borrowed: '轻量客户端 + 性能向默认值的取舍参考。',
    kind: 'launcher'
  },
  {
    name: 'FreesmLauncher',
    author: 'FreesmTeam',
    license: 'GPL-3.0',
    url: 'https://github.com/FreesmTeam/FreesmLauncher',
    borrowed: '离线/正版账号切换与 Java 选择器的交互参考。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'MojoLauncher',
    author: 'MojoLauncher',
    license: 'LGPL-3.0',
    url: 'https://github.com/MojoLauncher/MojoLauncher',
    borrowed: '移动端向的轻量启动流程参考。未使用其代码。',
    kind: 'launcher'
  },
  {
    name: 'PojavLauncher',
    author: 'PojavLauncherTeam',
    license: 'LGPL-3.0',
    url: 'https://github.com/PojavLauncherTeam/PojavLauncher',
    borrowed: '跨平台启动参数拼装与图形后端说明的参考。未使用其代码。',
    kind: 'launcher'
  },

  // ---------- 依赖库 ----------
  {
    name: '@xmcl/core · installer · user · modrinth · curseforge · task · unzip',
    author: 'cijhn / Voxelum & xmcl contributors',
    license: 'MIT',
    url: 'https://github.com/Voxelum/minecraft-launcher-core-node',
    borrowed: '版本解析、启动参数拼装、加载器安装、微软/Yggdrasil 登录、Modrinth API 客户端。',
    kind: 'library'
  },
  {
    name: 'Electron',
    author: 'OpenJS Foundation',
    license: 'MIT',
    url: 'https://github.com/electron/electron',
    borrowed: '桌面应用运行时与打包基础。',
    kind: 'library'
  },
  {
    name: 'React',
    author: 'Meta / React Team',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
    borrowed: '渲染层 UI 框架。',
    kind: 'library'
  },
  {
    name: 'lottie-web',
    author: 'Airbnb',
    license: 'MIT',
    url: 'https://github.com/airbnb/lottie-web',
    borrowed: '播放品牌「进场」Lottie 动画（启动画面与首页动效）。',
    kind: 'library'
  },
  {
    name: 'Vite / esbuild / electron-builder',
    author: 'Evan You · evanw · electron-userland',
    license: 'MIT',
    url: 'https://vitejs.dev',
    borrowed: '构建、打包与产物生成。',
    kind: 'library'
  },

  // ---------- 数据源 ----------
  {
    name: 'Mojang 版本清单 & Java 运行时',
    author: 'Mojang Studios / Microsoft',
    license: 'Mojang 服务条款',
    url: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
    borrowed: '版本元数据、client.jar、libraries、assets、官方 Java 运行时清单。',
    kind: 'data'
  },
  {
    name: 'BMCLAPI',
    author: 'bangbang93',
    license: '免费公共服务',
    url: 'https://bmclapi2.bangbang93.com',
    borrowed: '国内镜像：版本清单、assets、Maven 库、Forge 安装器。国内下载体验主要靠它。',
    kind: 'data'
  },
  {
    name: 'FabricMC Meta',
    author: 'FabricMC',
    license: 'Apache-2.0',
    url: 'https://meta.fabricmc.net',
    borrowed: 'Fabric loader 版本清单与启动元数据。',
    kind: 'data'
  },
  {
    name: 'QuiltMC Meta',
    author: 'QuiltMC',
    license: 'Apache-2.0',
    url: 'https://meta.quiltmc.org',
    borrowed: 'Quilt loader 版本清单。',
    kind: 'data'
  },
  {
    name: 'Forge / NeoForged Maven',
    author: 'MinecraftForge · NeoForged',
    license: 'LGPL-2.1 / 各自许可',
    url: 'https://maven.minecraftforge.net',
    borrowed: 'Forge / NeoForge 安装器与依赖库。',
    kind: 'data'
  },
  {
    name: 'Modrinth API',
    author: 'Modrinth',
    license: '免费开放 API',
    url: 'https://api.modrinth.com',
    borrowed: '模组 / 光影 / 资源包 / 整合包搜索与下载，更新检查（按 sha1）。',
    kind: 'data'
  },
  {
    name: 'CurseForge API',
    author: 'Overwolf / CurseForge',
    license: '需申请 API Key',
    url: 'https://api.curseforge.com',
    borrowed: 'CurseForge 整合包里的模组解析与下载（需自备 Key）。',
    kind: 'data'
  },
  {
    name: 'PaperMC API',
    author: 'PaperMC',
    license: 'GPL-3.0',
    url: 'https://api.papermc.io',
    borrowed: '一键开服里的 Paper 服务端构建下载。',
    kind: 'data'
  },

  // ---------- 素材 ----------
  {
    name: '万凡科技品牌图标包（靛紫电光）',
    author: '万凡科技 WANFAN TECHNOLOGY',
    license: '自有素材',
    url: 'H:\\万凡图标\\output_v2\\靛紫电光',
    borrowed: '应用图标（图形_扁平双色）、横版 logo、Lottie「进场」动画、品牌色 #372FA2 / #06B6D3。',
    kind: 'asset'
  }
]

export const CREDIT_KIND_LABEL: Record<CreditKind, string> = {
  launcher: '同类启动器（借鉴设计）',
  library: '依赖库',
  data: '数据源 / 开放 API',
  asset: '品牌素材'
}
