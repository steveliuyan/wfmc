# WFMC · WanFan Minecraft Launcher

一个 PCL2 / HMCL / Daybreak 风格的 Minecraft 启动器：下载游戏、装整合包、装模组/光影、**联机三件套**、**一键开服**、Mod 更新检查、崩溃诊断。
**浅色 / 深色 / 跟随系统**三种主题，Electron + React + TypeScript，内核用 MIT 的 `@xmcl/*`。

> **开源仓库**：https://github.com/steveliuyan/wfmc · **下载**：https://github.com/steveliuyan/wfmc/releases
> 许可证 MIT（见 `LICENSE`），分发须知见 `NOTICE.md`，免责声明见 `DISCLAIMER.md`。

## 快速开始（从源码）

```powershell
npm install                              # 装依赖（国内建议先设 ELECTRON_MIRROR）
npm run dev                              # 开发模式（热更新）
npm run build                            # 编译主进程 + 渲染层
npm run dist                             # 打便携版 + 安装版（release/ 目录）

# 只打其中一个：
npm run dist:portable                    # WFMC-Portable-<ver>.exe
npm run dist:setup                       # WFMC-Setup-<ver>.exe（可选安装位置）
```

> 国内网络打包前设两个镜像环境变量（否则 electron 二进制下不动）：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`

需要 Node 20+；详细架构、IPC 全表、二次开发样板、服务端集成契约见 **`HANDOFF.md`**。

- 免安装包（历史版本示例）：`release\WFMC-Portable-1.0.2.exe`
- 品牌：万凡科技 · 靛紫电光 `#372FA2` / `#06B6D3`
- 图标 / 动画 / 配色取自 `H:\万凡图标\output_v2\靛紫电光`（图形_扁平双色 + Lottie 进场动画）

---

## 1. 功能总览

### 界面
- 主题：**浅色（白底默认）/ 深色 / 跟随系统**，侧边栏一键切 + 设置页三张预览卡
- 动画：启动画面播品牌「进场」Lottie、首页 hero 常驻动效、导航图标 hover/选中动效、进度条流沙、按钮扫光
- 首启三步引导（目录 → 内存 → 用户名）、窗口位置记忆、旧数据目录自动迁移

### 游戏安装与启动
- 官方 / BMCLAPI 双源；自研下载器（并发可调、断点跳过、镜像回退、真实进度）
- 原版全量安装、Fabric / Quilt / Forge / NeoForge（Forge 跑官方 installer）
- Java 自动扫描 + 按版本挑主版本 + 缺了自动下 Mojang 运行时
- **版本数据隔离**：实例内每个版本可用独立存档/mods/config（libraries、assets 共享）
- 实例：内存、指定 Java、JVM 参数、窗口大小/全屏、启动直连、复制、**导出/导入 zip**、体积统计
- 版本管理：多版本共存、切启动版本、删版本；文件校验修复；实时日志；累计游玩时长

### 账号
- 离线账号（UUID 由用户名派生）+ 微软正版设备码登录 + 令牌刷新

### Mod 生态
- Modrinth 搜索安装（按实例版本/加载器过滤、自动补前置）、本地导入、启用禁用、删除
- 整合包：Modrinth 在线安装 + `.mrpack` / CurseForge `.zip` 导入
- **Mod 自动更新**：用每个 jar 的 SHA1 去 Modrinth 反查最新版，一键升级（旧文件保留 `.old`）

### 联机（三件套）
1. **局域网直连**：监听 Minecraft 的 `224.0.2.60:4445` 广播，自动发现同网络下的「对局域网开放」世界，点一下直接进
2. **P2P 直连**：SSDP 找到你家路由器 → UPnP 自动加 TCP 端口映射 → 把「公网IP:端口」发给好友（不过第三方，延迟最低）；再配 STUN 查公网出口
3. **公网中继穿透**：路由器不让映射时，用 `bore.pub` 公共中继起隧道，自动下载 bore 客户端并给出 `bore.pub:xxxxx`

### 一键开服
- Vanilla / **Paper**（走 PaperMC v3 API）服务端一键下载 → EULA 确认 → 启动/停止
- 内置控制台（`list` / `op` / `stop`…）、`server.properties` 可视化编辑、日志流、端口同步

### 诊断与其它
- 崩溃诊断（12 条规则，给原因 + 建议 + 证据行）、服务器状态查询（SLP 自研，含 SRV）
- 存档备份 zip、内容管理、日志导出、HTTP/SOCKS5 代理、Aikar G1GC 参数一键填入
- **致谢页**：设置里列出所有参考/依赖的项目（作者、许可证、借鉴了什么）

## 2. 参考与致谢（设置里也有这一页）

| 项目 | 作者 | 许可 | 借用了什么 |
|---|---|---|---|
| XMCL / x-minecraft-launcher | Voxelum | MIT | **内核底座**：`@xmcl/core/installer/user/modrinth`，实例隔离设计 |
| Daybreak 破晓启动器 | gan4012 | MIT | 功能对标：服务器列表+SRV+一键进服、崩溃诊断规则、首启引导、主题三选一 |
| HMCL | HMCL-dev | GPL-3.0 | 功能分区、Java 匹配策略、镜像思路 |
| PCL2 | 龙腾猫跃 / Meloong-Git | 自定义 | 单页卡片交互、一键安装流程 |
| PrismLauncher | PrismLauncher Team | GPL-3.0 | 实例级设置面板形态、内容管理 |
| MultiMC | MultiMC Contributors | 自定义 | 「一个实例一套独立目录」的原始设计 |
| ATLauncher | ATLauncher | GPL-3.0 | 整合包管理信息组织 |
| HeliosLauncher | Daniel Scalzi | MIT | Electron 启动器工程结构 |
| GDLauncher | GorillaDevs | GPL-3.0 | 实例卡片 / 资源浏览布局 |
| PandoraLauncher | Moulberry | MIT | 性能向默认值取舍 |
| FreesmLauncher | FreesmTeam | GPL-3.0 | 账号切换 / Java 选择器交互 |
| MojoLauncher | MojoLauncher | LGPL-3.0 | 轻量启动流程参考 |
| PojavLauncher | PojavLauncherTeam | LGPL-3.0 | 跨平台参数拼装参考 |

