# WFMC 交接文档（Handoff）

> 读者：后续接手这个项目的自己 / 服务器上的 AI 助手。
> 目标：让接手方在**不改架构**的前提下，能加功能（公告通知、账号备份、云同步等）、能排障、能发版。
> 版本：WFMC 1.0.27（`release\WFMC-Portable-1.0.27.exe` / `release\WFMC-Setup-1.0.27.exe`）
> 文档更新：随代码一起改，别只改代码不改这里。

---

## 0. 一页速览

| 项 | 内容 |
|---|---|
| 产品 | WFMC · WanFan Minecraft Launcher（万凡科技） |
| 形态 | Electron 桌面应用；Windows 便携单文件 exe（92.2MB，双击即用）+ NSIS 安装版（92.4MB，可选安装位置） |
| 技术栈 | Electron 38 · React 19 · TypeScript 5.9 · Vite 7 · esbuild · electron-builder 26 |
| MC 内核 | `@xmcl/core` `@xmcl/installer` `@xmcl/user` `@xmcl/modrinth` `@xmcl/curseforge`（全 MIT） |
| 数据目录 | 便携版：`<exe 同级>\WFMC-Data`；安装版：`%APPDATA%\WFMC`（`settings.json` 在同级，实例在 `data\instances`） |
| 通信 | 全部走 `ipcMain.handle('<域>:<动作>')` ↔ `window.launcher.invoke('<域>:<动作>', ...)` |
| 入口 | 主进程 `src/main/index.ts` → `src/main/ipc.ts`；渲染 `src/renderer/App.tsx` |
| 规模 | 主进程 34 个模块、渲染 12 个页面 / 3 个组件、约 11k 行 |

**接手先看三个文件**：`src/main/ipc.ts`（所有能力清单）、`src/shared/types.ts`（数据结构）、`src/renderer/api.ts`（前端怎么调）。

---

## 1. 跑起来 / 打包

```powershell
cd H:\mcqidongqi
npm install                 # 首次（若 electron 下载失败见 §13.1）
npm run dev                 # 开发热更新（Vite + Electron）
npm run build               # 编译主进程(esbuild→dist/main) + 渲染层(vite→dist/renderer)
npm start                   # 跑编译产物
npm run typecheck           # tsc --noEmit（提交前必跑）
npm run dist                # 打便携包 → release\WFMC-1.0.0.exe
```

