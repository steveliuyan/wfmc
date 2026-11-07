/**
 * app 区域的补充对照表（自动扫描出来的漏翻文案，人工补翻的）。
 * 格式：[中文原文, English]，原文必须和源码里的字面量完全一致（运行时按 trim 后的整段匹配）。
 */
export const PAIRS: [string, string][] = [
  // 侧边栏导航
  ['首页', 'Home'],
  ['实例', 'Instances'],
  ['下载游戏', 'Download Game'],
  ['模组 · 光影', 'Mods · Shaders'],
  ['服务器', 'Servers'],
  ['联机', 'Multiplayer'],
  ['一键开服', 'One-click Hosting'],
  ['皮肤 · 外置登录', 'Skins · External Login'],
  ['内容管理', 'Content Manager'],
  ['通知', 'Notifications'],
  ['设置', 'Settings'],

  // 启动画面
  ['正在加载 WFMC …', 'Loading WFMC …'],

  // 新手引导 / 首次设置
  ['设置完成，去下载游戏吧', 'Setup complete, go download a game'],
  ['已跳过引导，随时可以在「设置」里改', 'Guide skipped, you can change things anytime in Settings'],
  ['三步完成初始化', 'Finish setup in three steps'],
  ['跳过引导，用默认设置（Esc 同效）', 'Skip the guide and use default settings (Esc works too)'],
  ['跳过', 'Skip'],
  ['数据放哪儿？', 'Where should data go?'],
  ['游戏、实例、Java 运行时都会放在这个目录下。默认位置：', 'Games, instances, and Java runtimes all live in this folder. Default location:'],
  ['换个目录', 'Change Folder'],
  ['下一步', 'Next'],
  ['分配多少内存？', 'How much memory?'],
  ['给游戏的最大内存。电脑 16G 内存建议 4–6G，装了光影/大量模组可以再高点。', 'Max memory for the game. On a 16G PC, 4 to 6 GB is recommended, and you can go higher with shaders or many mods'],
  ['上一步', 'Back'],
  ['起个游戏名', 'Pick a game name'],
  ['离线账号的名字，进游戏后显示这个。想玩正版可以稍后在设置里微软登录。', 'This is your offline account name shown in game. For a licensed account, sign in with Microsoft later in Settings'],
  ['完成，开始用', 'Finish and Start'],

  // 账号
  ['正版', 'Licensed'],
  ['外置', 'External'],
  ['离线', 'Offline'],
  ['已切换账号', 'Account switched'],
  ['登录已过期，点这里重新登录', 'Login expired, click here to sign in again'],
  ['微软登录即将过期，点这里续期', 'Microsoft login expiring soon, click here to renew'],
  ['当前实例', 'Current Instance'],
  ['暂无实例', 'No instances yet'],
  ['选择实例', 'Select instance'],
  ['账号', 'Account'],
  ['点一下切换账号', 'Click to switch account'],
  ['未登录', 'Not signed in'],
  ['还没有账号，下面直接加一个离线的，或者去设置里登录正版 / 外置。', 'No accounts yet. Add an offline one below, or sign in with a licensed or external account in Settings'],
  ['离线账号名', 'Offline account name'],
  ['添加', 'Add'],
  ['管理 / 登录正版、外置 →', 'Manage / sign in licensed, external →'],

  // 通知
  ['WFMC 通知', 'WFMC Notification'],
  ['服务端有一条新通知', 'There is a new notice from the server'],

  // 更新
  ['发现新版本', 'New version available'],

  // 主题
  ['浅色主题', 'Light theme'],
  ['深色主题', 'Dark theme'],
  ['跟随系统', 'Follow system'],

  // 拖拽
  ['松手就用这个验证服务器', 'Drop to use this auth server'],
  ['松手就装', 'Drop to install'],
  ['识别到外置登录链接（authlib-injector），松手后自动填好 API 地址并跳到皮肤页', 'Detected an external login link (authlib-injector). Drop it to fill in the API address and jump to the skin page'],
  ['.mrpack / 整合包 zip / 实例包 zip → 安装整合包或导入实例；.jar → 丢进当前实例的 mods', '.mrpack / modpack zip / instance zip → install a modpack or import an instance; .jar → drop into the current instance mods'],
  ['没读到拖进来的内容（可以复制卡片链接再点「粘贴」）', 'Could not read what you dropped (copy the card link and click Paste instead)'],
  ['这不是外置登录链接：请把 LittleSkin 的「Yggdrasil 外置登录」卡片拖进来', 'This is not an external login link: drag in the LittleSkin Yggdrasil external login card'],

  // 命令面板
  ['重看一遍高亮新手引导', 'Replay the highlighted new user guide'],
  ['新手引导', 'New User Guide'],
  ['页面', 'Pages'],
  ['动作', 'Actions'],
  ['检查 Mod 更新', 'Check mod updates'],
  ['看崩溃报告 / 运行日志', 'View crash reports / logs'],
  ['存档快照与回滚', 'Save snapshots and rollback'],
  ['看游戏截图', 'View game screenshots'],
  ['开一个服务端', 'Start a server'],
  ['联机 / 穿透 / 房间码', 'Multiplayer / tunneling / room code'],
  ['换皮肤 / 外置登录', 'Change skin / external login'],
  ['皮肤', 'Skins'],
  ['清理缓存 / 下载 / 日志', 'Clean cache / downloads / logs'],
  ['数据目录占用明细', 'Data folder usage details'],
  ['Java 运行时', 'Java runtime'],
  ['手动指定 / 自动下载', 'Set manually / auto download'],
  ['下载源 / 线程 / 限速', 'Download source / threads / rate limit'],
  ['下载', 'Download'],
  ['内存与性能预设', 'Memory and performance presets'],
  ['性能', 'Performance'],
  ['主题 / 外观 / 语言', 'Theme / appearance / language'],
  ['界面与行为', 'Interface and behavior'],
  ['检查启动器更新', 'Check launcher updates'],
  ['更新', 'Updates'],
  ['致谢 / 关于', 'Credits / about'],
  ['关于', 'About'],
  ['↑↓ 选择 · Enter 打开 · Esc 关闭', '↑↓ select · Enter open · Esc close'],
  ['搜实例 / 模组 / 存档 / 服务器 / 页面 / 设置…', 'Search instances / mods / saves / servers / pages / settings…'],
  ['正在搜…', 'Searching…'],
  ['搜索中…', 'Searching…'],
  ['没有匹配项', 'No matches'],
  ['输入点什么，比如「模组名」「存档名」「java」', 'Type something, like a mod name, save name, or java'],

  // 新手引导步骤（tour-steps）
  ['先花 1 分钟认个路', 'Take a minute to get oriented'],
  ['只说最常用的几个地方，看完就知道该点哪儿。随时可以按 Esc 或点「跳过」退出——以后在左边「新手引导」还能再放一遍。', 'Just the most common spots. After this you will know where to click. Press Esc or click Skip to exit at any time, and you can replay it later from New User Guide on the left.'],
  ['高亮的地方就是这一步要点的东西', 'The highlighted area is what this step wants you to click'],
  ['记不住没关系，装东西的时候照着点就行', 'No need to memorize it, just follow along when installing things'],

  ['左边这十个页面，按用途分', 'These ten pages on the left, grouped by purpose'],
  ['不用一次记全，常用的就前四个加「内容管理」：', 'No need to memorize them all. The common ones are the first four plus Content Manager:'],
  ['首页 —— 点「启动游戏」的地方', 'Home — where you click Launch Game'],
  ['实例 —— 每个游戏环境（模组 / 存档各归各的）', 'Instances — each game environment (mods and saves are separate)'],
  ['下载游戏 —— 装游戏本体、装加载器', 'Download Game — install the game itself and loaders'],
  ['模组 · 光影 —— 装模组、装整合包', 'Mods · Shaders — install mods and modpacks'],
  ['内容管理 —— 看文件、看崩溃报告；设置 —— 下载源 / Java / 账号', 'Content Manager — browse files and crash reports; Settings — download source / Java / accounts'],

  ['底部这三个东西', 'These three at the bottom'],
  ['「当前实例」决定你现在的操作作用在哪个实例上；账号点一下就能就地加一个离线账号；三个圆按钮切浅色 / 深色 / 跟随系统。', 'Current Instance decides which instance your actions apply to; click the account to add an offline account right here; the three round buttons switch light / dark / follow system.'],

  ['玩就点这一个', 'To play, click this one'],
  ['大按钮「启动游戏」。旁边三个是修东西用的：「重新安装」重下游戏文件，「校验文件」补损坏，「打开目录」直接看文件夹。', 'The big Launch Game button. The three beside it are for repairs: Reinstall re-downloads game files, Verify Files repairs damage, Open Folder shows the directory.'],
  ['留意那行小字里的「启动版本」——它决定你进去是纯净版还是带模组的版本', 'Note the Launch Version in the small text — it decides whether you enter vanilla or the modded version'],

  ['出问题先看这里', 'Look here first when something goes wrong'],
  ['「启动日志」是实时的。游戏起不来、装模组报错，先看最后几行；点「导出」能把整段拷走发给别人。', 'The launch log is live. If the game will not start or mods error out, check the last lines first; click Export to copy the whole thing and send it to someone.'],

  ['一个实例 = 一套独立的游戏环境', 'One instance = one independent game environment'],
  ['一个实例里的模组、存档、光影互不影响。想同时玩纯净和整合包，就是建两个实例。', 'Mods, saves, and shaders in one instance do not affect each other. To play both vanilla and a modpack, just create two instances.'],
  ['「设为当前」= 以后的操作默认作用在它身上', 'Set as Current means future actions default to it'],
  ['「概况 / 设置 / 加载器」是折叠面板，点开就能改', 'Overview / Settings / Loader are collapsible panels, open them to make changes'],

  ['「启动用」标在哪行，就进哪个版本', 'Whichever row is marked Launch With is the version you enter'],
  ['这是最常见的坑：一个实例里同时装了 1.20.1（纯净）和 fabric-loader-…（带模组），只要「启动用」落在纯净版上，你装了 100 个模组进去也只有原版内容。', 'This is the most common trap: an instance may have both 1.20.1 (vanilla) and fabric-loader-… (modded). If Launch With lands on the vanilla row, even 100 mods will give you vanilla content.'],
  ['修法：找到带加载器那一行，点它右边的「用这个启动」', 'Fix: find the row with the loader and click Launch With This on its right'],
  ['看到蓝色「启动用」跳过去了，回首页再点「启动游戏」', 'Once you see the blue Launch With move over, go back home and click Launch Game again'],

  ['给现有实例补加载器', 'Add a loader to an existing instance'],
  ['纯净实例想玩模组，在这里装：选加载器 → 选版本 → 点「给这个实例装 Fabric」。装完自动切过去，原来的存档和 mods 都不动；装错了点「切回原版」。', 'To play mods on a vanilla instance, install here: pick a loader, pick a version, then click Install Fabric for This Instance. It switches over automatically and leaves your saves and mods untouched; if you pick wrong, click Switch Back to Vanilla.'],

  ['装游戏本体', 'Install the game itself'],
  ['选「Minecraft 版本」→ 选「加载器」（纯净就留「原版」）→ 点「下载并安装」。下载源默认走国内镜像，进度按真实字节走，支持断点续传，别关窗口。', 'Pick a Minecraft Version, pick a Loader (leave Vanilla for clean play), then click Download and Install. The source defaults to a domestic mirror, progress tracks real bytes, resume is supported, so keep the window open.'],

  ['装东西前，先看这里', 'Before installing anything, check here'],
  ['「安装到哪个实例」——装错地方等于白装。页面标题下面会显示类似「安装到：xxx（1.20.1 · fabric）」，确认是你要的那个实例和加载器。', 'Install to which instance — the wrong target means a wasted install. Under the page title it shows something like Install to: xxx (1.20.1 · fabric), so confirm it is the right instance and loader.'],

  ['整合包：新手就走这条', 'Modpacks: the beginner path'],
  ['搜 Modrinth（免 Key）→ 点「安装最新版」，一键装成一个新实例，会自动下好对应版本的 Minecraft 和加载器。别人给的 .mrpack / CurseForge 压缩包，点「导入本地 .mrpack / .zip」。', 'Search Modrinth (no key needed), click Install Latest to set up a whole new instance in one click, with the matching Minecraft and loader downloaded automatically. For a .mrpack / CurseForge archive from someone else, click Import Local .mrpack / .zip.'],

  ['崩了，先点这一个', 'Crashed? Click this first'],
  ['「一键诊断崩溃原因」内置 12 条规则（内存不够、Java 版本不对、缺前置、模组重复、Mixin 冲突…），直接给出原因和建议。还搞不定就「导出诊断包（日志 + 崩溃 + mod 清单）」发出去，比截图有用。', 'One-click Crash Diagnosis has 12 built-in rules (not enough memory, wrong Java version, missing dependency, duplicate mods, Mixin conflicts…) and gives you the cause and advice directly. If that still does not solve it, click Export Diagnostic Bundle (logs + crash + mod list) and send it out, which beats a screenshot.'],

  ['Java：唯一要懂一点点的东西', 'Java: the one thing you need to understand a little'],
  ['1.20.5 及以上要 Java 21，1.18–1.20.4 要 17，1.17 要 16，更老的用 8。这里默认是「自动选择（推荐）」，进游戏前发现不对会自己修；缺了也能一键下载。', '1.20.5 and up need Java 21, 1.18–1.20.4 need 17, 1.17 needs 16, older versions use 8. It defaults to Auto Select (recommended), which fixes itself if something looks wrong before launch, and a missing Java can be downloaded in one click.'],
  ['起不来又报 class file version 之类，八成就是这里', 'If it will not start and reports something like class file version, this is almost certainly it'],

  ['下载慢就换源', 'Slow downloads? Switch the source'],
  ['「下载源」选国内镜像 BMCLAPI（推荐）；开了加速器一般把代理留空（跟随系统）。文件本体始终直连多线程下载，只有接口和元数据走代理，这样最快。', 'For Download Source pick the domestic mirror BMCLAPI (recommended); if you use an accelerator, usually leave the proxy empty (follow system). File downloads always use direct multi-threaded connections and only the API and metadata go through the proxy, which is the fastest.'],

  ['完了，去装个整合包试试', 'Done, go try installing a modpack'],
  ['记不住也没关系：左边「新手引导」随时能重看；仓库里的 USAGE.md 是同内容的文字版，带截图，遇到问题可以先翻它。', 'If you forget, no problem: replay New User Guide on the left anytime, and USAGE.md in the repo is the same content in text with screenshots, so check it first when you run into trouble.'],
  ['三条保命原则：先看「启动用」→ 再看「安装到哪个实例」→ 崩了先「一键诊断」', 'Three rules to live by: check Launch With first, then Install to Which Instance, and on a crash run One-click Diagnosis first']
]