依赖库：`@xmcl/*`(MIT)、Electron(MIT)、React(MIT)、lottie-web(MIT)、Vite/esbuild/electron-builder(MIT)、bore(MIT，内网穿透客户端)。
数据源：Mojang 版本清单/Java 运行时、**BMCLAPI**（bangbang93，国内镜像）、FabricMC Meta、QuiltMC Meta、Forge / NeoForged Maven、Modrinth API、CurseForge API、PaperMC v3 API。

> 同类启动器只借鉴功能设计与规则思路，**没有复制它们的代码**（除上方明确标为依赖的库）。

## 3. 目录结构

```
H:\mcqidongqi
├─ build\            # 应用图标 icon.png / icon.ico（多尺寸）
├─ scripts\          # 构建 / 冒烟 / 集成测试 / 排障探针
├─ src\shared\       # types.ts（共用类型）、credits.ts（致谢数据）
├─ src\preload\      # contextBridge
├─ src\main\
│  ├─ index.ts / ipc.ts / store.ts / net.ts / proc.ts / proxy.ts
│  ├─ game.ts / minecraft.ts / natives.ts / zip.ts / java.ts
│  ├─ instances.ts / paths.ts（版本隔离）/ launch.ts / accounts.ts
│  ├─ modrinth.ts / modpack.ts / modupdates.ts（Mod 更新）
│  ├─ servers.ts（SLP+SRV）/ netshare.ts（局域网·UPnP·STUN·穿透）
│  ├─ serverhost.ts（一键开服）/ crash.ts（崩溃诊断）/ content.ts（内容/备份/导入导出）
└─ src\renderer\     # App / store / api / styles + views:
                     # Home / Instances / Download / Resources / Servers / Online / Hosting / Manage / Settings
```

## 4. 常用命令

```powershell
cd H:\mcqidongqi
npm install
npm run build      # 编译主进程 + 渲染层
npm start          # 运行（或 npx electron .）
npm run dev        # 热更新开发
npm run dist       # 打包 → release\WFMC-1.0.0.exe
npm run smoke      # 内核冒烟测试
```

数据目录 `%APPDATA%\WFMC\data`：`settings.json / accounts.json / servers.json / instances\<名>\minecraft / servers\<服务端> / java / exports / backups / tools`。

## 5. 实测记录（本机真跑，不是理论）

```
内核测试：版本清单 920 个；完整安装 1.0 用时 12.3s；1.20.1 64 libraries；generateArguments 41 参数
启动测试：1.20.1 全量安装 → 21 个 native 包解压(67ms) → launch → 渲染线程 Created atlas → 窗口 ready ✅
服务器查询：mc.hypixel.net → online 608ms 13291/200000 "Requires MC 1.8 / 1.21"
版本隔离：isolate=true → instances\x\minecraft\versions\1.20.1\game
STUN：公网端点 223.160.224.211:44031（本机内网 192.168.0.241）
一键开服：Paper 1.20.1 build 196（43MB）下载 → 启动 → 日志出现 Done ✅ → stop 正常落盘
内网穿透：bore 隧道建立 → bore.pub:13705 ✅
局域网监听：UDP 4445 绑定成功（首次会弹 Windows 防火墙，需允许）

## 6. 踩坑记录（都已在代码里处理）

1. yauzl / @xmcl/unzip 在 Node 24 读多条目 zip 会卡死 → 自写 `zip.ts`（EOCD + inflateRaw，读写都有）
2. BMCLAPI 全站 302 + 签名 CDN → installer 的 undici 报 maxRedirections → 自研 `game.ts` 走全局 fetch
3. `@xmcl/unzip@2.2.0` 是坏发布 → 锁 2.1.2 + 显式 dependency
4. Forge/NeoForge 别用库内安装（也要读 installer zip）→ 跑官方 installer jar
5. scanLocalJava 可能返回安装目录 → normalize 到 bin\java.exe
6. **PaperMC /v2 API 已 410 Gone** → 改 v3（fill.papermc.io，downloads['server:default'].url）
7. **api.github.com 在本机 fetch 不通** → bore 客户端下载改为「API → 固定版本直连 → 两个 GitHub 镜像」四级回退
8. 局域网发现要 UDP 4445 → 首次启动会弹防火墙，需点允许

## 7. 已知边界

- P2P 直连依赖路由器开启 UPnP；运营商大内网（无公网 IP）只能走中继
- 公网穿透走 `bore.pub` 公共中继，延迟受中继影响，适合小服/朋友玩
- 一键开服目前支持 Vanilla / Paper；Forge/Fabric 服务端、开服插件管理未做
- 微软登录要自备 Azure 公共客户端 ID；CurseForge 在线搜索要自备 API Key（Modrinth 全免）
- 进度条是「文件个数」粒度，不是按字节的精确百分比

## 8. 许可

项目 MIT。所有依赖库均为 MIT / 各自开源许可；品牌素材为万凡科技自有。


---

## 9. 第二批新增（外置登录 / 皮肤 / 房间码 / 预设 / 快捷操作）

### 外置登录与皮肤（LittleSkin 等 authlib-injector 服务）
- **登录**：填 Yggdrasil API 根地址（默认 `https://littleskin.cn/api/yggdrasil`）+ 邮箱密码，登录后自动注入 `authlib-injector`（1.2.8，实测 1.3s 下载 341KB）
- **角色管理**：登录返回角色列表，点一下切换（走 `/authserver/refresh` + `selectedProfile`）
- **皮肤预览**：canvas 直接按皮肤贴图画正面小人（经典/Alex 两种手臂宽度），披风单独展示 —— 零第三方依赖
- **换肤 / 换披风 / 清除**：走 authlib-injector 的 `setTexture` 扩展接口，本地 png 直接拖进窗口也能上传
- **拖拽卡片识别**：LittleSkin 的「Yggdrasil 外置登录」卡片拖进窗口 → 自动解析 `authlib-injector:yggdrasil-server:<url>`
- **令牌加密**：账号令牌用 Electron `safeStorage`（Windows DPAPI）加密后再落盘
- **多账号**：侧栏/设置里切换当前账号，启动用当前选中的那个