打包需要两个镜像环境变量（国内网络）：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npx electron-builder --win portable --x64
```

CI：`.github/workflows/build.yml`（typecheck → smoke → build → 打包 → 上传产物；打 `v*` tag 自动发 Release）。

---

## 2. 目录与职责

### 2.1 主进程 `src/main/`

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `index.ts` | 创建窗口、单实例锁、窗口位置、全局错误钩子、`WFMC_SHOT*` 自检钩子 | 低 |
| `ipc.ts` | **所有 IPC 注册**（125 个通道），长任务用 `runTask` 包一层 | 中（改动要同步 `api.ts`） |
| `store.ts` | settings/accounts 读写、令牌 DPAPI 加密、便携目录判定、旧目录迁移 | **高**（数据格式变了要兼容旧文件） |
| `net.ts` | fetch 封装、分片(Range)下载、断点、`AbortError`、`sources()` 双源 | 中 |
| `game.ts` | 自研原版安装（client.jar + libraries + assets），镜像 URL 重写 | **高**（MC 文件结构） |
| `minecraft.ts` | 版本清单、本地版本、加载器列表与安装（Fabric/Quilt/Forge/NeoForge） | 中 |
| `instances.ts` | 实例增删改查、详情、磁盘用量 | 中 |
| `paths.ts` | **版本隔离**：`gamePathFor()` = 游戏数据目录（受 `instance.isolate` 影响） | **高**（所有内容操作都过它） |
| `launch.ts` | 拼启动参数、natives、`yggdrasilAgent` 注入、运行状态机 | **高** |
| `natives.ts` | 解压 natives（自带 zip 读取） | 中 |
| `java.ts` | 扫本机 Java、按版本挑主版本、下载 Mojang 运行时 | 中 |
| `accounts.ts` | 离线账号、微软设备码登录、令牌刷新 | 中 |
| `authlib.ts` | 外置登录（authlib-injector）：登录/角色/皮肤/披风/卡片解析/injector 下载 | 中 |
| `modrinth.ts` | Modrinth 搜索、版本、安装（含前置） | 中 |
| `curseforge.ts` | CurseForge 搜索/安装（需 API Key） | 中 |
| `modpack.ts` | `.mrpack` / CF zip 安装、**整合包更新检测** | 中 |
| `modpackexport.ts` | 实例导出成标准 `.mrpack`（SHA1 反查 Modrinth） | 低 |
| `modupdates.ts` | Mod 更新检查（SHA1 → Modrinth 反查）+ 升级 | 低 |
| `moddoctor.ts` | Mod 体检（重复 modId / 加载器不符 / 缺前置 / 残留） | 低 |
| `content.ts` | 内容管理（mods/资源包/光影/存档/数据包）、排序、备份、**诊断包导出**、实例导入导出 | 中 |
| `crash.ts` | 崩溃诊断 12 条规则 | 低 |
| `servers.ts` | 收藏服务器、SLP 查询、SRV、**MOTD/图标缓存** | 低 |
| `netshare.ts` | 局域网广播发现、STUN、UPnP 端口映射、bore 公网穿透 | 中 |
| `rooms.ts` | 联机房间码（IPv4 压 6 字节 + Base32） | 低 |
| `serverhost.ts` | **一键开服**：Vanilla/Paper/Fabric/Forge/NeoForge 下载与启动、控制台、properties、白名单/OP、备份、TPS/玩家解析 | **高** |
| `tasks.ts` | 后台任务队列（注册/进度/取消/清空） | 低 |
| `shots.ts` | 截图管理 + 性能预设（写 `options.txt`） | 低 |
| `speedtest.ts` | 下载源测速、临时文件清理 | 低 |
| `music.ts` | 本地歌单（`data/music`） | 低 |
| `updater.ts` | 自动更新（`update.json` → 下载 → 替换重启）、便携数据目录 | 中 |
| `errlog.ts` | 本地错误日志 + 全局异常钩子 | 低 |
| `proxy.ts` | 全局代理（`session.setProxy`） | 低 |
| `zip.ts` | **自研 zip 读写**（Node 24 上 yauzl 会死锁，见 §13.2） | 中 |
| `proc.ts` | 子进程小工具 | 低 |

### 2.2 渲染层 `src/renderer/`

| 文件 | 职责 |
|---|---|
| `App.tsx` | 外壳：侧边栏导航、`PageId` 路由、首启引导、Ctrl+K 搜索、拖拽（文件/链接）、`Onboarding` |
| `store.tsx` | `LauncherProvider`：settings/instances/accounts/progress/logs/launchState/toasts/**askConfirm 确认框**/主题变量注入 |
| `api.ts` | **类型化的 IPC 封装**（加通道必须在这里加方法） |
| `i18n.ts` | 中/英词典（目前覆盖导航与常用按钮） |
| `views/*` | Home（数据面板+日志）、Instances、Download、Resources、Servers、Online（联机）、Hosting（开服）、Skin（外置登录/皮肤）、Manage（内容/体检/更新/崩溃/日志/截图/数据包）、Settings、TaskPanel、MusicPlayer |
| `components/*` | `Select`（自绘下拉，带搜索/键盘/骨架）、`Skeleton`（骨架屏）、`SourcePicker`（下载源） |

### 2.3 共享 `src/shared/`

- `types.ts`：`Settings` / `Instance` / `Account` / `SavedServer` / `ContentItem` / `ProgressPayload` 等，**主进程与渲染层共用，改这里两边一起改**。
- `credits.ts`：致谢名单（设置页渲染）。

---

## 3. 数据目录与文件格式

```
WFMC-Data/                      # 便携版；安装版则是 %APPDATA%\WFMC\data
├─ settings.json                # 全局设置（见 §3.1）
├─ accounts.json                # 账号（token 已 DPAPI 加密，形如 enc:xxxx）
├─ servers.json                 # 收藏服务器（含 lastStatus / icon 缓存）
├─ instances/<实例名>/
│   ├─ instance.json            # 实例元数据（见 §3.2）
│   └─ minecraft/               # 就是一份 .minecraft（版本隔离时版本数据在 versions/<ver>/game）
├─ servers/<id>/                # 一键开服的服务端
│   ├─ hosted-server.json       # 服务端元数据（kind/mcVersion/port/memory/eula/launchArgs）
│   ├─ server.properties / eula.txt / ops.json / whitelist.json
│   └─ world*/...
├─ music/                       # 播放器歌单
├─ java/                        # 自动下载的 Mojang 运行时
├─ tools/                       # authlib-injector.jar / bore.exe
├─ backups/  exports/  temp/    # 世界备份、实例导出、临时文件
├─ logs/errors.log              # 启动器自身错误（诊断包含它）
└─ tasks/… （无，任务在内存里）
```

### 3.1 `settings.json`（= `Settings` 类型）

关键字段：`dataDir`、`theme('light'|'dark'|'system')`、`downloadSource('mirror'|'official')`、
`maxMemory/minMemory`、`javaPath`、`extraJvmArgs`、`microsoftClientId`、`curseforgeApiKey`、`proxy`、
`onboarded`、`activeAccountId`、`updateUrl`、`language`、`themeCustom{accent,radius,wallpaper}`、`yggdrasilApi`、`windowState`。

> 设置文件固定写在启动器根目录（便携版 = `WFMC-Data\settings.json`，安装版 = `%APPDATA%\WFMC\settings.json`），
> **不跟 `dataDir` 走**；`accounts.json` 和实例目录才跟 `dataDir` 走。换数据目录时账号会跟着走。

### 3.2 `instance.json`（= `Instance` 类型）

```json
{
  "id": "uuid",
  "name": "1.20.1 fabric",
  "mcVersion": "1.20.1",
  "loader": "fabric",
  "loaderVersion": "0.16.x",
  "versionId": "fabric-loader-0.16.x-1.20.1",
  "isolate": true,
  "maxMemory": 4096,
  "minMemory": 1024,
  "javaPath": "",
  "extraJvmArgs": ["-XX:+UseG1GC"],
  "resolution": { "width": 1280, "height": 720, "fullscreen": false },
  "perfPreset": "balanced",
  "installed": true,
  "playTimeMs": 123456,
  "packSource": { "kind": "modrinth", "projectId": "abc", "versionId": "xyz", "versionNumber": "1.2.3" },
  "server": { "ip": "play.example.com", "port": 25565 }
}
```

---

## 4. IPC 通道全表（按域）

> 前端调用：`api.<方法>()` → `window.launcher.invoke('<channel>', ...args)`。
> 新增通道 = `ipc.ts` 注册 + `api.ts` 加方法（两边类型要对齐）。

| 域 | 通道 |
|---|---|
| app | `app:info` `app:version` `app:report-error` `app:read-errors` `app:clean-temp` |
| settings | `settings:get` `settings:set` |
| dialog / shell | `dialog:pick-file` `dialog:pick-files` `dialog:pick-folder` `dialog:save-text` `shell:open-external` `shell:open-path` `fs:list-dir` |
| version | `version:remote` `version:local` `version:loaders` `version:delete` |
| instance | `instance:list` `instance:create` `instance:update` `instance:delete` `instance:duplicate` `instance:detail` `instance:content` `instance:export` `instance:import-zip` `instance:pick-import` `instance:open-folder` |
| game | `game:install` `game:launch` `game:kill` `game:running` `game:repair` |
| java | `java:scan` `java:install` `java:required-major` |
| account | `account:list` `account:add-offline` `account:remove` `account:set-active` `account:ms-start` `account:ms-complete` `account:login-yggdrasil` `account:profiles` `account:select-profile` |
| 外置登录 | `injector:ensure` `injector:parse-card` `injector:from-clipboard` `skin:lookup` `skin:upload` `skin:upload-cape` `skin:clear` |
| 资源 | `resource:search` `resource:versions` `resource:install` |
| 整合包 | `modpack:install-file` `modpack:install-url` `modpack:export-mrpack` `modpack:inspect` `modpack:check-update` |
| Mod | `mods:updates` `mods:apply` `mods:diagnose` |
| CurseForge | `cf:search` `cf:install` |
| 内容/存档 | `content:list` `content:toggle` `content:delete` `content:import` `content:open` `content:worlds` `content:datapacks` `content:datapack-import` `content:datapack-toggle` `content:datapack-delete` `content:pack-order` `content:pack-move` `content:pack-toggle` `content:export-diagnostics` `saves:backup` |
| 崩溃 | `crash:list` `crash:read` `crash:diagnose` |
| 服务器 | `server:list` `server:add` `server:remove` `server:update` `server:ping` `server:join` |
| 开服 | `hosted:list` `hosted:create` `hosted:start` `hosted:stop` `hosted:command` `hosted:logs` `hosted:status` `hosted:props` `hosted:set-props` `hosted:eula` `hosted:delete` `hosted:open-dir` `hosted:paper-versions` `hosted:loader-versions` `hosted:access-list` `hosted:access-add` `hosted:access-remove` `hosted:backup` `hosted:stats` |
| 联机 | `lan:start` `lan:list` `lan:stop` `net:lan-ip` `net:public` `net:upnp` `net:unupnp` `tunnel:start` `tunnel:state` `tunnel:stop` `room:encode` `room:decode` |
| 任务 | `tasks:list` `tasks:cancel` `tasks:clear` |
| 更新 | `update:check` `update:apply` |
| 其它 | `preset:list` `preset:apply` `shots:list` `shots:delete` `shots:open-dir` `music:list` `music:import` `music:remove` `music:open-dir` `net:speedtest` `drop:handle` |

**事件（主进程 → 渲染层）**：`event:progress`（下载进度）、`event:launch-log`、`event:launch-state`、`event:host-log`、`event:host-exit`、`event:task`。
前端订阅：`api.onProgress / onLog / onLaunchState / onHostLog / onHostExit / onTask`。

---

## 5. 关键时序

### 5.1 启动
`app.whenReady` → `store.load()`（读 settings、解密 accounts、建目录、便携/迁移判定）→ `registerIpc()` → `applyProxy()` → `createWindow()`（恢复窗口位置 → 加载 renderer）→ 渲染层 `store.tsx` `useEffect` 拉 `app:info` + `settings:get` + 实例 + 账号 → 首启无 `onboarded` 则显示引导。

### 5.2 安装游戏
`game:install`（`runTask` 包裹）→ `installInstanceGame()` → `installVanilla()`（清单 → 写 version json → `Version.parse`）→ `installResolvedGame()`（client.jar / libraries / assets，走 `net.downloadFile` 分片）→ 有加载器再 `installLoader()`（Forge/NeoForge 跑官方 installer `--installClient`）→ 写回 `installed:true`。

### 5.3 启动游戏
`game:launch` → 取 `store.activeAccount`（微软刷新 / 外置刷新）→ `launch.ts`：
`ensureGamePath()`（版本隔离）→ `Version.parse` → 挑 Java（`java.ensureJava`）→ `ensureNatives` → `launch({... yggdrasilAgent, prechecks:[checkVersion,checkLibraries,linkAssets]})` → 状态 `preparing` → 窗口就绪（或 25s 兜底）→ `running` → 退出时累计 `playTimeMs`、有崩溃则写日志。

### 5.4 一键开服
`hosted:create`（`runTask`）→ 按 `kind` 下载（Paper=v3 API / Vanilla=bmclapi→official / Fabric=installer `server` 子命令 / Forge·NeoForge=installer `--installServer` 后取 `win_args.txt`）→ `hosted:start` 起 `java -Xms -Xmx ... nogui` → 日志经 `event:host-log` 推给前端 → `hosted:command` 写 stdin → `hosted:stop` 发 `stop`（15s 后强杀）。

### 5.5 联机
① 局域网：`lan:start` 绑 UDP 4445 收 `[MOTD]/[AD]` 广播 → 列表点「进入」→ `server:join`（`--server` 直连）。
② P2P：`net:upnp`（SSDP 找 IGD → SOAP AddPortMapping）→ 给公网 IP:端口。
③ 穿透：`tunnel:start`（自动下 bore → `bore local <port> --to bore.pub` → 解析 `listening at host:port`）。
④ 房间码：`room:encode(host,port)` 生成短码；好友 `room:decode` → 直连。

### 5.6 外置登录
拖 `authlib-injector:yggdrasil-server:<url>` 进窗口（任意页）→ `injector:parse-card` → 存 `settings.yggdrasilApi` → 跳「皮肤 · 外置登录」→ `account:login-yggdrasil` → 启动时 `injector:ensure` 下 jar 并作为 `-javaagent` 注入。

### 5.7 自动更新
`update:check` 读 `settings.updateUrl` 的 `{version,url,notes}` → 比版本 → `update:apply` 下到临时目录 → 写 `.cmd` 等进程退出后替换 exe 并重启（便携版用 `PORTABLE_EXECUTABLE_FILE` 找真实 exe）。

---

## 6. 二次开发：加一个功能

### 6.1 加一个新页面
1. `src/renderer/views/Foo.tsx` 写组件；
2. `src/renderer/App.tsx`：`PageId` 加 `'foo'`、`nav` 数组加 `{ id:'foo', label:'Foo', icon:'…' }`、`Icons` 加图标、渲染处加 `{page === 'foo' && <Foo />}`；
3. 需要数据就按 §6.2 加通道。

### 6.2 加一个 IPC 通道（标准样板）

主进程 `src/main/foo.ts`：

```ts
import { store } from './store'
import type { ProgressFn } from '../shared/types'

