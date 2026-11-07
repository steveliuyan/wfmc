# WFMC 1.2.0 路线图（六大方向 · 文件级实施计划）

> 状态：计划稿（2026-11-06）。发版流程见 `AGENTS.md` §4，别凭记忆。
> 六条都做，但**分三个版本交付**：1.1.0 → 1.2.0 → 1.3.0。原因见 §0.2。

---

## 0. 总览

### 0.1 交付切分

| 版本 | 内容 | 为什么放这一版 | 预估 |
|---|---|---|---|
| **1.1.0** | A 云同步 + F1 分享卡 | 纯增量、默认关、失败不阻塞启动；先放出去收反馈 | 7–10 天 |
| **1.2.0** | D 依赖图 → C 服主面板 → B 联机 Mod 对齐 | 三块合起来是「多人一起玩」闭环：开服 → 进房 → 对齐 mod → 缺依赖一看就懂 | 16–22 天 |
| **1.3.0** | E 存档工坊 + F2 全量 i18n + F3 签名 | 唯一会写用户数据的部分，要慢慢放；i18n 是长尾活 | 9–13 天 |

### 0.2 为什么不全塞进 1.2.0

- A 是「网络 + 凭据 + 定时」三件套，出问题面广（各家 WebDAV 行为差异大），必须单独一版观察。
- E 会写 `level.dat`，写坏不可逆，必须配强制快照 + 灰度，不能和别的大改混在一起排查。
- 一个版本里塞 6 个方向，回归测试量会爆炸，历史上 1.0.4x 就是这么拖着不发的。

### 0.3 每条都遵守的约定

- 主进程模块一律「纯函数 + 薄 IPC 壳」，方便用 esbuild alias 掉 electron 后跑 `node` 断言（`AGENTS.md` §6）。
- 新 IPC 命名 `<域>:<动作>`，域沿用现有：`cloud` / `room` / `hosted` / `mods` / `saves` / `share`。
- 渲染层新页面一律走 `window.launcher.invoke`，`src/renderer/api.ts` 里加薄包装。
- 所有会动用户文件的操作，先备份、后原子写（`.tmp` → rename），写完读回校验。
- 新设置项默认关闭，`Settings` 里给中文解释 + 一键恢复默认。

---

## A. 云同步：换机不丢数据（1.1.0）

### A.1 目标与验收

- 用户填一个 WebDAV 地址（坚果云 / OneDrive / 自建），勾「自动备份」；
- 每 N 小时（默认 6h）或退出时自动上传「配置包」；保留最近 8 份滚动删除；
- 新机器上填同一地址 → 一键还原 → 账号列表、实例列表、服务器列表、设置都在；**登录令牌不还原**（DPAPI 密文换机解不开），还原后提示「需要重新登录」；
- 断网 / 认证失败 / 服务器 5xx：只 toast，不阻塞启动，不重试风暴（指数退避，最多 3 次）。

### A.2 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/main/cloudsync.ts`（新，~350 行） | provider 抽象：`webdav`（PROPFIND / PUT / GET / DELETE，Basic auth）、`local`（本地/网络盘目录，方便测试）；`testConn()` / `list()` / `upload()` / `download()` / `prune()`；上传用 `net.ts` 现有 fetch 封装，走系统代理开关 |
| `src/main/configpack.ts`（新，~200 行） | `buildConfigBundle()`：`settings.json`（剥掉 `cloud` / `curseforgeApiKey` / `microsoftClientId` / proxy）+ `accounts.json`（只留 `{id,type,name,uuid}`）+ `servers.json` + 每个实例的 `instance.json` → zip（复用 `zip.ts`）；`applyConfigBundle()`：先整目录备份成 `.before-restore-<ts>` 再铺开 |
| `src/main/store.ts` | `Settings` 加 `cloud?: CloudSettings`；凭据用现有 `encryptToken`（DPAPI）存同目录 `cloud.json`，不写 `settings.json` |
| `src/shared/types.ts` | `CloudSettings { enabled, provider:'webdav'\|'local', url, user, remotePath, auto, intervalH, keep, lastBackupAt, lastError? }` |
| `src/main/ipc.ts` | `cloud:test` / `cloud:upload` / `cloud:list` / `cloud:restore` / `cloud:delete` / `cloud:set-credential`（凭据只写不读，返回 `hasCredential: boolean`） |
| `src/main/index.ts` | `whenReady` 里挂调度：启动 60s 后一次 + `setInterval(intervalH)`；`app.on('before-quit')` 若开启则尽力上传（超时 10s 就放弃） |
| `src/renderer/views/Settings.tsx` | 新分区「云端备份」：地址、账号、密码、间隔、保留份数、「测试连接」「立即备份」「从云端还原」、上次成功时间、错误提示 |
| `src/renderer/views/Home.tsx` | 上次备份超过 2×间隔时，显示一条淡黄提示条 |

