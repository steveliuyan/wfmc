# WFMC 服务端接口契约 v1（客户端 ↔ 自建服务器）

> ⚠️ **这是动手前的契约草稿：下面写的路径是 `/api/v1`，实际实现是 `/v1`，字段也有出入。**
> **要读现在真实的接口，请看 [`docs/服务端交接.md`](服务端交接.md)**（2026-11-07 按服务端实际代码逐条核对）。本文件只留作设计意图存档。

> **这份文档是给「服务器那一侧」看的。** 客户端已经写好了，只要服务端照着这个返回，
> 启动器「设置 → 云同步」就能直接连上。
>
> - 客户端代码：`src/main/cloudapi.ts`（网络层）、`src/main/cloudsync.ts`（业务）、`src/main/configpack.ts`（配置包）
> - 界面：`src/renderer/components/CloudPanel.tsx`
> - 改动协议先改**这份文档**，再改客户端，最后通知服务端。
>
> 版本：v1（2026-11-06）。字段只增不改；确实要改就升 `API_PREFIX` 到 `/api/v2`。

---

## 1. 部署形态（用户的实际环境）

```
启动器 (Windows)  ──HTTPS──►  域名 mc.example.com  ──内网穿透──►  笔记本电脑上的服务端进程
```

要求：

1. **必须 HTTPS**：客户端默认开启证书校验，自签证书会直接失败（局域网测试可先用 http）。
   用 frp / cloudflared / nps 之类做穿透时，把证书 termination 放在公网入口（Cloudflare Tunnel 最省事）。
2. 服务端只暴露一个根路径（`/api/v1/...`），根路径自带子路径前缀也没关系
   （客户端会保留你填的路径，例如 `https://example.com/wfmc` → `https://example.com/wfmc/api/v1/health`）。
3. 单实例进程即可，不需要数据库：**用目录 + JSON 索引**就够。
   ```
   data/
     devices.json           # 设备表：deviceId → { tokenHash, name, platform, createdAt, lastSeenAt }
     pair-codes.json        # 待用配对码：code → { expiresAt, note }
     backups/
       <deviceId>/
         <backupId>.zip     # 备份文件本体
         index.json         # [{ id, kind, size, sha256, createdAt, appVersion, note }]
     announcements.json     # 公告（也可以放数据库，量很小）
   ```
4. 单次请求不要超过 100 MB（客户端配置包通常 1–20 MB）。要传更大的东西请走后续的分片接口（v1 没有）。

---

## 2. 通用约定

| 项目 | 约定 |
|---|---|
| 基础路径 | `/api/v1` |
| 编码 | 请求/响应都是 UTF-8 JSON；上传是 `multipart/form-data` |
| 认证 | `Authorization: Bearer <deviceToken>`（除 `/health`、`/auth/pair` 外都要） |
| 版本头 | `X-WFMC-Version: 1.0.48`（客户端版本号，服务端可据此做最低版本限制/灰度） |
| 时间 | 全部是 **毫秒时间戳（UTC）**，字段名以 `At` 结尾 |
| ID | 服务端生成，字符串，URL 安全（`[A-Za-z0-9_-]`） |
| 超时 | JSON 请求 15s，上传/下载 10–30min，客户端会自己取消 |
| 幂等 | `PUT`/`DELETE` 建议幂等，客户端失败会重试 1 次 |

### 2.1 错误格式（**重要：客户端靠它显示中文提示**）

任何非 2xx 都返回：

```json
{ "error": { "code": "token_invalid", "message": "设备令牌无效，请在设置里重新配对" } }
```

`message` 会**原样显示给用户**，所以请写人话（中文），不要写英文栈信息。

客户端已按状态码兜底（服务端没给 message 时用）：

| 状态码 | 客户端默认提示 |
|---|---|
| 401 | 设备令牌无效或已过期，去设置里重新配对 |
| 403 | 这台设备没有权限 |
| 404 | 服务端没有这个接口（版本对不上？） |
| 413 | 备份文件太大，服务端拒收 |
| 429 | 请求太频繁，稍后再试 |