export interface FooResult { ok: boolean; detail?: string }

export async function doFoo(input: string, onProgress?: ProgressFn): Promise<FooResult> {
  onProgress?.({ key: 'foo', phase: '开始', current: 0, total: 1 })
  // …真正逻辑…
  return { ok: true, detail: input }
}
```

`src/main/ipc.ts`：

```ts
import { doFoo } from './foo'

// 长任务用 runTask 包（右下角任务面板可见、可取消）
ipcMain.handle('foo:run', async (_e, input: string) =>
  await runTask('misc', `Foo ${input}`, async (ctx) =>
    doFoo(input, (p) => {
      progress(p)                                     // 老的下发进度方式（进度条）
      ctx.report({ phase: p.phase, current: p.current, total: p.total }) // 任务面板
    })
  )
)
```

`src/renderer/api.ts`：

```ts
fooRun: (input: string) => call<{ ok: boolean; detail?: string }>('foo:run', input),
```

页面里：`const res = await api.fooRun('abc')`。

### 6.3 加一个设置项
`src/shared/types.ts` 的 `Settings` 加字段（**给默认值**，在 `store.ts` 的 `defaultSettings()` 里）→ 设置页 `saveSettings({ 新字段 })` → 用的时候 `store.settings.新字段`。
> 老用户的 `settings.json` 里没有这个字段时，读出来是 `undefined`，所以取值必须带兜底（`?? 默认值`）。

### 6.4 加一种内容类型 / 目录
`content.ts` 里 `instanceRoot()` 已经统一走 `gamePathFor()`（版本隔离），新目录照这个模式加即可；前端 `Manage.tsx` 的 `tabs` 加一项。

---

## 7. 服务端集成（重点：公告通知 / 账号备份 / 云同步）

> 场景：在**你自己的服务器**上放一个后端，客户端去拉公告、上传/下载备份、做账号云同步。
> 下面给的是**建议契约**（客户端侧要动的地方我标了行号定位方式），服务端实现随意，但建议照抄字段名。

### 7.1 通用约定

- 传输：HTTPS（不要明文 HTTP，除非局域网测试）。
- 认证：`Authorization: Bearer <deviceToken>`；`deviceToken` 由服务端下发，客户端**存加密后的 accounts 同级文件或 settings**（别写明文到日志）。
- 时间：全部用毫秒时间戳（UTC）。
- 版本：请求头带 `X-WFMC-Version: 1.0.0`，服务端可据此做灰度/最低版本限制。
- 失败降级：**任何服务端调用失败都不能阻塞启动**，全部 `try/catch` + toast 提示 + 本地有缓存就用缓存。

### 7.2 公告 / 通知

```
GET /api/v1/announcements?channel=stable&lang=zh
200: {
  "items": [
    { "id": "a1", "level": "info|warn|critical",
      "title": "维护通知", "body": "今晚 23:00 重启",
      "url": "https://…", "pinned": true,
      "publishedAt": 1730000000000, "expiresAt": 1730086400000,
      "minVersion": "1.0.0", "maxVersion": null }
  ]
}
```

客户端接入点（三处，任选其一或组合）：

1. **启动时拉一次**：`src/renderer/store.tsx` 的初始化 `useEffect`（拉 `app:info` 那段）里加一次 `api.fetchAnnouncements()`（需要先在 `ipc.ts` 加通道，主进程用 `net.fetchJson` 带 5s 超时）。
2. **展示**：首页 `views/Home.tsx` 顶部插一个公告条；`critical` 用红色 + 不可关闭；点击 `shell:open-external` 打开 `url`。
3. **已读**：把已读 id 存 `settings` 里（例如 `settings.readAnnouncements: string[]`），避免每次弹同样的。

> 本地兜底：`settings.updateUrl` 同一个静态站点上放个 `announcements.json` 也行，连不上 API 时读它。

### 7.3 账号备份（手动 + 定时）

现状：实例备份已存在 → `instance:export`（整个实例 zip）与 `content:export-diagnostics`（诊断包），`hosted:backup`（世界 zip）。

要接云备份，建议两种粒度：

- **配置级（小、频繁）**：`settings.json` + `accounts.json`（脱敏，见下）+ `servers.json` + 实例的 `instance.json` → 打成一个 `wfmc-config-<ts>.zip`。
- **实例级（大、低频）**：直接复用 `instance:export` 的 zip（可能几百 MB，建议分片上传）。

```
POST /api/v1/backups           # multipart/form-data: file, meta(JSON)
meta: { "kind":"config|instance", "instanceName":"…", "version":"1.0.0", "sha256":"…", "createdAt":… }
201: { "id":"b1", "size":12345678 }