### 联机码（房间号）
- 把「地址:端口」压成短码：IPv4 → `LQNQ-9JGJ-KZVS`（12 位），域名 → 20 位左右；XOR + Base32，含格式校验
- 好友输码即解码进服（`--server` 直连），同局域网码 / 公网码各生成一个

### 其他
- **性能预设**：低配 / 均衡 / 高配 / 光影 四档，一键写 JVM 参数 + `options.txt`（视距、粒子、实体阴影、帧率上限）
- **全局搜索**：`Ctrl+K` 搜页面 / 实例 / 动作，Enter 直达
- **拖拽安装**：把 `.mrpack` / 整合包 zip / 实例包 zip / `.jar` 拖进窗口直接装（自动判别类型）
- **窗口位置校验**：记住的位置如果落在已断开的显示器上，会自动回落到主屏（踩过这个坑）

---

## 10. 第三 / 四 / 五批新增（任务队列、体检、开服进阶、运维、测速）

### 任务队列 + 分片下载
- `src/main/tasks.ts`：所有长任务统一注册（安装 / 整合包 / 资源 / 开服 / 导出），右下角浮动面板显示进度、可**取消**、可清空
- 取消链路真接了 `AbortSignal`：`net.downloadFile` / `downloadAll` / `game.installVanilla` 全程认 signal
- **HTTP Range 分片下载**：≥4MB 的文件自动切成 4 片并发，服务器不支持 Range 时**静默退回单流**（实测同一文件两条路径都能跑通）

### Mod 体检（离线）
- 读每个 jar 里的 `fabric.mod.json` / `META-INF/mods.toml` / `mcmod.info`，提取 modId / 加载器 / 依赖
- 检查：**重复 modId**、**加载器不匹配**、**缺前置**、`.old`/`.disabled` 残留
- 实测：造两个同 modId 的 jar → 正确报「重复的模组：sodium」；造一个依赖 sodium-extra 的 → 正确报缺前置

### 整合包导出（.mrpack）
- mods 逐个算 SHA1 → Modrinth `getProjectVersionsByHash` 反查 → 能查到的只写下载地址（包体极小），查不到的塞进 `overrides/mods`
- `config/ resourcepacks/ shaderpacks/ defaultconfigs/ scripts/ options.txt` 一并进 `overrides/`
- 实测：3 个假 mod（Modrinth 无记录）→ 正确全部落入 overrides，回读 `modrinth.index.json` 的 name/deps 都对

### 自动更新器 + CI
- `settings.updateUrl` 指向自托管 `update.json`（`{version,url,notes}`），比对版本 → 下载新 exe → 写替换脚本 → 自动重启
- 便携版用 `PORTABLE_EXECUTABLE_FILE` 找到用户真正启动的那个 exe 再替换
- **便携模式**：数据目录跟着 exe 走（`PORTABLE_EXECUTABLE_DIR/WFMC-Data`）
- `.github/workflows/build.yml`：npm ci → typecheck → smoke → build → electron-builder → 上传产物；打 tag 自动发 Release

### 一键开服进阶：Fabric / Forge / NeoForge
- **Fabric**：Fabric 撤掉了 `/server/jar` 接口（实测 404），改用官方 installer 的 `server -mcversion -loader -downloadMinecraft`，实测 40.8s 装好并生成 `fabric-server-launch.jar`
- **Forge / NeoForge**：下 installer 跑 `--installServer`，然后自动找 `libraries/**/win_args.txt` 用 `@args` 方式启动（老版本自动回退到 universal jar）
- 版本列表：fabric 255 个、forge 137 个（1.20.1 实测）；NeoForge 从 1.20.2 才有，选 1.20.1 会是空列表（符合上游事实）

### 服务端运维
- **白名单 / OP 管理**：直接读写 `whitelist.json` / `ops.json`，改完可以一键让服务端 `whitelist reload`
- **世界备份**：`world*` + 配置打包进 `data/backups/servers/`（实测生成 zip）
- **在线玩家 / TPS**：从服务端日志里解析 joined/left 与 TPS 行

### 其它
- **下载源测速**：并发探测 BMCLAPI / 官方（失败按 9999ms 重罚，避免误判），给出建议源一键切换
- **资源包排序**：直接改 `options.txt` 的 `resourcePacks:["file/B.zip","file/A.zip","vanilla"]`，支持上移/下移/停用
- **诊断包导出**：日志 + 最近 10 个崩溃报告 + mod 清单 + 实例概要，打成 zip 一条龙（实测 0.9KB 小包）
- **局域网世界一键分享**：局域网列表每行多一个「分享到公网」，直接把该世界端口挂到 bore 隧道
- **临时文件清理**：清 `temp/`、3 天前的导出包、所有 `.part` 半截下载

---

## 11. 第六 / 七批新增（皮肤 3D、数据面板、音乐、主题、i18n、CF、榜单、MOTD、数据包、包更新、错误上报）

### 皮肤真 3D 预览
- 接入 `skinview3d` 3.4.2 + three：可拖动旋转、自动慢转、Idle 动画、披风一起显示；没皮肤时回落 canvas 手绘 2D