建议使用的 `code`：`token_invalid` / `token_expired` / `pair_code_invalid` / `pair_code_expired` / `quota_exceeded` / `payload_too_large` / `not_found` / `internal`。

---

## 3. 接口清单

### 3.1 `GET /api/v1/health` — 健康检查（**不需要令牌**）

用于「测试连接」按钮。**必须实现**，客户端第一件事就是打它。

```json
200 OK
{
  "ok": true,
  "name": "WFMC 家庭服",
  "version": "1.0.3",
  "time": 1730000000000,
  "minClientVersion": "1.0.40",
  "note": "这台服务器放在书房的小主机上，晚上 2 点会重启"
}
```

- `ok` 省略视为 `true`；服务端维护中返回 `{ "ok": false, "note": "维护中，预计 30 分钟" }`（仍返回 200）。
- `note` 会显示在设置页，适合写「这台机器的说明」。
- 客户端不会因为 `minClientVersion` 而拒绝启动（只在公告里提示）。

### 3.2 `POST /api/v1/auth/pair` — 换设备令牌（两种方式）

启动器**默认走自动接入**：装好就能用，不需要注册、不需要配对码。请求体里带 `auto: true` +
`appKey`（编译期常量 `CLOUD_APP_KEY`，见 `src/shared/cloud-defaults.ts`）即可直接换到令牌；
只有用户自己填了第三方的服务器地址、或者作者那边关闭了自动接入时，才走配对码。

```http
POST /api/v1/auth/pair
Content-Type: application/json

// ① 自动接入（默认服务器用这条）
{ "auto": true, "appKey": "wfmc-launcher-2026", "deviceName": "书房的台式机", "platform": "win32" }

// ② 配对码（自定义服务器用这条）
{ "pairCode": "K7M2-QX9P", "deviceName": "书房的台式机", "platform": "win32" }
```

```json
200 OK
{
  "deviceToken": "wfmc_5f2c8a...（32 字节随机，base64url）",
  "deviceId": "dev_01",
  "deviceName": "书房的台式机",
  "note": "已自动接入（免费云同步）"
}
```

- 令牌**只在这一次返回**，客户端 DPAPI 加密后存本机（`cloud-auth.json`），之后不再请求。
- 服务端只存 `sha256(deviceToken)`，别存明文。
- 配对码错误：`400 { "error": { "code": "pair_code_invalid", "message": "配对码不对，或者已经用过了" } }`。
- 自动接入被关闭 / appKey 不对：`403 pair_code_invalid`；同一 IP 每小时接入太多台：`429 quota_exceeded`。
- `appKey` **不是密钥**，只是挡掉随手 curl 的扫描器；真正的防线是每 IP 每小时的接入上限（默认 20）加每设备配额。

### 3.3 `GET /api/v1/announcements` — 公告

```http
GET /api/v1/announcements?channel=stable&lang=zh
Authorization: Bearer ...
```

```json
200 OK
{
  "items": [
    {
      "id": "a1",
      "level": "info",
      "title": "今晚 23:00 例行重启",
      "body": "重启期间联机房间会断开，预计 5 分钟。",
      "url": "https://mc.example.com/status",
      "pinned": true,
      "publishedAt": 1730000000000,
      "expiresAt": 1730086400000,
      "minVersion": "1.0.40",
      "maxVersion": null
    }
  ]
}
```

- `level`：`info` | `warn` | `critical`（`critical` 在客户端是红色不可忽略）。
- 客户端 **1 小时缓存**；`expiresAt` 过了自动不显示；`minVersion` 大于客户端版本时不显示。
- 公告拉不到不影响任何功能（客户端静默降级）。

### 3.4 `POST /api/v1/backups` — 上传一份备份

```http
POST /api/v1/backups
Authorization: Bearer ...
Content-Type: multipart/form-data; boundary=...

字段：
  meta = {"kind":"config","sha256":"…","createdAt":1730000000000,"appVersion":"1.0.48","keep":8}
  file = wfmc-config-2026-11-06T08-00-00.zip   (application/zip)
```

```json
201 Created
{ "id": "b_7f3a", "kind": "config", "size": 1843200, "sha256": "…", "createdAt": 1730000000000, "appVersion": "1.0.48" }
```