### A.3 护栏

- 还原是**破坏性**操作：弹二次确认，列「将覆盖：配置 3 个文件 / 实例 2 个 / 服务器 4 条」，并要求输入 `还原`；
- 上传前打印脱敏清单到日志（只有文件名和大小）；
- 单个备份 > 50 MB 时提示「实例体积较大，建议只备份配置」（实例级备份先不做，留到 1.2.x）；
- 凭据只在主进程解密，渲染层永远拿不到。

### A.4 验证

1. 纯函数：`buildConfigBundle()` 用假目录跑断言，确认 `accounts.json` 里没有 `token` 字段；
2. 本地 provider：`local` 模式指到临时目录，跑 upload → prune（造 10 份，确认只剩 8）→ download → apply，比对文件树；
3. 真实 WebDAV：坚果云手工过一遍（注意它的请求频率限制，1s 一次）；
4. 断网场景：拔网卡跑一次自动备份，确认只有 toast、进程不崩。

---

## B. 联机 2.0：进房前自动对齐 Mod（1.2.0）

### B.1 目标与验收

房主点「生成房间清单」，得到一段可粘贴的文本；队友粘贴后：
- 看到三条清单：**缺的（会自动装）**、**版本不一致的（会提示换成房主那一版）**、**我多出来的（只提示，不动）**；
- 确认后进任务队列（可暂停 / 续传），下载走 Modrinth/CurseForge，带 sha1 校验；
- 全部就绪才允许启动游戏；有「需人工索要」的手动 jar 时，明确列文件名并给「导出清单」。

### B.2 为什么用「清单文本」而不是塞进房间码

`rooms.ts` 的 `encodeRoomCode` 只带 host/port/env，码要短到能口述。清单动辄几 KB，塞不进去。用「短码管连接，长文本管内容」两件套，最稳，也不依赖中继带宽。

### B.3 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/main/roommanifest.ts`（新，~300 行） | `buildManifest(instanceId)`：MC 版本、loader、mods（`{fileName, sha1, size, projectId?, versionId?, source?}`，projectId 从 `moddoctor` 的指纹/曲库匹配拿，拿不到就 null）、光影、资源包；`encodeManifest()` gzip+base64 → `WFMC1:` 前缀文本；`decodeManifest()`；`diffManifest(manifest, instanceId)` → `{ missing, mismatch, extra, manual }` |
| `src/main/moddeps.ts` | 复用 `resolveProjectId`，给清单补 `projectId`；新增 `installByVersionId(projectId, versionId)`（现在只有按「缺前置」装） |
| `src/main/ipc.ts` | `room:manifest` / `room:diff` / `room:fix`（内部 `runTask({kind:'mods'})`，可暂停） |
| `src/renderer/views/Online.tsx` | 房间卡片下加「清单」按钮（房主：生成 / 复制；队友：粘贴 / 比对）；比对结果用可折叠三段列表；底部「开始对齐（N 个，约 320 MB）」 |
| `src/renderer/views/Home.tsx` | 若当前实例有未完成的清单对齐，首页显示「还有 3 个模组没装齐」提示 |

### B.4 护栏

