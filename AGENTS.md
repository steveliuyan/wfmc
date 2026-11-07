# AGENTS.md · WFMC 开发 / 发版须知

给接手的人（或 AI）看的。**每次准备发版时，先读这个文件，再照做，不要凭记忆。**

完整交接文档在 `HANDOFF.md`（只在本地/交接用，不推公开仓库），发版的权威步骤是它的 **§1.5**。本文件是那份步骤的执行摘要。

---

## 0. 项目速览

- `H:\mcqidongqi`，Electron 38 + React 19 + `@xmcl/*`，主进程 `src/main`，渲染 `src/renderer`。
- 主进程走 esbuild 打包（`npm run build:main`），渲染走 vite（`npm run build:renderer`）。
- **本机没有 git、没有 gh CLI**。所有发布动作都靠 `scripts/*.mjs` + GitHub REST API。

## 1. 发版前自检

```powershell
cd H:\mcqidongqi
npm run typecheck
npm run build          # 或 npm run dist（含打包）
```

- 版本号只改 `package.json` 的 `"version"`。
- ⚠️ **改 `package.json` 必须保持无 BOM 的 UTF-8**。用编辑器改，或用
  `[System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))`。
  写成带 BOM 会让 vite 读 package.json 当 PostCSS 配置时直接 `Unexpected token ''`，构建失败。
- `scripts/` 里的 `tmp-*`、`*test*` 之类临时脚本，发版前删干净。

## 2. 打包

```powershell
npm run dist          # → release\WFMC-Portable-X.Y.Z.exe + WFMC-Setup-X.Y.Z.exe
```

- 打完之后 **`release\` 里只能有当前版本的两个 exe**（旧版本 exe 会被发布脚本一起传上去），顺手删 `builder-debug.yml`。
- 增量补丁（可选）：`node scripts/make-delta.mjs release\WFMC-Setup-旧.exe release\WFMC-Setup-新.exe release\WFMC-Setup-旧-to-新.wdelta`。
  发布脚本只传 `.exe`，`.wdelta` 需要单独处理。
- 改过 `build/installer.nsh` 或向导位图，必须重打 Setup 并在安装向导里亲眼过一遍。

## 3. 更新说明

`CHANGELOG.md` **顶部那一段**就是 release 的更新说明（脚本用 `--notes CHANGELOG.md` 整篇读入，所以最新的放最上面）。

## 4. 发布到 GitHub（`steveliuyan/wfmc`）

### 4.1 token 在哪里

**`H:\mcqidongqi\.local\gh-token.txt`** —— classic token，只勾 `repo` 权限，login = `steveliuyan`。

- 这是本机唯一存放位置：`.local/` 在 `.gitignore` 里，`scripts/opensource.mjs` 的 `SKIP_DIRS` 也会跳过它，永远不会被推上 GitHub。
- **不要把 token 写进任何会被推送的文件**（HANDOFF / AGENTS / 脚本 / README 都不行）。GitHub 有 push protection，一旦推上去会 422 `Secret detected in content`，整次源码推送失败。
- token 失效：去 https://github.com/settings/tokens/new?scopes=repo 重新生成，覆盖写回同一个文件：
  ```powershell
  Set-Content H:\mcqidongqi\.local\gh-token.txt -Value 'ghp_新token' -NoNewline -Encoding ascii
  ```

### 4.2 发布命令（清代理 → 读 token → 后台跑脚本）

```powershell
cd H:\mcqidongqi
foreach($n in 'HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NODE_USE_ENV_PROXY','NO_PROXY','no_proxy'){ Remove-Item -Path ("env:" + $n) -ErrorAction SilentlyContinue }
$env:GH_TOKEN = (Get-Content .local\gh-token.txt -Raw).Trim()
node scripts\publish-github.mjs --owner steveliuyan --repo wfmc --tag vX.Y.Z --notes CHANGELOG.md
```

- 两个附件共 ~185 MB，**上传要 10 分钟以上，放后台跑**，别用短超时前台等。
- 脚本会自动：校验 token → 确认/创建仓库 → 建或更新 release（说明取 CHANGELOG 顶部）→ 逐个上传 `release\*.exe`。
- 成功的标志：日志里两个 exe 都出现 `✓ xxx.exe → https://github.com/...`。
- 环境变量只在单次 pwsh 进程里有效——清代理、读 token、跑脚本必须写在**同一条命令**里。

### 4.3 发完必做：删旧 release

```powershell
node scripts\cleanup-releases.mjs --owner steveliuyan --repo wfmc --keep vX.Y.Z --dry   # 先看一眼
node scripts\cleanup-releases.mjs --owner steveliuyan --repo wfmc --keep vX.Y.Z
```

仓库只留最新一个 release，否则用户的更新源会串版本。删之前确认新 release 两个附件都在。

### 4.4 推源码

```powershell
node scripts\opensource.mjs --repo wfmc --message "feat: WFMC X.Y.Z …"
```

`node_modules` / `dist` / `release` / `WFMC-Data` / 日志 / `.local` / `HANDOFF.md` 都不推。

## 5. 客户端怎么拿到更新

`src/main/store.ts` 里 `settings.updateUrl` 默认 `steveliuyan/wfmc`，`src/main/updater.ts` 读 GitHub Releases。
所以 **release 的 tag 必须是 `vX.Y.Z`，两个 exe 必须挂在这个 release 上**，否则用户检查更新拿不到。

## 6. 别的坑

- 打包时的 electron / electron-builder 二进制走 `.npmrc` 里配的 npmmirror 镜像，不用手设 `ELECTRON_MIRROR`。
- `release\win-unpacked\WFMC.exe` 是免安装版主程序，`HANDOFF.md` §9 的 `WFMC_SHOT*` 环境变量可以给它截图，方便验收界面。
- 涉及文件系统合并/备份的逻辑（模组快照、整合包升级、存档快照）都有纯函数 + 临时脚本单测的路子：用 esbuild 把模块 bundle 出来，`--alias:electron=./scripts/tmp-electron-stub.cjs` 顶掉 electron，再 `node` 跑断言。**验证完把临时脚本删掉。**

## 7. 交接文档：每做一块功能，必须留一份「接手能直接开工」的文档

用户的硬要求：**干什么都要做交接文档，让后续接手的人（或 AI）能快速理解。**

- 改动涉及**新模块 / 新 IPC / 新外部依赖（服务端、第三方 API）**时，除了改代码，还要落文档：
  - 项目整体的：更新 `HANDOFF.md` 对应小节（§2.1 模块表、§4 IPC 表、§7 之类的专题节）；
  - 对外契约（服务端接口、别人要对齐的协议）：单独一份放到 `docs/`，例如 `docs/SERVER-API.md`，
    **协议改了先改这份文档**，再改客户端；
  - 长期计划：`ROADMAP-1.2.0.md`（分版本交付顺序、风险登记、每版 checklist）。
- 文档要写「**为什么**」和「**坑**」，不是只抄代码：数据落在哪、失败怎么降级、哪些字段绝不能上传/外传、
  以及**还没做的部分**（接手最容易踩的就是不知道边界在哪）。
- 判断标准：一个没参与过的人只看这份文档 + 代码，能在半小时内说清「这块干什么、改哪里、怎么验」。