### 数据面板（首页）
- 每个实例的游玩时长排行柱状图 + 总量统计（实例数 / 总时长 / 已装数量）

### 音乐播放器
- 悬浮圆钮 → 面板：播放/暂停/上一首/下一首/音量/歌单；歌单目录 `data/music`，支持一键导入（实测导入→列表→删除全通）
- 播完自动下一首

### 主题编辑器
- 主色取色器 + 6 个预设色块 + 圆角滑杆（0–26px）+ 背景图选择，实时改写 `--accent` / `--radius` / body 背景
- 「恢复默认外观」一键还原

### i18n（中英）
- `src/renderer/i18n.ts` 词典 + 语言开关；导航栏整条支持中英切换，缺 key 自动回退中文
- 实测：`nav.online` → 联机 / Multiplayer，未知 key 回退 fallback

### CurseForge 搜索
- `CurseforgeV1Client` + 自备 API Key：按当前实例的版本/加载器筛，可单个安装或一键装前 3
- 无 Key 时给明确指引（实测报错文案正确）

### 模组榜单
- 资源页加排序条：下载最多 / 关注最多 / 最新发布 / 相关度（Modrinth `index` 参数）

### MOTD 缓存
- 每次查询把 `motd / 图标 / 在线人数 / 时间` 写回 `servers.json`；进页面先用缓存渲染，图标直接显示
- 实测：hypixel 查询 2688ms，缓存写入 lastStatus + icon + lastChecked 全部落盘

### 数据包（存档级）
- 世界选择器 → 列出/导入/启用停用/删除 `saves/<世界>/datapacks`
- 停用即改名 `.disabled`（实测重命名与列表状态正确）

### 整合包更新检测
- 安装时记录 `packSource{kind,projectId,versionId}`；Modrinth 来源可比对 `getProjectVersions` 判断有无新版
- 本地/CF 包给出「无可比对版本号」的明确说明（实测文案正确）

### 错误上报（本地）
- `src/main/errlog.ts`：主进程未捕获异常、未处理 Promise、渲染进程崩溃、前端 `window.onerror` / `unhandledrejection` 全部写 `data/logs/errors.log`（超 1MB 滚动）
- 诊断包自动带上 `launcher-errors.log`

### 便携模式修正（本轮踩的坑）
- 便携版**跳过旧数据迁移**（原来会把几百 MB 的老实例拷进 U 盘目录，启动像卡死）
- 便携版**强制**用 `PORTABLE_EXECUTABLE_DIR/WFMC-Data` 作为数据目录
- `settings.json` 归启动器根目录、`accounts.json` 跟数据目录走；首次启动就把默认值落盘
- 实机验证：`release\WFMC-Data\settings.json` 里 `dataDir = H:\mcqidongqi\release\WFMC-Data`，窗口标题 WFMC 正常

### 其它实测记录（第 6/7 批）
```
截图：列 1 张 → 越界删除被拒（路径不在实例目录内）→ 正常删除后 0 张
歌单：导入 1 首 → 列表正确 → 删除后 0 首
数据包：存档列表 ["测试世界"] → 导入 1 → 停用 → 启用 → 删除后 0
令牌加密：磁盘出现 enc:djEw...（DPAPI），内存读回明文 SECRET-TOKEN-123
CF：无 Key 时提示「先去设置里填 CurseForge API Key」
i18n：zh 联机 / en Multiplayer / 未知 key 回退 fallback
```

---

## 12. 交互细节补丁

- **首启引导可跳过**：右上角「跳过」按钮 + 按 Esc 同效，只记 `onboarded=true`，其余保持默认
- **下载源就地切换**：下载游戏页（原版/加载器卡片）、整合包卡片、模组·光影·资源包页顶部都有「下载源」下拉（国内镜像 / Mojang 官方），改完即时生效并记忆
- **音乐按钮不再重叠**：从固定悬浮改为侧边栏主题行内联（♪ / ♫），播放面板仍是浮层，不会被侧栏裁切
- **统一动效层**：遮罩淡入 `maskIn`、弹层弹入 `popIn`（带回弹曲线）、卡片与列表交错上浮、进度条平滑生长、输入框焦点光晕、标签页按压缩放；并加 `prefers-reduced-motion` 全局降级
- **确认框换成应用内弹窗**：删实例 / 删版本 / 删内容文件 / 删服务端不再用系统 `confirm`，改用带动效的应用内对话框（危险操作红色按钮，Esc 取消、Enter 确认）
- **开发自检**：`WFMC_SHOT=<png>` + `WFMC_SHOT_PAGE=<页面>` 可让主进程启动后自截一张窗口图（不受其它窗口遮挡），用于布局回归

---

## 13. 交互第二轮（悬浮播放器、外置登录拖拽、自绘下拉框）

### 音乐播放器改成「悬浮弹窗」
- 点一下 ♪ 打开，鼠标可以移到面板上选歌/按播放/调音量；**鼠标移开 280ms 自动收回**（留缓冲防手抖）
- 面板与图标之间有一块透明「桥」，从图标移向面板不会误触收起；Esc 也能关
- 顺手修掉一个定位 bug：基础规则里的 `left/bottom` 在 `position: relative` 下会再次位移，导致 ♪ 压住 ☀ 主题按钮 → 现在 `.music.inline` 显式 `left/right/top/bottom: auto`

### LittleSkin 外置登录拖拽修好
- 原因：原来只在「拖文件」时 `preventDefault`，LittleSkin 卡片拖的是 **链接**（`text/uri-list`），浏览器根本不会触发 drop
- 现在全局监听任意拖拽：拖链接进来 → 解析 `authlib-injector:yggdrasil-server:<url>` → 存进 `settings.yggdrasilApi` → 自动跳到「皮肤 · 外置登录」页并填好地址
- 兜底：Skin 页新增「从剪贴板识别」按钮（读剪贴板里的卡片链接或 URL），拖不动也能一步填好
- 拖拽遮罩文案也跟着区分：`松手就装`（文件） / `松手就用这个验证服务器`（链接）