要求：

- **必须校验 `meta.sha256`**，对不上返回 `400 payload_corrupt`（客户端上传前自己算过，理论上不会错）。
- 返回的 `sha256` 会用于以后的下载校验，请回传服务端实际落盘后的哈希。
- `kind` 目前固定 `config`；`instance`（整实例 zip）留给以后的版本。
- 落盘位置：`data/backups/<deviceId>/<id>.zip`，并在 `index.json` 里追加一条。
- 建议服务端自己也按 `meta.keep` 滚动删（客户端也会调 DELETE 清理一次，双保险）。

### 3.5 `GET /api/v1/backups?kind=config&limit=20` — 列表

```json
200 OK
{ "items": [ { "id": "b_7f3a", "kind": "config", "size": 1843200, "sha256": "…", "createdAt": 1730000000000, "appVersion": "1.0.48" } ] }
```

- **按 `createdAt` 倒序**（最新在前）。客户端默认取 20 条，最多 200。

### 3.6 `GET /api/v1/backups/{id}` — 下载

- 直接返回 zip 二进制，`Content-Type: application/zip`，**带 `Content-Length`**（客户端靠它算进度）。
- 支持 `Range` 更好（客户端现在整包下载，将来会用到）。
- 客户端边下边算 sha256，与列表里的 `sha256` 比对，不一致就丢弃并报错。

### 3.7 `DELETE /api/v1/backups/{id}` — 删除

```json
204 No Content
```

已经不存在也返回 204（幂等）。

### 3.8 `GET /api/v1/usage` — 配额（可选）

```json
200 OK
{ "count": 8, "bytes": 24117248, "quotaBytes": 5368709120 }
```

客户端暂时只展示，不做限制。

---

## 4. 备份包里到底是什么（服务端**不需要**解析）

配置包是客户端打的 zip，内容仅供你排查问题：

```
manifest.json          { "kind": "wfmc-config", "createdAt": …, "accounts": 2, "instances": 3, "servers": 5 }
settings.json          启动器设置（已剥掉：云配置、API Key、代理、绝对路径、窗口位置）
accounts.json          { "accounts": [ { "id", "type", "name", "uuid" } ] }   ← **没有令牌**
servers.json           服务器列表（地址/MOTD/图标缓存）
instances/<id>/instance.json   每个实例的元数据（不含游戏文件、不含存档）
```

**服务端不要解压、不要索引内容**，当成不透明二进制存就行（隐私最小化）。

---

## 5. 服务端实现清单（照着打勾即可）

- [ ] `GET /health` 返回 `{ok:true,name,version,time}`
- [ ] `POST /auth/pair`：配对码校验 + 签发随机令牌 + 只存哈希
- [ ] 中间件：解析 `Authorization: Bearer`，校验哈希，失败回 401 + `token_invalid`
- [ ] `GET /announcements`（没有公告就返回 `{"items":[]}`）
- [ ] `POST /backups`（multipart 解析 + sha256 校验 + 落盘 + 索引）
- [ ] `GET /backups`（倒序 + limit）
- [ ] `GET /backups/{id}`（二进制 + Content-Length）
- [ ] `DELETE /backups/{id}`（幂等 204）
- [ ] 错误统一 `{ "error": { "code", "message" } }`，`message` 写中文
- [ ] 请求体上限（例如 120 MB）+ 每设备备份上限（例如 20 份 / 5 GB）
- [ ] HTTPS（穿透隧道那一层做证书）
- [ ] 管理员工具：生成配对码、查看设备列表、撤销设备

## 6. 联调自测（跑通这 5 条就算接好了）