GET  /api/v1/backups?kind=config&limit=20
200: { "items":[ { "id":"b1","size":…,"sha256":"…","createdAt":…,"kind":"config" } ] }

GET  /api/v1/backups/b1        # 下载（支持 Range 更好，客户端下载器已支持分片）
DELETE /api/v1/backups/b1
```

客户端侧：
- 上传：复用 `net.downloadFile` 的反向逻辑——用 `fetch(url,{method:'POST',body:FormData})`，进度用 `onProgress`；主进程加通道 `backup:upload`。
- 上传前**必须脱敏**：不要传 `accounts.json` 里的 `enc:` 令牌（DPAPI 加密的密文换机器就解不开，传了也没用，还可能泄露设备信息）。只传 `{ id, type, name, uuid }`。
- 恢复：下载 → 校验 sha256 → 解压到临时目录 → 提示用户「将覆盖当前实例，是否继续」→ 用 `instance:import-zip` 同款逻辑铺开。
- 定时：目前没有调度器，最小实现是在 `index.ts` `app.whenReady` 里用 `setInterval`（例如每 6h）并在 `settings` 里记 `lastBackupAt`；用户可关。

### 7.4 安全与合规清单

- [ ] 服务端用 HTTPS，证书有效；客户端**开启证书校验**（默认即可，别 `rejectUnauthorized:false`）。
- [ ] `deviceToken` / 备份地址不要硬编码在渲染层；放主进程或 `settings`。
- [ ] 令牌落盘已用 Windows DPAPI（`store.ts` 的 `encryptToken`），照抄这个模式。
- [ ] 上传前脱敏：账号 token、`microsoftClientId`、`curseforgeApiKey`、代理地址都要清掉。
- [ ] 服务端限流 + 单用户配额（backups 保留最近 N 份，旧的滚动删）。
- [ ] 日志里不打印 accessToken / 密码；`errlog.ts` 只记 message+stack。
- [ ] 用户可一键关闭云功能（`settings` 里加开关，默认关）。
- [ ] 遵守 Mojang EULA：**不得**做「启动器代登录/代挂/绕过正版验证」的云功能；外置登录仅用于玩家自建的 Yggdrasil 皮肤站。

---

## 8. 备份与恢复设计建议

| 需求 | 现成能力 | 建议做法 |
|---|---|---|
| 实例整体备份 | `instance:export` → zip | 保留最近 3 份，上传用分片 |
| 世界备份 | `hosted:backup`（服务端世界） | 开服前/停服后自动跑一次，`setInterval` 定时 |
| 配置备份 | 无（要新写） | 见 §7.3 配置级备份 |
| 崩溃排查 | `content:export-diagnostics`（日志+崩溃+mod 清单+实例概要+launcher-errors.log） | 让用户把这个包发给你，比截图强 |
| 迁移到新机器 | 实例 zip + `settings.json` | 注意：账号 token 因 DPAPI **不可跨机**，需重新登录 |

---

## 9. 调试与自检工具

| 工具 | 用途 |
|---|---|
| `npm run smoke` | 内核冒烟：拉版本清单 → 解析 → 生成启动参数 |
| `scripts/itest.ts` | 端到端：真装 1.20.1 + 真启动（耗时，走镜像） |
| `scripts/batch2test.ts` … `batch7test.ts` | 各批功能实测脚本（歌单/数据包/令牌加密/开服/穿透…） |
| `scripts/featuretest.ts` | 版本隔离 / STUN / 局域网 / 开服 / 穿透 一起跑 |
| `WFMC_SHOT=<png>` | 启动后自截一张窗口图再退出（**不受其它窗口遮挡**） |
| `WFMC_SHOT_PAGE=download` | 指定首屏页面（`?page=` 同一套） |
| `WFMC_SHOT_JS="document.querySelectorAll('.sel-btn')[2].click()"` | 截图前先跑 JS（截下拉展开态等） |
| `WFMC_SHOT_DOM=<json>` | 导出关键节点几何（排查布局重叠） |
| `WFMC_SHOT_MUSIC=1` | 强制打开音乐面板 |
| `settings.json` 里 `onboarded:false` | 重看首启引导 |

> 注意：Electron 有**单实例锁**。截图自动化前先 `Get-Process WFMC,electron | Stop-Process`，否则新实例直接 `app.quit()`，截图静默失败（这个坑我踩过）。

---

## 10. 已知限制 / TODO

**限制**
- 进度是「文件个数」粒度，不是字节级百分比（`downloadAll` 层面可改）。
- i18n 只覆盖导航与常用按钮，页面正文仍中文。
- 开服暂不支持插件/模组管理（Paper 插件目录可手动放）、不支持 RCON。
- P2P 依赖路由器开 UPnP；运营商大内网只能走 bore 中继（延迟看中继）。
- 自动更新只认自托管 `update.json`（没做差分/增量）。
- 皮肤仅支持外置登录（LittleSkin 等）；微软正版皮肤显示走 Mojang，未做上传。
- CurseForge 需用户自备 API Key；微软登录需自备 Azure 客户端 ID。
- 无代码签名 → 首次运行会有 SmartScreen 提示。

**建议下一步**
1. 服务端：公告 / 备份 / 云同步（§7），加开关、默认关。
2. 任务队列加「暂停/继续」（`AbortSignal` 已铺好，只剩 UI 与断点文件复用）。
3. 开服插件市场（Hangar/SpigotMC API）+ RCON。
4. i18n 全量、字体与高 DPI 适配。
5. 单元测试进 CI（目前只有 smoke + 手写 batch 脚本）。
6. 代码签名（EV 证书）与自动更新差分下载。

---

## 11. 代码风格与约定

- TypeScript strict，提交前 `npm run typecheck` 必须绿。
- 主进程不放 UI 逻辑；渲染层不直接 `fs`/`fetch`（全部走 IPC，方便以后加云端）。
- 所有耗时操作包 `runTask`（可取消 + 任务面板可见）。
- 文件读写统一 UTF-8，**不要用 PowerShell 的 `Get-Content|Set-Content` 改含中文的源码**（会乱码，见 §13.4）。
- 中文注释写「为什么」，不写「是什么」。
- 新功能必须给 README「实测记录」补一条，写清命令与看到的结果。

---

## 12. 免责声明（软件内也有）

见 `DISCLAIMER.md`，并在设置页「关于 → 免责声明」与首启弹窗中展示。
要点：非官方、与 Mojang/Microsoft 无关、账号与数据自担、联机开服自担、按「现状」提供、素材归属万凡科技与各原作者。

---

## 13. 踩坑清单（都是真踩过的）

1. **electron 二进制下不下来**：`npm i` 卡在 postinstall → 设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`；仍失败就手工下 `electron-v38.8.6-win32-x64.zip` 解到 `node_modules/electron/dist` 并写 `path.txt`。
2. **yauzl / @xmcl/unzip 在 Node 24 读多条目 zip 会死锁** → 自研 `zip.ts`（EOCD + `inflateRaw` + CRC32 store 写入）；`launch.ts` 用自定义 `prechecks` 跳过 `checkNatives`。
3. **BMCLAPI 全站 302 + 签名 CDN** 导致 `@xmcl/installer` 的 undici 报 `maxRedirections is not supported` → 自研 `game.ts` 走全局 fetch。
4. **PowerShell 改源码会毁中文**（mojibake / 字面量断裂）→ 一律用编辑工具；必须在 PS 里写文件就用 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`。
5. **PaperMC `/v2` API 已 410 Gone** → 用 v3：`https://fill.papermc.io/v3/projects/paper/versions/<ver>/builds` → `downloads['server:default'].url`。
6. **Fabric 撤了 `/server/jar`**（实测 404）→ 用 fabric-installer：`java -jar installer.jar server -dir <dir> -mcversion <v> -loader <lv> -downloadMinecraft`。
7. **`api.github.com` 在本机 fetch 不通** → 下载 bore 客户端做四级回退（API → 固定版本 → ghfast.top → gh-proxy.com），仍失败提示手动放 `tools/bore.exe`。
8. **便携版启动像卡死**：旧逻辑会把 `%APPDATA%` 里几百 MB 旧实例拷进 U 盘目录 → 便携模式**跳过迁移**，并强制 `PORTABLE_EXECUTABLE_DIR/WFMC-Data`。
9. **`position: relative` 会继承 `left/bottom` 造成二次位移**（音乐按钮压住主题按钮）→ 显式 `left/right/top/bottom: auto`。
10. **原生 `<select>` 的弹层无法改样式/无动效** → 自绘 `components/Select.tsx`。
11. **拖拽链接（`text/uri-list`）必须 `preventDefault` 才会触发 drop**（原来只处理 Files，导致 LittleSkin 卡片拖进来没反应）。
12. **单实例锁会让自动化截图静默失败**（见 §9 注意）。
13. **给 `capturePage` 传窗口尺寸变化**、或窗口在最小化状态时截图全黑 → 截图前确保窗口已 show。
14. **本机有个死掉的代理 `127.0.0.1:3067`**：`npm`/`electron-builder`/`publish` 之前必须 `foreach ($n in 'HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY','NO_PROXY','no_proxy') { Remove-Item "env:$n" -ErrorAction SilentlyContinue }`；大小写两份都要删，否则 `Start-Process -RedirectStandardOutput` 会抛「已添加项。字典中的关键字」。
15. **`pwsh` 里别写 `node -e "...正则..."`**：引号和括号会被 PowerShell 拆碎（报「表达式或语句中包含意外的标记」）。要跑一次性脚本就写 `.tmp-x.cjs` 再 `node .tmp-x.cjs`。
16. **`styles.css` 是 LF/CRLF 混排**：用 here-string 做替换经常静默不生效，改它一律用 node `readFileSync` + `includes()` 校验后再 `writeFileSync`。
17. **自检截图的时机**：`WFMC_SHOT_DELAY` 从进程启动算，页面慢的时候截图会落在你的 JS 跑完之前——所以 JS 里的 `await sleep()` 尽量压到 1.5s 以内，或者用 `setInterval` 反复把状态摆回去。