### 原生下拉框换成自绘 Select
- 系统 `<select>` 的下拉框样式改不了、零动效，现在换成 `components/Select.tsx`：
  - 弹层 `popIn` 动画 + 箭头旋转 + 当前项 ✓ + 悬停高亮
  - 选项 > 12 自动出搜索框（900+ 个 MC 版本也能秒选）
  - 键盘：↑↓ 移动、Enter 选中、Esc 关闭；点外面关闭
- 已替换：下载游戏页（MC 版本 / 加载器 / 加载器版本）、资源页（加载器筛选）、下载源选择器、一键开服（服务端类型 / 游戏版本 / 加载器版本）、设置（下载源 / Java）、实例设置（指定 Java）、侧边栏（当前实例）

### 其它
- Modrinth 网络失败时的提示改成「搜不到 Modrinth：网络可能被墙/超时，换个网络或稍后再试」，不再甩一串 `TypeError: fetch failed`
- 调试钩子增强：`WFMC_SHOT_JS`（截图前先跑一段 JS，用来截下拉框展开态）、`WFMC_SHOT_DOM`（导出关键节点几何信息）、`WFMC_SHOT_MUSIC=1`（强制开音乐面板）

---

## 14. 交互第三轮（搜索清除、换一批、免责声明、交接文档）

### 搜索框一键清除
- 模组·光影页、下载游戏（整合包）页的搜索框右侧加了 ✕ 按钮，点一下清空并重新拉列表（`components` 里的 `.search-wrap` + `.search-clear`）

### 列表底部「换一批」
- 模组·光影页与整合包页的卡片列表底部加了「换一批」按钮 + 计数（`已看 24 / 共 77679 个`）
- 走 Modrinth 的 `offset` 分页，每次 +24；到底后自动回到开头，不会越翻越空

### 免责声明（软件内 + 文档）
- 新增 `src/shared/disclaimer.ts`（9 节：非官方 / 游戏授权自负 / 账号与凭据 / 本地数据 / 联机与端口 / 第三方服务 / 素材与致谢 / 按现状提供 / 条款变更）
- 首启**强制确认**：`不同意并退出` / `我已阅读并同意`（同意后写 `settings.disclaimerAccepted`，之后不再弹）
- 设置 → 关于 → 「查看免责声明」随时可读
- 同内容落成 `DISCLAIMER.md`，供分发时一并带上

### 交接文档
- 新增 `HANDOFF.md`：架构、34 个主进程模块职责、125 个 IPC 通道全表、数据目录与 JSON 格式、7 条关键时序、二次开发样板（加页面 / 加 IPC / 加设置项）、**服务端集成契约**（公告 / 备份 / 云同步的 API 设计 + 客户端接入点 + 安全清单）、备份恢复建议、调试钩子、已知限制、13 条踩坑

---

## 15. 开服页体验重做（停止不再卡、控制台与设置说人话）

### 停止服务端不再"假死"
- 原逻辑：`stop` 后**同步等**进程退出（最多 15s），IPC 才返回 → 按钮像卡住，用户不知道发生什么
- 现在：`hosted:stop` **立刻返回**，后台发 `stop` 并起 12 秒兜底强杀；前端按钮变「正在保存…」并多出 **「强制结束」** 按钮，真正退出时由 `event:host-exit` 自动复位
- 用户能看见的三件事：按钮文案变化 / toast 说明「最多等 12 秒会自动强制结束」/ 想快就点强制结束

### 控制台从"给专业人看的"改成"点就会用"
- 顶部加一排常用操作：**看谁在线 / 保存世界 / 切成白天 / 天气放晴 / 重载白名单 / 保存并关服**（点一下直接执行，不用记命令）
- 输入框提示改成 `也可以直接打字，比如 say 大家好、op 玩家名`
- 底部加一句说明：这里是直接对服务器说话，不确定就先点常用按钮

### 服务器设置从"原始文本"改成图形化表单
- 常用项全部中文化 + 一句人话解释：服务器标语 / 端口 / 最多玩家 / **正版验证（开=只让正版进，关=离线朋友也能进）** / 白名单模式 / 难度 / 默认游戏模式 / PVP / 视距 / 允许飞行
- 布尔项用下拉而不是 `true/false`；改完点「保存设置」，只改这些键，**其它行（注释、未知键）原样保留**
- 想直接编辑原文的点「高级：直接改原始文件」，展开 textarea，并明确提示改错会导致开不了服

### 面板展开状态可见（修"点了没反应"）
- 原来 控制台 / 配置 / 玩家管理 三个按钮点开之后按钮**没有任何变化**，用户得往下翻才知道是否展开
- 现在：按钮加 `.on` 高亮（主题色描边 + 文字）+ `▾/▴` 箭头；**同一个服务端同时只展开一个面板**（点开新的自动收起旧的），逻辑不再叠加混乱
- 面板本身带 `fadeUp` 出现动画

---

## 16. 下拉层级 / 选中收口 / 提示位置

### 下拉框不再被下面卡片盖住
- 原因：卡片带 `animation`/`transform` 会各自形成层叠上下文，后渲染的卡片压在展开的下拉之上
- 修法：`.sel.open { z-index: 340 }`、`.sel-pop { z-index: 360 }`，并用 `.card:has(.sel.open) { position: relative; z-index: 60 }` 把「含展开下拉的那张卡」整体抬起来
- 实测：开服页展开「服务端类型」时，弹层完整覆盖下方「还没有服务端」卡片

### 选中后必定收起、不再跳到顶部
- 加 `justPicked` 标记：选中瞬间的后续 mousedown 不会又把下拉点开
- 打开时只在**确实找到当前选中项**时才 `scrollIntoView`；找不到（数据还没回来）就老实停在顶部，不乱跳
- 实测：点第一项 → 下拉关闭、值变成 `26.4-snapshot-5 (snapshot)`