- **只增不删**：`extra` 只列出来，绝不自动删；
- 每个下载校验 sha1，不一致即失败并说明是哪个文件；
- 大包（> 500 MB）先预估体积让用户确认；
- 若两边 MC 版本或 loader 不一致，直接拒绝并提示（不能靠补 mod 解决）。

### B.5 验证

1. 造两个实例 A/B（A 多 2 个 mod、少 1 个、1 个版本不同），`diffManifest` 断言三段各命中；
2. 端到端：本机两份数据目录，A 生成清单 → B 粘贴 → 对齐 → 启动两边都能进同一房间；
3. 断网中途取消，确认任务面板能暂停 + 继续，且不留下半个 jar（下载先落 `.part`）。

---

## C. 服主面板：开服 2.0（1.2.0）

### C.1 目标与验收

- **定时任务**：每 X 小时备份世界（停服 → `save-all flush` → 打 zip → 起服），保留 N 份；每天凌晨自动重启；日志超过 N MB 自动轮转；
- **守护**：进程异常退出或 OOM → 自动重启，指数退避（5s/15s/45s），连续 3 次失败就停下来等人工；
- **玩家面板**：在线玩家列表（解析 `list` 输出）、踢人 / 封禁 / 解封 / 给 OP，写 `whitelist.json` / `banned-players.json` / `ops.json`；
- **插件与 mod**：Hangar 搜索安装（免 key）、Modrinth 按服务端 loader 过滤安装 mod；装前检查依赖，装后退回按钮；
- **看板**：运行时长、内存（解析日志 `Memory: x/y`）、TPS（`/tps` 输出，Paper 才有）、最近 20 条日志。

### C.2 新增 / 修改文件

| 文件 | 改动 |
|---|---|
| `src/main/serversched.ts`（新，~350 行） | 任务表落盘 `hosted/<id>/sched.json`；`runJob(kind)`：backup / restart / logrotate；`startScheduler()` / `stopScheduler()`；看门狗 `armWatchdog(id)` 监听 `proc.ts` 退出事件 |
| `src/main/serveraddons.ts`（新，~300 行） | Hangar：`GET https://hangar.papermc.io/api/v1/projects?q=&limit=20`（免 key）；Modrinth：`facets=[["project_type:mod"],["categories:paper"]]`；`installAddon()` 落 `plugins/` 或 `mods/`，带 sha512 校验；`uninstallAddon()` 移到 `.trash/` |
| `src/main/serverhost.ts` | 补 `writeAccessList(id, type, entries)`（现在只有读）、`parseOnlinePlayers(logLines)`、`currentMemory(logLines)`；`startHosted` 加 `onExit` 回调给看门狗 |
| `src/main/ipc.ts` | `hosted:sched-get` / `hosted:sched-set` / `hosted:backup-now` / `hosted:players` / `hosted:player-action` / `hosted:addon-search` / `hosted:addon-install` / `hosted:addon-remove` / `hosted:metrics` |
| `src/renderer/views/Hosting.tsx` | 右侧改成三个 tab：**控制台**（已有）/ **计划任务** / **插件与 Mod**；顶部状态条加「内存 / TPS / 在线人数 / 已运行」 |
| `src/renderer/views/Hosting.tsx` | 玩家列表行内操作：踢 / 封 / OP（二次确认 + 记日志） |

### C.3 护栏

- **备份必须在停服状态做**（或至少 `save-off` + `save-all flush` 后再 `save-on`），否则世界会脏；
- 自动重启有总开关，且「连续 3 次失败就停」必须有；
- 封禁 / OP 一律二次确认，写文件前先备份成 `.bak-<ts>`；
- 插件安装只走 HTTPS + 校验哈希，拒绝任何「作者主页脚本」。

### C.4 验证

1. 造一个 Paper 服，跑「每次停服前自动备份」，确认 zip 里 `level.dat` 可解析；
2. 手动 kill 进程，看门狗应在 5s 内拉起，且 UI 有「已自动重启 1 次」提示；
3. 连续 kill 3 次，确认停手并提示人工处理；
4. 装一个 Hangar 插件（如 ViaVersion），确认出现在 `plugins/` 且能加载；卸载确认进 `.trash/`。