---

## 14. 版本演进：1.0.20 → 1.0.27（接手时先读这一节）

这一节只写「现在系统里有什么」和「为什么这么写」，细节看对应源码。

### 14.1 下载与 Java

- `src/main/fastdl.ts`：自研多线程下载器 `MultiDownloader`（默认 48 线程、8 分片、`MIN_CHUNK=8MB`、`.part.json` 断点续传、30s 无进度超时）。`Download.tsx` 支持贴链接下载、暂停/继续/取消。
- `src/main/java.ts`：`installJavaRuntime` 自己按 Mojang runtime index 装 JRE（绕开 `@xmcl` 的 AggregateError），`fetchToFile(url, dest, {size, sha1}, maxAttempts, onRetry)` **必须**带 Range 续传 + sha1/size 双校验——本机断流会把 jvm.dll 下成半截且大小偶合，不校验就会「Java 装好了但启动报 0xc000007b」。装完 `probeJava` 真跑一次 `-version` 才算成功。
- 下载源默认 `mirror`（BMCLAPI），`settings.mirrorMigrated` 做过一次性迁移。

### 14.2 加载器与模组诊断

- `src/main/moddoctor.ts`：解析 `fabric.mod.json` / `quilt.mod.json` / `META-INF/(neoforge.)mods.toml`，判「加载器不匹配」「缺前置」「前置版本对不上」。
  - Forge/NeoForge 一定按 `[[dependencies.xxx]]` **段落**解析（同一行匹配会把模组自身也算成依赖）；
  - 版本范围 `satisfiesRange()` 支持 `>=1.0 <2.0` / `~` / `^` / `1.2.x` / Maven `[1.0,2.0)`；看不懂的写法返回 true（宁可不报，不乱吓人）。