### 提示条改到底部居中
- 原来固定在右下角，和「后台任务」面板叠在一起
- 现在 `left:50%; transform:translateX(-50%); bottom:26px; z-index:350`，任务面板仍在右下，二者互不干扰（截图确认）

### 网络错误说人话 + 源自动兜底
- 新增 `friendlyError()`：`fetch failed / ETIMEDOUT / ENOTFOUND / ECONNRESET` → 「网络连不上（可能被墙或超时），换个下载源或稍后重试」；404/410、5xx、abort 各有对应文案
- 安装、整合包安装、导入、开服、实例操作等失败提示统一走它
- `listRemoteVersions()` 改成**双源兜底**：镜像清单拉不到自动试官方清单（反之亦然），两个都不通才报错

---

## 17. 下载进度残留 & 模组服开服

### 下载进度不再堆积、可清空
- **根因**：每点一次「下载并安装」都会 `createInstance` 新建一个实例 → 进度 key 随之变化 → 每次失败留一条 0%，且实例列表也跟着长垃圾
- 修法三条：
  1. **复用实例**：同名 + 同版本 + 同加载器的实例直接复用，不再新建
  2. **失败清理**：本次新建的实例若安装失败，自动删掉并清空进度（`clearProgress()`）
  3. **手动清空**：「下载进度」标题右边加了「清空」按钮，随时能扔掉残留条目

### 一键开服支持模组服（整合包 / 实例直接开）
- 新建服务端多了「怎么建」二选一：
  - **开个空白新服**（原来的 Paper/Vanilla/Fabric/Forge/NeoForge）
  - **照现有实例开（带 mod）**：选一个实例 → 自动按它的 MC 版本与加载器建服 → 把该实例的 `mods/*.jar`、`config/`、`defaultconfigs/` 一起搬进服务端
- 加载器映射：Fabric→Fabric、Quilt→Fabric（服务端侧兼容）、Forge→Forge、NeoForge→NeoForge、原版→原版服
- 已有服务端卡片上（Fabric/Forge/NeoForge）多了 **「模组 (n)」** 按钮，展开可以：
  - **从实例导入**：挑一个实例把它的 mods 搬过来
  - **从整合包文件导入**：选 `.mrpack` 或带 `mods/` 的整合包 zip —— mrpack 会按 `index.json` 下载每个 mod，并把 `overrides/` 里的 mod 与配置解出来
- 原版 / Paper 服务端尝试导入 mod 会明确提示：只能装插件，要玩模组请建 Fabric/Forge 服务端
- UI 文案也写清了：**服务端 mod 必须和客户端完全一致（同版本、同加载器）**

---

## 18. 进服前自动检查环境 + 自动补齐模组

目标：好友点「进服」时，若没装服务端要的 mod，启动器自动发现并下载补全，补完再进，不用人工对包。

### 主机侧（开着模组服的人）
- 模组服（Fabric / Forge / NeoForge）启动时，自动在 **游戏端口 +1**（被占用就 +2/+3）起一个**极小的清单服务**：
  - `GET /manifest.json` → 服名、MC 版本、加载器、每个 mod 的 `文件名 + sha1 + 大小`
  - `GET /mods/<文件名>` → 直接下载 mod 本体（局域网内很快，不依赖 Modrinth）
- 只暴露这两类路径，其它一律 404
- 启动后 toast 会告诉你清单端口；UPnP 打洞时**同时映射 port 和 port+1**，好友外网也能拉清单

### 客户端（进服的人）
- 「服务器 → 一键进服」与「联机 → 房间码 / 局域网进入」全部改成先体检：
  1. 探测 `host:(端口+1/2/3)/manifest.json`
  2. **版本或加载器不一致** → 直接拦下并说明原因（Quilt 客户端进 Fabric 服视为兼容）
  3. **缺 mod** → 弹窗列出缺哪些、总共多大，点「下载并进入」从服务器自动补齐（走任务面板，可取消）
  4. **多出 mod** → 提示可能进不去，建议去内容管理停用
  5. **探测不到清单**（公共服务器 / 老版本服）→ 照常进服，不做任何拦截
- 补齐走 `serversync`：下载到实例 `mods/`，用 sha1 校验后 `--server` 直连启动

### 实测（scripts/batch8test.ts）
```
清单：朋友服 1.20.1/fabric mods=2 gamePort=25599
清单服务端口：25600 mods=2
客户端发现清单：http://127.0.0.1:25600 / 2 个 mod
对比结果：缺 1 个（lithium-0.12.jar），多 1 个（extra-client-only.jar）
补齐：成功 1 个，失败 0 个
补齐后再对比：缺 0 个
```

### 边界
- 光影 / 资源包是纯客户端内容，**不影响能否进服**，所以不进同步清单（否则每人被塞几百 MB）
- 走 bore 中继时只转发游戏端口，清单拉不到 → 会自动跳过检查（UI 里有提示：中继模式请先用整合包对齐）
- 服务端 mod 与客户端必须严格一致（同版本同加载器），这是 Minecraft 自身的限制，不是启动器能绕过的

---

## 19. 托盘常驻 + 「开房间」与「开服务端」分家

### 关闭窗口不再直接退出（托盘常驻）
- 新增托盘图标（`src/main/tray.ts`）：托盘菜单 = `服务端：n 个在跑` / 显示主界面 / 停止所有服务端 / 退出 WFMC
- 点 ✕ 的行为：
  - **有服务端在跑** → 拦截关闭，窗口隐藏到托盘，并弹一条「WFMC 还在后台运行 」提示（服务端不受影响）
  - 没服务端但设置里开着「缩到托盘」 → 同样隐藏
  - 设置里选「直接退出程序」 → 才真的退出