---

## D. 模组依赖图 + 一键修复（1.2.0，先做，为 B 打底）

### D.1 目标与验收

「内容管理 → 依赖」新 tab：把当前实例的模组依赖画成图——
- 实线 = `depends`，红色虚线 = `breaks`/冲突，灰点 = 缺失前置；
- 有环时把环上的节点描红并给出环路径文字；
- 点节点 → 侧栏：模组名 / 版本 / 文件大小 / 谁依赖它 / 它依赖谁 / 「装前置」「换版本」「停用」「打开所在文件夹」；
- 顶部「一键补全缺失前置」直接调 `fixMissingDeps`，补完图自动刷新。

### D.2 文件

| 文件 | 改动 |
|---|---|
| `src/main/modgraph.ts`（新，~200 行） | `buildGraph(instanceId)`：从 `diagnoseMods()` 的 `ModMeta`（含 depends/breaks）构图；`findCycles()`（Tarjan）；`missingNodes()`；输出 `{nodes, edges, cycles, missing, stats}` |
| `src/main/ipc.ts` | `mods:graph` |
| `src/renderer/views/Manage.tsx` | 新 tab；布局自己写（力导向 + 碰撞，~150 行，不引第三方库）；节点上限 150，超出按「缺前置 / 有冲突 / 普通」折叠成三组按钮 |

### D.3 护栏与验证

- 300+ 模组时不能卡：先渲染骨架，布局在 `requestIdleCallback` 里增量算；上限 150 节点；
- 纯函数断言：造 3 个假实例（缺前置 / 循环依赖 / 重复 mod），验证 `findCycles` 与 `missingNodes` 输出；
- 修一个「体检误报」历史坑：Jar-in-Jar 里的依赖不算缺失（现在 `diagnoseMods` 已处理，图里要保持一致）。

---

## E. 存档工坊（1.3.0）

### E.1 目标与验收

「内容管理 → 存档」新 tab：每个存档显示「世界名 / 版本 / 难度 / 游戏模式 / 游玩时长 / 最后进入时间 / 大小」；
- 可改**白名单字段**：难度、游戏规则（`keepInventory`、`doDaylightCycle`…）、时间、天气、出生点、玩家坐标/血量（卡虚空自救）；
- 「存档体检」：扫 `region/*.mca` 头部，标出损坏/缺失区块，给「从快照恢复」入口；
- 「和上次快照比」：列出差异字段。

### E.2 文件

| 文件 | 改动 |
|---|---|
| `src/main/nbt.ts`（新，~420 行） | 完整 NBT 读写（TAG_Byte/Short/Int/Long/Float/Double/ByteArray/String/List/Compound/IntArray/LongArray），gzip 读写；只做「读成 JS 对象 / 写回字节」，不做 schema |
| `src/main/saveedit.ts`（新，~250 行） | `inspectLevel(saveDir)` → 白名单视图；`patchLevel(saveDir, patch)`（**先 `createBackup` 再写**，`.tmp` → rename，写后读回比对）；`scanRegions(saveDir)` → 损坏清单 |
| `src/main/ipc.ts` | `saves:inspect` / `saves:patch-level` / `saves:scan-regions` |
| `src/renderer/views/Manage.tsx` | 存档 tab 里每行加「详情 / 编辑 / 体检」 |

### E.3 护栏（最重要）

1. 每次写入前**强制**生成一份快照，命名带 `auto-before-edit`，且这一份不受 `keep=12` 的裁剪影响（至少保留 3 份）；
2. 只允许白名单字段，其它字段原样回写（不做「读进来再整体序列化」的粗放写法，要用「定点改值」保持其余字节不变——这是最容易写坏存档的地方）；
3. 世界正在运行时禁止编辑（检查实例是否 running）；
4. 有 `level.dat_old` 时一并保留。

### E.4 验证