- `ModIssue.fixLoader`（一键换加载器，`Manage.tsx` 里渲染按钮）与 `fixDep`（一键补前置）。
- `src/main/moddeps.ts`：`resolveProjectId(modid)` 先按 slug 查 Modrinth，失败再三轮 search；`fixMissingDeps` → `installResource`（自带递归装 required 依赖）。
- 常量 `NOT_A_MOD` 里的伪依赖（minecraft / java / forge / fabricloader…）一律跳过。

### 14.3 汉化资源包（VM + CFPA 双源）

- `src/main/langpack.ts`：`installLangPacks(instanceId)` 同时装两个源——Modrinth 项目 `vmct`（VM 汉化组，210 个 modid）和 GitHub `CFPAOrg/Minecraft-Mod-Language-Package` 的 release 资产（400 个 modid，`github.com` 本机不通，必须走 `gh-proxy.com` → `ghfast.top` 镜像）。装完调 `options.ts` 的 `enableResourcePack()` 写 `resourcePacks` + `lang:zh_cn`。
- `inspectLangPack()` 返回两个包的**并集**覆盖数；`readPackContents()` 读单个 zip 里所有 `assets/<modid>/lang/zh_cn.json` 并数 key，给「看看翻了哪些模组」弹层用。
- `removePack()` / `removeLangPacks()` 删文件前一定先 `disableResourcePack()` 摘掉 `options.txt` 里的 `file/xxx.zip`，否则游戏会报资源包缺失。
- **已知无解**：作者把语言文件路径写成 `assets/modid/lang/en_us.json`（模板没替换）或界面文字硬编码 `drawString` 的模组，任何资源包都翻译不到（例：Lucky Blocks）。