- `window-all-closed` 不再 `app.quit()`，只有托盘「退出」或系统强制结束才终止
- 设置 → 语言下面加了「关闭窗口时：缩到右下角托盘 / 直接退出」二选一

实测：正常启动 → 关窗口 → **进程仍在（4 个 electron 进程）、没有可见窗口**，服务端继续跑。

### 概念分家：开房间 ≠ 开服务端
之前「联机」和「一键开服」确实容易混，现在两页各自写清定位：

**「联机」页顶部新增对比卡**
| 本页：开房间（临时） | 「一键开服」页：开服务端（常驻） |
|---|---|
| 你先打开游戏，在「对局域网开放」里开房间 | 启动器跑一个独立服务端进程 |
| 本页只负责把房间**分享**出去 | 你关游戏它还在；关窗口缩托盘继续跑 |
| 你一退出游戏，房间就没了，人数受游戏内限制（~8 人） | 玩家随时能进、人数上限可调、能装插件或 mod |
| 适合临时玩一晚上、玩自己的存档 | 适合长期开服、朋友随时来、整合服 |

并写清**三种分享渠道的区别**：
- 局域网直连 = 同一路由器下，零配置但只能同网
- P2P 打洞（UPnP）= 自动开路由器端口，外网可连、不过第三方、延迟最低，需要路由器支持
- 公网中继（bore）= 路由器不让映射时用，能连但延迟看中继

**「一键开服」页顶部**加了提示条：「这里是开服务端（独立进程常驻）… 只想临时开房间去『联机』页」，并带一个直达按钮。

---

## 20. 交互收尾（下拉不再滚页 / 测速可清 / 加载骨架 / 微软登录免配置 / 英文标题）

### 展开下拉框不再把页面「蹦」到位
- 根因：`scrollIntoView()` 会连带滚动所有可滚祖先（`.main` 整页），所以你在下面滚动后点开下拉，页面会跳回弹层位置
- 修法：改为**只算 `.sel-list` 自己的 `scrollTop`**（打开时居中到选中项、键盘上下移动时贴边滚动），完全不碰页面滚动位置

### 测速结果可以清除
- 「测一下哪个源快」旁边新增 **清除测速结果**（也顺手保留了「用最快的」按钮）

### 开服页版本下拉有骨架/加载态
- 游戏版本、加载器版本下拉在拉取中显示 `正在拉版本列表…` 而不是空白，和模组页的骨架风格统一

### 微软正版登录免配置
- 内置公共客户端 ID（`DEFAULT_MS_CLIENT_ID`）：设置里留空即用，点「微软正版登录」直接走设备码授权，不用先去 Azure 注册
- 原来的 client id 输入框收进「高级：用自己的 Azure 应用 ID」，并写了四步获取方法（Azure → 应用注册 → 公共客户端流 → 复制 ID）

### 英文覆盖扩大
- 新增 `useT()`（`store.tsx`）：`const t = useT(); t('首页','Home')`
- 已切英文的范围：**侧边导航全部 10 项 + 每个页面的 H1 标题**（Home / Instances / Download / Mods & Shaders / Servers / Multiplayer / Host Server / Skin & Auth / Content / Settings）
- 正文段落仍是中文，按页继续补；设置里已如实标注覆盖范围

---

## 21. 全量英文 / 版本缓存 / 登录态续期

### 英文不再只翻菜单
- 新增 `src/renderer/i18n-zh.ts`：约 460 条中→英对照表（按页面分区，允许同义重复）
- 新增 `src/renderer/autoI18n.ts`：运行时把页面上的中文**文本节点与 placeholder/title** 换成英文
  - 整段精确命中优先；未命中但含长词（≥4 字）时做词级替换，能处理「已看 24 / 共 77679 个」这类拼接串
  - `MutationObserver` 跟随 React 重渲染，新出现的节点也会被翻译
  - 切回中文时按 `WeakMap` 里记的原文完整还原
- 代码里新写的地方继续用 `useT()`（类型安全），运行时翻译兜住存量文案
- 实测：Hosting / Settings 两页切到 English 后，标题、按钮、标签、说明、占位符基本全英文，只剩极少数带变量的动态串

### 版本列表缓存（进页面零等待）
- 主进程：`versionCache` 包住 Paper 版本列表与各加载器版本列表，10 分钟内直接复用
- 渲染层：`vCache` 再包一层，来回切页面不重复发 IPC
- 加载中显示「正在拉版本列表…」而不是空框

### 微软登录态自动续期
- `accounts.ts` 新增 `accountHealth()` / `refreshExpiringAccounts()`：提前 10 分钟判断是否需要续期
- 侧边栏账号下方出现提醒条：「微软登录即将过期，点这里续期」/「登录已过期，点这里重新登录」，点一下即刷新
- App 每 5 分钟巡检一次，无需重启；刷新成功/失败都有 toast

---

## 22. 双版本打包 + 更新中心 + 发布脚本