- 用真实的 1.20.1 存档做往返测试：读 → 原样写回 → 字节级比对必须一致（这一步能挡住 90% 的写坏风险）；
- 改 `Difficulty` 后进游戏验证生效；
- 人为截断一个 `.mca`，确认 `scanRegions` 能报出来。

---

## F. 分享卡 + i18n + 签名

### F1. 分享卡（1.1.0，~1.5 天）

| 文件 | 改动 |
|---|---|
| `src/renderer/components/ShareCard.tsx`（新） | canvas 画 1080×1440 卡片：实例名、MC 版本、loader、模组数、游玩时长、封面截图（取该实例最新截图，没有就用默认底图）、启动器品牌条 |
| `src/main/ipc.ts` | `share:save-png`（base64 → 写到截图目录）、`share:copy-image`（`clipboard.writeImage`） |
| `src/renderer/views/Manage.tsx` | 截图 tab 每张图加「生成分享卡」；首页「本次游玩总结」弹一次 |

### F2. 界面全量 i18n（1.3.0，~3 天）

- 现状：`translate(settings.language, key, fallback)` 只覆盖导航和常用按钮；
- 做法：新建 `src/renderer/i18n/zh.json` / `en.json`，按 `页面.区块` 命名；`Settings` 里已有语言选择；
- 顺序：Settings → Home → Instances → Content（Manage）→ 其余；
- 验收：切英文后常用路径无中文残留（写个脚本扫 `.tsx` 里未走 `t()` 的中文字符串，当 CI 检查）。

### F3. 代码签名（1.3.0，等证书，~0.5 天）

- `electron-builder` 加 `win.signtoolOptions` 或 `certificateSubjectName`；
- 需买 OV/EV 证书；买前先在 `AGENTS.md` 里记一笔「签名后必须重测自动更新」（签名变了会导致旧版本升级路径重新触发 SmartScreen 判定）。

---

## G. 排期建议

```
第 1 周   A 云同步（主进程 + 本地 provider 跑通）
第 2 周   A 收尾（UI / 定时 / 真实 WebDAV）+ F1 分享卡   → 发 1.1.0
第 3 周   D 依赖图（纯前端收益，先把图铺好）
第 4-5 周 C 服主面板（调度 + 看门狗 + 玩家面板）
第 6 周   C 插件市场 + B 联机对齐起步
第 7 周   B 联机对齐收尾 + 整体回归               → 发 1.2.0
第 8-9 周 E 存档工坊（NBT 往返测试先跑满）
第 10 周  F2 i18n 全量 + F3 签名                  → 发 1.3.0
```

## H. 风险登记

| 风险 | 影响 | 应对 |
|---|---|---|
| 各家 WebDAV 行为差异（坚果云限频、部分不给 Range） | A 还原失败 | 先只支持「整包 PUT/GET」，不做 Range；错误信息带上服务端原文 |
| 房间清单文本太长，QQ 粘贴被截断 | B 用不起来 | 清单压缩后 > 6 KB 就只带「模组指纹摘要 + 下载提示」，完整清单走文件/链接 |
| 看门狗造成「重启风暴」 | C 烧 CPU / 反复崩 | 指数退避 + 连续 3 次停手 + UI 显式提示 |
| NBT 写坏存档 | E 数据丢失 | 白名单定点改 + 强制快照 + 字节级往返测试 |
| 依赖图 300+ 模组卡顿 | D 页面无响应 | 150 节点上限 + 折叠分组 + 增量布局 |
| 一个版本塞太多 | 回归漏测 | 已按 §0.1 拆三版；每版只测本版 + 上版全量 smoke |

## I. 每版发布 checklist

照 `AGENTS.md` §4 走，不要凭记忆：
1. `npm run typecheck` + `npm run build`
2. 删临时脚本，`release\` 只留当前版本两个 exe
3. `CHANGELOG.md` 顶部写本版说明
4. `publish-github.mjs --tag vX.Y.Z`
5. `cleanup-releases.mjs --keep vX.Y.Z`
6. `opensource.mjs --message "..."`