### 14.4 存档打包 / 恢复（带完整性校验）

- `src/main/worldpack.ts`：`packWorld()` 把存档目录压成 `.wfmcworld.zip`，第一个条目是 `wfmc-worldpack.json` 清单（每个文件的相对路径 / 大小 / SHA-1，外加一个整体 `digest`）。
- `inspectWorldPack()` 只校验不写盘；`restoreWorldPack()` **先全量校验，任何一个文件对不上就直接抛错、一个字节都不写**；同名存档自动改名 `名字 (恢复 20261030-1742)`；写盘带 zip-slip 防护。没有清单的老 zip 按 `world/` 前缀剥离后整体解出（`signed:false`）。
- `src/main/zip.ts` 的 `writeZipCompressed()` 逐文件 `deflateRawSync`，压不动自动退回 store，所以从包里再打一次包 digest 完全一致（round-trip 已验证）。

### 14.5 界面这几处被重写过，改之前先看

- `views/Home.tsx`：主页三块（数据面板 / 快捷操作 / 启动日志）支持 App 式拖动——按住 140ms 起拖、浮层跟随、原位留虚线占位、其它卡做 FLIP 让位动画；`settings.homeLayout` 存顺序。
- `styles.css` 的 `.grid-2` 有 `align-items: start`（否则同排两卡互相拉高）；`.progress-fold` 用 `grid-template-rows: 0fr→1fr` 做折叠动画；`.drag-float` 是 `position: fixed` 的拖拽浮层（`z-index: 900`）。
- 首页按钮互斥靠 `store.tsx` 暴露的 `runningTask`（`tasks.find(t=>t.status==='running')`），**任何新加的耗时按钮都要判它**。
- `views/Manage.tsx`：内容工具栏 + 存档工具栏（打包/校验/恢复）+ 汉化包提示条（看看翻了哪些 / 卸载）+ 资源包「内容」弹层。
- `views/UpdateCenter.tsx`：更新中心（hero 版本对比、历史版本时间线、资产下载、更新源输入）。

### 14.6 任务系统是硬约定

**所有**可能超过 1 秒的操作都必须 `runTask(kind, title, async (ctx) => …)`，并且进度上报要带 `taskId: ctx.id`——不带的话渲染层的「任务结束就清掉这条进度」逻辑匹配不上，那条进度会在首页永远挂着（`mods:updates` 就踩过这个坑，表现为永远「计算文件指纹 0/2」）。

### 14.7 ??? / ???????????1.0.28?

- ??????? = `<exe ???>\WFMC-Data`???? = `%APPDATA%\WFMC\data`???????? `settings.json`????????????????????**??????**???????????????
- ?? `Settings.useSharedData`???????? `store.setSharedData(true/false)` ? `dataDir` ???????????????????????`store.load()` ?????????????????????????????
- IPC?`data:shared-info`????? + ?????/????`data:use-shared`???????????????????????
- ???????? `store.reloadAccounts()`???????????????????????