### 两个包，各自合适的使用方式
| 产物 | 说明 | 数据位置 |
|---|---|---|
| `WFMC-Portable-1.0.0.exe`（92.1 MB） | 便携版，双击即用 | exe 旁边 `WFMC-Data\`（放桌面就多一个文件夹，这是便携版的代价） |
| `WFMC-Setup-1.0.0.exe`（101.9 MB） | 安装版，**可自选安装位置**，带桌面 / 开始菜单快捷方式与卸载程序 | `%APPDATA%\WFMC`（不会在安装目录堆数据） |

- NSIS 配置：`oneClick: false` + `allowToChangeInstallationDirectory: true` + `perMachine: false`（默认按用户装到 `%LOCALAPPDATA%\Programs\WFMC`，不需要管理员）
- 卸载时会保留数据目录（`deleteAppDataOnUninstall: false`），避免误删存档
- 新脚本：`npm run dist:portable` / `npm run dist:setup` / `npm run dist`（两个一起）
- 实测：静默 `/S` 安装 → 目录生成 → 启动正常 → 数据落在 `%APPDATA%\WFMC`、无错误日志

### 更新中心（GitHub Releases）
- 主进程 `checkReleases()`：支持 `用户名/仓库名`、releases 页面地址、API 地址三种写法；解析出**全部历史版本**、说明、附件
- 国内网络兜底：直连 `api.github.com` 失败自动改走 `gh-proxy.com` / `ghfast.top`
- 按运行方式挑附件：便携版下 `Portable`，安装版下 `Setup`
- 界面（`views/UpdateCenter.tsx`）：
  - 渐变 hero：`新版本可用` 徽章 + `v1.0.0 → v1.2.0`（旧版本划线）+ 日期 / 附件数 + 主按钮
  - 更新说明按 markdown 简易渲染（标题 / 列表 / 代码块）
  - **历史版本时间线**：可展开每个版本的说明与安装包下载
  - 更新源输入框 + 「开机自动检查更新」开关
- 启动时检查：每 6 小时最多一次，发现新版本 → 侧边栏横幅「发现新版本 vX · 去更新」+ toast

### 发布脚本
`scripts/publish-github.mjs`：校验 token → 建仓库（缺则建）→ 建/更新 release（读取 `CHANGELOG.md` 作为说明）→ 用 curl 上传 `release/` 下所有 exe → 打印该填的更新源。
用法：`$env:GH_TOKEN="ghp_xxx"; node scripts/publish-github.mjs --repo wfmc --tag v1.0.0`

---

## 23. 皮肤 3D 预览修复

**现象**：外置登录后「当前角色」里那块是空白，只有一个渐变框。

**根因**：`skinview3d` 的 viewer 是异步创建的，而套贴图的 effect 先跑完了 → `viewerRef.current` 还是 null，`loadSkin` 直接被跳过；viewer 建好后没有任何地方再触发加载，于是永远是空模型。

**修法**（`views/Skin.tsx`）：
1. 贴图由**主进程**抓取（`skin:fetch-texture` → `data:image/png;base64,…`），绕开 `file://` 起页面时的跨域限制
2. 把「建 viewer」和「套贴图」合并进同一个 effect：先确保 viewer 存在，再 `await viewer.loadSkin(...)`，贴图变了会重跑
3. 加状态提示：`正在加载皮肤…` / `皮肤贴图读不到：xxx` / `这个角色还没设置皮肤`
4. 3D 真的失败时自动退回 2D 小人（`SkinPreview`），并标注「已退回 2D 预览」
5. 顺带修侧边栏账号类型：外置登录不再显示成「离线」，改成「· 外置」

**验证**：`WebGL 2.0` 可用、`skinview3d` chunk 已打包；用一张本地生成的 64×64 测试皮肤走完整链路（IPC 抓图 → dataURL → loadSkin），预览正常出模型（截图确认）。调试入口：`localStorage.demoSkin = '<图片地址>'` 或 `?demoSkin=<图片地址>` 可在未登录时直接试渲染。

---

## 24. 已发布到 GitHub（更新源已内置）

- 仓库：**https://github.com/steveliuyan/wfmc**（公开）
- 发布页：**https://github.com/steveliuyan/wfmc/releases**
- 已发版本：`v1.0.0`（首版）/ `v1.0.1`（内置更新源 + 皮肤修复）/ `v1.0.2`（更新说明排版：表格、粗体、行内代码）
- 每个版本带两个附件：`WFMC-Portable-x.y.z.exe`（92 MB）、`WFMC-Setup-x.y.z.exe`（102 MB）
- **软件默认更新源已写死为 `steveliuyan/wfmc`**（`store.ts` 的 `updateUrl` 默认值），装完即自带检查更新

### 发布流程（以后发版就两步）
1. 改 `package.json` 的 `version` → `npm run dist`
2. `$env:GH_TOKEN="ghp_xxx"; node scripts/publish-github.mjs --repo wfmc --tag v1.0.3`
   （或直接双击根目录的 `发布到GitHub.bat`）

脚本会：校验 token → 建仓库（缺则建）→ 空仓库自动提交 README 建立 main 分支 → 建 release（正文取 `CHANGELOG.md`）→ 只上传**当前版本号**的 exe → 打印更新源。

### 网络现实与对策
| 域名 | 本机可达性 | 影响 |
|---|---|---|
| `api.github.com` | ✅ 200 | 检查更新、发布都走它 |
| `github.com` | ❌ 连接超时 | Releases 下载直链打不开 |
| `raw.githubusercontent.com` | ❌ DNS 失败 | 不能用 raw 托管 update.json |
| `uploads.github.com` | ✅ 302 | 上传附件正常 |
| `gh-proxy.com` / `ghfast.top` | ✅ 200 | 下载兜底 |

因此：**更新包下载已加镜像兜底**（直连 → gh-proxy → ghfast），`applyUpdate` 里按顺序试，失败自动换下一个。
---

## 25. 打包产物说明

`npm run dist` 之后 `release/` 里只会有两个文件：

| 文件 | 说明 |
|---|---|
| `WFMC-Portable-<版本>.exe` | 便携版 |
| `WFMC-Setup-<版本>.exe` | 安装版（NSIS，可选安装位置） |

以前还会多出一堆 `*.blockmap`（每个约 110 KB）——那是 electron-builder 给 **electron-updater 做增量（差分）更新** 用的块索引文件。本项目的更新是「整包下载 + 替换 exe」，不需要差分，所以这些文件纯属多余。

已处理：
- `nsis.differentialPackage: false` —— 不再生成 blockmap
- 顺带使安装包小了约 9 MB（92.4 MB，原来 101.9 MB）
- `.gitignore` 里 `release/` 整个忽略，仓库不会混进构建产物