```bash
BASE=https://mc.example.com/api/v1

# 1) 健康检查
curl -s $BASE/health

# 2) 配对（先在服务端生成配对码）
curl -s -X POST $BASE/auth/pair -H 'Content-Type: application/json' \
  -d '{"pairCode":"K7M2-QX9P","deviceName":"test","platform":"win32-x64"}'
# 拿到 deviceToken 后：
TOKEN=...

# 3) 上传（随便一个 zip）
curl -s -X POST $BASE/backups -H "Authorization: Bearer $TOKEN" \
  -F 'meta={"kind":"config","sha256":"'"$(sha256sum t.zip | cut -d" " -f1)"'","createdAt":1730000000000}' \
  -F 'file=@t.zip'

# 4) 列表 / 下载 / 删除
curl -s "$BASE/backups?kind=config&limit=5" -H "Authorization: Bearer $TOKEN"
curl -s -o out.zip "$BASE/backups/b_7f3a" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE "$BASE/backups/b_7f3a" -H "Authorization: Bearer $TOKEN" -i

# 5) 公告
curl -s "$BASE/announcements?lang=zh" -H "Authorization: Bearer $TOKEN"
```

再回到启动器「设置 → 云同步」：填地址 → 测试连接 → 填配对码 → 配对 → 立即备份 → 刷新列表，五个动作都通就是接完了。

---

## 7. 安全清单（不满足就别开公网）

- [ ] 令牌只在配对时下发一次，服务端只存哈希
- [ ] 所有备份操作都按 `deviceId` 鉴权，A 设备读不到 B 设备的备份
- [ ] 文件名只允许 `[A-Za-z0-9_-]`，防止路径穿越
- [ ] 不解压用户上传的 zip（省得被 zip bomb / 逃逸攻击）
- [ ] 上传大小上限 + 速率限制（每设备每分钟 ≤ 10 次写操作）
- [ ] 日志里不打印令牌、不打印备份内容
- [ ] 备份目录定时快照（服务端自己也要有备份，不然云备份没意义）

---

## 8. 客户端已经做了什么 / 还没做什么

| 能力 | 状态 | 位置 |
|---|---|---|
| 健康检查 / 测试连接 | ✅ | `cloudapi.health` → `cloudsync.testCloudConnection` → 设置页「测试连接」 |
| 配对码换令牌 | ✅ | `cloudapi.pairDevice` → `cloudsync.pairCloudDevice` |
| 令牌加密落盘（DPAPI） | ✅ | `cloudsync.writeAuth` + `store.encryptToken` |
| 打配置包（脱敏） | ✅ | `configpack.buildConfigBundle` |
| 手动上传 / 列表 / 删除 | ✅ | 设置页「配置备份」 |
| 还原（先自动备份当前配置） | ✅ | `configpack.applyConfigBundle` |
| 定时自动备份 | ✅ | `cloudsync.startCloudScheduler`（启动后 90s + 每 N 小时；失败只记日志） |
| 云端滚动保留 N 份 | ✅ | `cloudsync.pruneRemote` |
| 公告拉取 | ✅ 主进程 API 已就绪 | `cloudsync.fetchAnnouncements`；**首页展示还没接**（下一步） |
| 整实例备份（几百 MB） | ❌ 未做 | 将来加分片上传 |
| 双向同步（远端改了往回拉） | ❌ 不做 | 只做「备份/还原」，避免冲突合并的坑 |

**已知限制**：上传进度是粗粒度的（客户端把整个 zip 读进内存一次性 POST），几十 MB 以内没问题；
真要传大文件再改成分片。

---

## 9. 给服务端 AI 的一段话（可以直接粘过去）

> 你要在 Linux/Windows 上写一个 HTTP 服务，监听内网端口，外层用域名 + 内网穿透暴露成 HTTPS。
> 契约见本文件 `docs/SERVER-API.md`：基础路径 `/api/v1`，认证用 `Authorization: Bearer <deviceToken>`，
> 错误统一 `{"error":{"code","message"}}`（message 用中文，会直接显示给用户）。
> 必须实现 6 个接口：`GET /health`、`POST /auth/pair`（配对码换令牌，令牌只存 sha256）、
> `GET /announcements`、`POST /backups`（multipart：`meta` JSON + `file` 二进制，校验 sha256）、
> `GET /backups?kind=&limit=`、`GET /backups/{id}`（二进制带 Content-Length）、`DELETE /backups/{id}`（幂等 204）。
> 存法用目录 + index.json 就够，备份文件当不透明二进制存，**不要解压**。
> 最后跑通第 6 节那 5 条 curl 就算接好。
