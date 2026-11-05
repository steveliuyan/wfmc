import type { TourStep } from './components/Tour'

/**
 * 新手引导的步骤表（高亮讲解）。
 * 文案规矩和 USAGE.md 一样：全中文、动词开头、按钮名用「」、每步说清「做对了会怎样」。
 * 目标元素靠组件里的 data-tour="xxx" 找；设置页沿用现成的 section id（set-java / set-download）。
 */
export const tourSteps: TourStep[] = [
  {
    title: '先花 1 分钟认个路',
    body: '只说最常用的几个地方，看完就知道该点哪儿。随时可以按 Esc 或点「跳过」退出——以后在左边「新手引导」还能再放一遍。',
    points: ['高亮的地方就是这一步要点的东西', '记不住没关系，装东西的时候照着点就行']
  },
  {
    target: '.sidebar nav',
    placement: 'right',
    title: '左边这十个页面，按用途分',
    body: '不用一次记全，常用的就前四个加「内容管理」：',
    points: [
      '首页 —— 点「启动游戏」的地方',
      '实例 —— 每个游戏环境（模组 / 存档各归各的）',
      '下载游戏 —— 装游戏本体、装加载器',
      '模组 · 光影 —— 装模组、装整合包',
      '内容管理 —— 看文件、看崩溃报告；设置 —— 下载源 / Java / 账号'
    ]
  },
  {
    target: '.sidebar-foot',
    placement: 'right',
    title: '底部这三个东西',
    body: '「当前实例」决定你现在的操作作用在哪个实例上；账号点一下就能就地加一个离线账号；三个圆按钮切浅色 / 深色 / 跟随系统。'
  },
  {
    page: 'home',
    target: '.hero',
    placement: 'bottom',
    title: '玩就点这一个',
    body: '大按钮「启动游戏」。旁边三个是修东西用的：「重新安装」重下游戏文件，「校验文件」补损坏，「打开目录」直接看文件夹。',
    points: ['留意那行小字里的「启动版本」——它决定你进去是纯净版还是带模组的版本']
  },
  {
    target: '[data-tour="home-log"]',
    placement: 'top',
    title: '出问题先看这里',
    body: '「启动日志」是实时的。游戏起不来、装模组报错，先看最后几行；点「导出」能把整段拷走发给别人。'
  },
  {
    page: 'instances',
    target: '[data-tour="inst-card"]',
    placement: 'bottom',
    title: '一个实例 = 一套独立的游戏环境',
    body: '一个实例里的模组、存档、光影互不影响。想同时玩纯净和整合包，就是建两个实例。',
    points: ['「设为当前」= 以后的操作默认作用在它身上', '「概况 / 设置 / 加载器」是折叠面板，点开就能改']
  },
  {
    page: 'instances',
    click: '[data-tour="inst-seg-info"]',
    target: '[data-tour="inst-versions"]',
    placement: 'right',
    title: '「启动用」标在哪行，就进哪个版本',
    body: '这是最常见的坑：一个实例里同时装了 1.20.1（纯净）和 fabric-loader-…（带模组），只要「启动用」落在纯净版上，你装了 100 个模组进去也只有原版内容。',
    points: ['修法：找到带加载器那一行，点它右边的「用这个启动」', '看到蓝色「启动用」跳过去了，回首页再点「启动游戏」']
  },
  {
    page: 'instances',
    click: '[data-tour="inst-seg-loader"]',
    target: '[data-tour="inst-loader-panel"]',
    placement: 'right',
    title: '给现有实例补加载器',
    body: '纯净实例想玩模组，在这里装：选加载器 → 选版本 → 点「给这个实例装 Fabric」。装完自动切过去，原来的存档和 mods 都不动；装错了点「切回原版」。'
  },
  {
    page: 'download',
    target: '[data-tour="dl-card"]',
    placement: 'bottom',
    title: '装游戏本体',
    body: '选「Minecraft 版本」→ 选「加载器」（纯净就留「原版」）→ 点「下载并安装」。下载源默认走国内镜像，进度按真实字节走，支持断点续传，别关窗口。'
  },
  {
    page: 'resources',
    target: '[data-tour="res-target"]',
    placement: 'bottom',
    title: '装东西前，先看这里',
    body: '「安装到哪个实例」——装错地方等于白装。页面标题下面会显示类似「安装到：xxx（1.20.1 · fabric）」，确认是你要的那个实例和加载器。'
  },
  {
    page: 'resources',
    click: '[data-tour="res-tab-modpack"]',
    target: '[data-tour="mp-search"]',
    placement: 'bottom',
    title: '整合包：新手就走这条',
    body: '搜 Modrinth（免 Key）→ 点「安装最新版」，一键装成一个新实例，会自动下好对应版本的 Minecraft 和加载器。别人给的 .mrpack / CurseForge 压缩包，点「导入本地 .mrpack / .zip」。'
  },
  {
    page: 'manage',
    click: '[data-tour="mg-tab-crash"]',
    target: '[data-tour="mg-diagnose"]',
    placement: 'bottom',
    title: '崩了，先点这一个',
    body: '「一键诊断崩溃原因」内置 12 条规则（内存不够、Java 版本不对、缺前置、模组重复、Mixin 冲突…），直接给出原因和建议。还搞不定就「导出诊断包（日志 + 崩溃 + mod 清单）」发出去，比截图有用。'
  },
  {
    page: 'settings',
    target: '#set-java',
    placement: 'bottom',
    title: 'Java：唯一要懂一点点的东西',
    body: '1.20.5 及以上要 Java 21，1.18–1.20.4 要 17，1.17 要 16，更老的用 8。这里默认是「自动选择（推荐）」，进游戏前发现不对会自己修；缺了也能一键下载。',
    points: ['起不来又报 class file version 之类，八成就是这里']
  },
  {
    page: 'settings',
    target: '#set-download',
    placement: 'bottom',
    title: '下载慢就换源',
    body: '「下载源」选国内镜像 BMCLAPI（推荐）；开了加速器一般把代理留空（跟随系统）。文件本体始终直连多线程下载，只有接口和元数据走代理，这样最快。'
  },
  {
    page: 'home',
    title: '完了，去装个整合包试试',
    body: '记不住也没关系：左边「新手引导」随时能重看；仓库里的 USAGE.md 是同内容的文字版，带截图，遇到问题可以先翻它。',
    points: ['三条保命原则：先看「启动用」→ 再看「安装到哪个实例」→ 崩了先「一键诊断」']
  }
]
