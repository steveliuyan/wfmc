/**
 * 动态文案规则（带变量的模板串）。
 *
 * 词典（i18n-zh.ts / i18n-parts）只能整段精确匹配，而界面上大量文案是
 * `安装失败：${e.message}` / `已备份 ${n} 个存档` 这种模板串，运行期拼出来的是
 * 实际值，静态 key 永远命不中。这里用一组正则把「形状」翻掉，变量原样塞回去。
 *
 * 单独成文件的原因：`scripts/i18n-scan.mjs` 也要用同一套规则判断「这条模板串
 * 在运行期会不会被翻掉」，避免扫描器和运行时各写一份、慢慢跑偏。
 */

const VERBS: Record<string, string> = {
  安装: 'Install',
  安装整合包: 'Install modpack',
  卸载: 'Uninstall',
  下载: 'Download',
  备份: 'Backup',
  导出: 'Export',
  导入: 'Import',
  读取: 'Read',
  读依赖: 'Read dependencies',
  检查: 'Check',
  启动: 'Launch',
  切换: 'Switch',
  清除: 'Clear',
  清理: 'Clean',
  清空: 'Clear',
  上传: 'Upload',
  登录: 'Sign in',
  正版登录: 'Sign-in',
  进服: 'Join',
  创建: 'Create',
  保存: 'Save',
  操作: 'Action',
  穿透: 'Tunnel',
  分享: 'Share',
  更新: 'Update',
  体检: 'Check-up',
  套用: 'Apply',
  删除: 'Delete',
  解压: 'Extract',
  恢复: 'Restore',
  校验: 'Verify',
  打包: 'Pack',
  统计: 'Compute',
  迁移: 'Migrate',
  换目录: 'Switch folder',
  扫描: 'Scan',
  停用: 'Disable',
  启用: 'Enable',
  复制: 'Copy',
  还原: 'Revert',
  回滚: 'Roll back',
  发送: 'Send',
  添加: 'Add',
  读取版本列表: 'Read version list',
  拉取加载器版本: 'Load loader versions',
  装加载器: 'Install loader',
  装汉化包: 'Install language pack',
  补前置: 'Install dependencies',
  房间码: 'Room code',
  'CF 搜索': 'CurseForge search',
  获取版本: 'Fetch version',
  导入实例: 'Import instance',
  导出整合包: 'Export modpack',
  打开目录: 'Open folder'
}

/** 动词表里没有的词原样保留（宁可半中半英，也不要瞎猜） */
function verb(word: string): string {
  return VERBS[word.trim()] ?? word.trim()
}

/**
 * 动态串翻译：命中返回英文，否则 undefined（交给后面的通用替换）。
 *
 * 规则顺序有讲究：**具体的放前面**，`已导出整合包：` 必须比 `已导出：` 先试，
 * 否则会被后者吃掉一半。
 */
export function convertDynamic(value: string): string | undefined {
  const v = value.trim()
  let m: RegExpMatchArray | null

  /* --- 通用「X 失败：原因」/「X 成功：结果」 --- */
  if ((m = v.match(/^(.{1,20}?)(失败|出错)：(.+)$/))) return `${verb(m[1])} failed: ${m[3]}`
  if ((m = v.match(/^(.{1,20}?)成功：(.+)$/))) return `${verb(m[1])} ok: ${m[2]}`
  if ((m = v.match(/^「(.+)」安装失败：(.+)$/))) return `Failed to install “${m[1]}”: ${m[2]}`
  if ((m = v.match(/^(.+) 安装失败：(.+)$/))) return `Failed to install ${m[1]}: ${m[2]}`
  if ((m = v.match(/^读不了这个包：(.+)$/))) return `Can't read this package: ${m[1]}`
  if ((m = v.match(/^打不开这个包：(.+)$/))) return `Can't open this package: ${m[1]}`
  if ((m = v.match(/^没装上的：(.+)$/))) return `Not installed: ${m[1]}`

  /* --- 已有规则 --- */
  if ((m = v.match(/^开始安装 (.+)…$/))) return `Installing ${m[1]}…`
  if ((m = v.match(/^开始下载 (.+)…$/))) return `Downloading ${m[1]}…`
  if ((m = v.match(/^(.+) 安装完成$/))) return `${m[1]} installed`
  if ((m = v.match(/^(.+) 已更新（旧文件保留为 \.old）$/))) return `${m[1]} updated (old file kept as .old)`
  if ((m = v.match(/^发现 (.+) 个可更新模组$/))) return `${m[1]} mods can be updated`
  if ((m = v.match(/^发现新版本 (.+)$/))) return `Update available: ${m[1]}`
  if ((m = v.match(/^已看 (.+?) \/ 共 (\S+) 个$/))) return `Seen ${m[1]} of ${m[2]}`
  if ((m = v.match(/^已看 (.+)$/))) return `Seen ${m[1]}`
  if ((m = v.match(/^体检完成：扫描 (.+) 个 mod$/))) return `Check-up done: scanned ${m[1]} mods`
  if ((m = v.match(/^公网地址：(.+)$/))) return `Public address: ${m[1]}`
  if ((m = v.match(/^房间码无效：(.+)$/))) return `Invalid room code: ${m[1]}`
  if ((m = v.match(/^把 (\S+) 端口映射到公网$/))) return `Map port ${m[1]}`
  if ((m = v.match(/^当前实例：(.+)$/))) return `Current instance: ${m[1]}`
  if ((m = v.match(/^进服实例：(.+)$/))) return `Join with: ${m[1]}`
  if ((m = v.match(/^安装目标：(.+)$/))) return `Target: ${m[1]}`
  if ((m = v.match(/^搜索(.{1,8})…$/))) return `Search ${m[1]}…`
  if ((m = v.match(/^删掉版本 (.+) 的文件？$/))) return `Delete files of ${m[1]}?`
  if ((m = v.match(/^删掉 (.+)？$/))) return `Delete ${m[1]}?`
  if ((m = v.match(/^「(.+)」会连同游戏文件一起删除，确定？$/)))
    return `“${m[1]}” will be deleted with its game files. Continue?`
  if ((m = v.match(/^「(.+)」的存档会一起删掉，确定？$/)))
    return `Saves of “${m[1]}” will be deleted too. Continue?`
  if ((m = v.match(/^版本 (.+)$/))) return `Version ${m[1]}`
  if ((m = v.match(/^建议使用(镜像源|官方源)$/))) return `Recommended: ${m[1] === '镜像源' ? 'mirror' : 'official'}`
  if ((m = v.match(/^（本地 (.+) → 最新 (.+)）$/))) return `(local ${m[1]} → latest ${m[2]})`
  if ((m = v.match(/^启动版本切换为 (.+)$/))) return `Launch version switched to ${m[1]}`
  if ((m = v.match(/^实例 · (.+)$/))) return `Instance · ${m[1]}`
  if ((m = v.match(/^authlib-injector (已就绪|就绪)[： ]?(.*)$/))) return `authlib-injector ready ${m[2]}`
  if ((m = v.match(/^在线玩家：(.+)$/))) return `Players online: ${m[1]}`
  if ((m = v.match(/^已装模组（(.+)）$/))) return `Installed mods (${m[1]})`
  if ((m = v.match(/^已装(.{1,6})（(.+)）$/))) return `Installed ${m[1]} (${m[2]})`
  if ((m = v.match(/^(.+) 个实例，总时长 (.+)$/))) return `${m[1]} instances, playtime ${m[2]}`
  if ((m = v.match(/^共 (.+) 个实例$/))) return `${m[1]} instances`
  if ((m = v.match(/^最近启动：(.+)$/))) return `Last launch: ${m[1]}`
  if ((m = v.match(/^已安装 (.+) 个$/))) return `${m[1]} installed`
  if ((m = v.match(/^还剩 (.+)$/))) return `${m[1]} left`
  if ((m = v.match(/^(.+)\/(.+) 人$/))) return `${m[1]}/${m[2]} players`
  if ((m = v.match(/^TUNNEL (.+)$/))) return value

  /* --- 数量 / 单位 --- */
  if ((m = v.match(/^(.+)（(.+) 个模组）$/))) return `${m[1]} (${m[2]} mods)`
  if ((m = v.match(/^(.+) 个模组$/))) return `${m[1]} mods`
  if ((m = v.match(/^(.+) 个文件$/))) return `${m[1]} files`
  if ((m = v.match(/^(.+) 个存档$/))) return `${m[1]} worlds`
  if ((m = v.match(/^(.+) 条未读$/))) return `${m[1]} unread`
  if ((m = v.match(/^· (.+) 个进行中$/))) return `· ${m[1]} running`
  if ((m = v.match(/^已暂停 ·.*$/))) return `Paused · click Resume to continue`
  if ((m = v.match(/^…另外还有 (.+) 条$/))) return `…and ${m[1]} more`
  if ((m = v.match(/^，(.+) 个账号也一起找回来了$/))) return `, ${m[1]} accounts were recovered too`

  /* --- 已完成类 toast --- */
  if ((m = v.match(/^已保存到 (.+)$/))) return `Saved to ${m[1]}`
  if ((m = v.match(/^已导出整合包：(.+)$/))) return `Modpack exported: ${m[1]}`
  if ((m = v.match(/^已导出：(.+)$/))) return `Exported: ${m[1]}`
  if ((m = v.match(/^已导出到 (.+)$/))) return `Exported to ${m[1]}`
  if ((m = v.match(/^存到了 (.+)$/))) return `Saved to ${m[1]}`
  if ((m = v.match(/^已填入：(.+)$/))) return `Filled in: ${m[1]}`
  if ((m = v.match(/^快照已保存：(.+)$/))) return `Snapshot saved: ${m[1]}`
  if ((m = v.match(/^已安装：(.+)$/))) return `Installed: ${m[1]}`
  if ((m = v.match(/^已装好：(.+)$/))) return `Installed: ${m[1]}`
  if ((m = v.match(/^已安装 (.+)$/))) return `Installed ${m[1]}`
  if ((m = v.match(/^已复制为 (.+)$/))) return `Copied as ${m[1]}`
  if ((m = v.match(/^已删除 (.+)$/))) return `Deleted ${m[1]}`
  if ((m = v.match(/^已收藏 (.+)$/))) return `Favorited ${m[1]}`
  if ((m = v.match(/^已启用 (.+) 个资源包（按顺序叠加）$/))) return `Enabled ${m[1]} resource packs (stacked in order)`
  if ((m = v.match(/^已启用 (.+)$/))) return `Enabled ${m[1]}`
  if ((m = v.match(/^已切换到角色 (.+)$/))) return `Switched to character ${m[1]}`
  if ((m = v.match(/^已切到本机数据：(.+)$/))) return `Switched to local data: ${m[1]}`
  if ((m = v.match(/^已切到 (.+)$/))) return `Switched to ${m[1]}`
  if ((m = v.match(/^已切换到 (.+)$/))) return `Switched to ${m[1]}`
  if ((m = v.match(/^已识别验证服务器：(.+)$/))) return `Auth server detected: ${m[1]}`
  if ((m = v.match(/^已导入实例：(.+)$/))) return `Instance imported: ${m[1]}`
  if ((m = v.match(/^已导入 (.+) 项$/))) return `Imported ${m[1]} items`
  if ((m = v.match(/^已打包：(.+) 个文件 → (.+) MB（含 sha1 校验清单）$/)))
    return `Packed: ${m[1]} files → ${m[2]} MB (includes a sha1 manifest)`
  if ((m = v.match(/^已打包：(.+)$/))) return `Packed: ${m[1]}`
  if ((m = v.match(/^已备份 (.+) 个存档：(.+) 个文件（(.+)）$/))) return `Backed up ${m[1]} worlds: ${m[2]} files (${m[3]})`
  if ((m = v.match(/^已备份 (.+) 个存档（(.+) 个文件，(.+)）$/))) return `Backed up ${m[1]} worlds (${m[2]} files, ${m[3]})`
  if ((m = v.match(/^已恢复「(.+)」：(.+) 个文件 \/ (.+)$/))) return `Restored “${m[1]}”: ${m[2]} files / ${m[3]}`
  if ((m = v.match(/^已备份 (.+)$/))) return `Backed up ${m[1]}`
  if ((m = v.match(/^已恢复「(.+)」：(.+)$/))) return `Restored “${m[1]}”: ${m[2]}`
  if ((m = v.match(/^已回滚 (.+) 个文件（(.+)）$/))) return `Rolled back ${m[1]} files (${m[2]})`
  if ((m = v.match(/^已回滚 (.+)$/))) return `Rolled back ${m[1]}`
  if ((m = v.match(/^已套用「(.+)」：(.+)$/))) return `Applied “${m[1]}”: ${m[2]}`
  if ((m = v.match(/^已发送「(.+)」$/))) return `Sent “${m[1]}”`
  if ((m = v.match(/^已自动补齐 (.+) 个模组$/))) return `Auto-added ${m[1]} mods`
  if ((m = v.match(/^已清空 (.+?) 个账号.*$/))) return `Cleared ${m[1]} accounts (backup in accounts.json.bak)`
  if ((m = v.match(/^已清空 (.+?) 个实例的游玩记录$/))) return `Cleared playtime of ${m[1]} instances`
  if ((m = v.match(/^已清理 (.+) 个文件，空出 (.+)$/))) return `Cleaned ${m[1]} files, freed ${m[2]}`
  if ((m = v.match(/^清理了 (.+) 个临时文件，释放 (.+)$/))) return `Cleaned ${m[1]} temp files, freed ${m[2]}`
  if ((m = v.match(/^清理(.+)$/))) return `Clean ${verb(m[1])}`
  if ((m = v.match(/^接着用之前的数据了：(.+)$/))) return `Using your previous data: ${m[1]}`
  if ((m = v.match(/^保存 (.+) 项改动$/))) return `Save ${m[1]} changes`
  if ((m = v.match(/^(.+) 项没改：(.+)$/))) return `${m[1]} unchanged: ${m[2]}`
  if ((m = v.match(/^正版登录成功：(.+)$/))) return `Sign-in ok: ${m[1]}`

  /* --- 安装 / 更新 --- */
  if ((m = v.match(/^开始装 (.+)$/))) return `Installing ${m[1]}, see bottom right for progress`
  if ((m = v.match(/^装好了：(.+)$/))) return `Installed: ${m[1]}`
  if ((m = v.match(/^开始安装「(.+)」，进度看右下角$/))) return `Installing “${m[1]}”, see bottom right for progress`
  if ((m = v.match(/^正在拉 (.+) 版本…$/))) return `Fetching ${m[1]} versions…`
  if ((m = v.match(/^正在从 Modrinth 找 (.+)…$/))) return `Looking up ${m[1]} on Modrinth…`
  if ((m = v.match(/^没找到 (.+) 给 (.+) 用的版本$/))) return `No ${m[1]} build for ${m[2]}`
  if ((m = v.match(/^装了 (.+) 个$/))) return `Installed ${m[1]}`
  if ((m = v.match(/^已有 (.+) 个$/))) return `Already had ${m[1]}`
  if ((m = v.match(/^失败 (.+) 个$/))) return `Failed ${m[1]}`
  if ((m = v.match(/^补了 (.+) 个，(.+) 个没装上$/))) return `Added ${m[1]}, ${m[2]} failed`
  if ((m = v.match(/^补了 (.+) 个$/))) return `Added ${m[1]}`
  if ((m = v.match(/^已装 (.+) 个前置$/))) return `Installed ${m[1]} dependencies`
  if ((m = v.match(/^· 里面有 (.+) 个模组的中文$/))) return `· Contains Chinese for ${m[1]} mods`

  /* --- 存档 / 校验 --- */
  if ((m = v.match(/^校验通过：(.+) 个文件全部对上，可以放心恢复$/))) return `All ${m[1]} files verified, safe to restore`
  if ((m = v.match(/^校验没通过：(.+) 个文件有问题，第一个是 (.+)$/))) return `${m[1]} files failed verification, first is ${m[2]}`

  /* --- 联机 --- */
  if ((m = v.match(/^自动识别到游戏局域网端口 (.+)（已帮你填好）$/))) return `Detected LAN game port ${m[1]} (filled in)`
  if ((m = v.match(/^扫到 (.+) 个端口，点一个填进输入框$/))) return `Found ${m[1]} ports, click one to fill in`
  if ((m = v.match(/^扫到 (.+) 端口上的房间，已帮你填好$/))) return `Found a room on port ${m[1]}, filled in`
  if ((m = v.match(/^端口变了，模组清单已跟着换到 (.+)$/))) return `Port changed, mod list moved to ${m[1]}`
  if ((m = v.match(/^拷贝好了：(.+) 个文件，跳过 (.+)$/))) return `Copied ${m[1]} files, skipped ${m[2]}`
  if ((m = v.match(/^实例「(.+)」建好了$/))) return `Instance “${m[1]}” created`
  if ((m = v.match(/^没选实例，自动用「(.+)」进服$/))) return `No instance selected, joining with “${m[1]}”`
  if ((m = v.match(/^用实例「(.+)」进服.*$/))) return `Joining with instance “${m[1]}”`
  if ((m = v.match(/^还有 (.+) 个没下全.*$/))) return `${m[1]} still incomplete, retrying with a full transfer…`
  if ((m = v.match(/^等 (.+) 个$/))) return `Waiting for ${m[1]}`

  /* --- 零散提示 --- */
  if ((m = v.match(/^（还有 (.+) 条）$/))) return `(${m[1]} more)`
  if ((m = v.match(/^(.+) · 切到它$/))) return `${m[1]} · Switch to it`
  if ((m = v.match(/^新版本 (.+)$/))) return `New version ${m[1]}`
  if ((m = v.match(/^启动器 (.+)$/))) return `Launcher ${m[1]}`
  if ((m = v.match(/^备份将存到 (.+)$/))) return `Backups will be stored in ${m[1]}`
  if ((m = v.match(/^（本地保留最近 (.+) 份，更早的自动删）$/)))
    return `(keep the latest ${m[1]} locally, older ones are removed)`
  if ((m = v.match(/^已卸载 (.+)（挪到 \.trash 了，后悔还能捞回来）$/)))
    return `Uninstalled ${m[1]} (moved to .trash, you can still get it back)`
  if ((m = v.match(/^已归档（原日志 (.+)MB）$/))) return `Archived (original log ${m[1]} MB)`
  if ((m = v.match(/^没到阈值，当前 (.+)MB$/))) return `Below threshold, currently ${m[1]} MB`
  if ((m = v.match(/^· 缺 (.+) 个前置$/))) return `· missing ${m[1]} dependencies`
  if ((m = v.match(/^· (.+) 处循环依赖$/))) return `· ${m[1]} circular dependencies`
  if ((m = v.match(/^当前已保存（尾号 (.+)）$/))) return `Currently saved (ends with ${m[1]})`
  if ((m = v.match(/^开始安装整合包 (.+)…这会自动装对应版本与加载器$/)))
    return `Installing modpack ${m[1]}… the matching version and loader are installed too`

  /* --- 安装 / 加载器 --- */
  if ((m = v.match(/^没有找到 (.+) 给 (.+) 用的版本$/))) return `No ${m[1]} build for ${m[2]}`
  if ((m = v.match(/^切换到这个版本（(.+) 已装过）$/))) return `Switch to this version (${m[1]} already installed)`
  if ((m = v.match(/^给这个实例装 (.+)$/))) return `Install ${m[1]} for this instance`
  if ((m = v.match(/^装完会新建 (.+) 的 (.+) 实例$/))) return `A new ${m[1]} ${m[2]} instance will be created`

  /* --- 体检 --- */
  if ((m = v.match(/^体检结果：(.+) 条会让游戏崩或模组失效，建议先处理$/)))
    return `Check-up: ${m[1]} issues will crash the game or break mods, fix those first`
  if ((m = v.match(/^体检结果：(.+) 条可能让部分模组不好用（不影响启动）$/)))
    return `Check-up: ${m[1]} issues may break some mods (launching still works)`
  if ((m = v.match(/^体检结果：(.+) 条提示，没有要处理的$/))) return `Check-up: ${m[1]} notes, nothing to fix`

  /* --- 存档 / 联机清单 --- */
  if ((m = v.match(/^把 (.+)（(.+)）的存档目录整个打成一个 zip 快照？$/)))
    return `Zip the whole saves folder of ${m[1]} (${m[2]})?`
  if ((m = v.match(/^删掉 (.+)？存档和模组不受影响，只是界面\/贴图会回到原版。$/)))
    return `Delete ${m[1]}? Saves and mods are untouched, only the UI/textures go back to vanilla.`
  if ((m = v.match(/^诊断包已导出（路径和账号名已脱敏）：(.+)$/)))
    return `Diagnostic bundle exported (paths and account names redacted): ${m[1]}`
  if ((m = v.match(/^缺 (.+) 个、版本对不上 (.+) 个$/))) return `${m[1]} missing, ${m[2]} version mismatched`
  if ((m = v.match(/^要下载 (.+)（(.+) 个文件）$/))) return `Needs to download ${m[1]} (${m[2]} files)`
  if ((m = v.match(/^下了 (.+) 个（(.+)），有 (.+) 个失败：(.+) —— (.+)$/)))
    return `Downloaded ${m[1]} (${m[2]}), ${m[3]} failed: ${m[4]} — ${m[5]}`
  if ((m = v.match(/^补齐完成：(.+) 个文件（(.+)）$/))) return `Done: ${m[1]} files (${m[2]})`
  if ((m = v.match(/^补齐缺的（(.+) 个 · (.+)）$/))) return `Fill the gaps (${m[1]} · ${m[2]})`
  if ((m = v.match(/^拷好了：(.+) 个文件，跳过 (.+)$/))) return `Copied ${m[1]} files, skipped ${m[2]}`

  /* --- 多行确认框（值里真有换行，用 [\s\S] 跨行） --- */
  if ((m = v.match(/^要改「(.+)」的 (.+) 个字段。[\s\S]*$/)))
    return `Changing ${m[2]} fields of “${m[1]}”. A full snapshot of level.dat is taken first (into backups/levels/), and every field is read back to verify; if verification fails it restores automatically.`
  if ((m = v.match(/^实例「(.+)」的游戏文件不完整（上次下载大概中断了）。[\s\S]*$/)))
    return `The game files of “${m[1]}” are incomplete (the last download was probably interrupted). Continue downloading? Finished files are skipped, and the game only launches after it completes — mods are filled in afterwards.`
  if ((m = v.match(/^本地没有「(.+)」的实例。[\s\S]*$/)))
    return `No local instance for “${m[1]}”. Create one and join? The game files are prepared first — copied straight from the host if they have full transfer on, downloaded otherwise. It joins once that finishes.`
  if ((m = v.match(/^游戏实例和存档不会被动。[\s\S]*$/)))
    return `Game instances and saves are untouched. Your current config is backed up before restoring. Continue?`

  /* --- 分享卡 / 时长 --- */
  if ((m = v.match(/^这次玩了 (.+) 分钟$/))) return `Played ${m[1]} minutes this session`
  if ((m = v.match(/^玩了 (.+) 小时 (.+) 分$/))) return `Played ${m[1]} h ${m[2]} min`
  if ((m = v.match(/^玩了 (.+) 小时$/))) return `Played ${m[1]} hours`
  if ((m = v.match(/^玩了 (.+) 分钟$/))) return `Played ${m[1]} minutes`

  /* --- 时长 / 时间：放在最后兜底（带「玩了」的必须先命中，否则会剩半句中文） --- */
  if ((m = v.match(/^(.+) 小时 (.+) 分$/))) return `${m[1]} h ${m[2]} min`
  if ((m = v.match(/^(.+) 分 (.+) 秒$/))) return `${m[1]} min ${m[2]} s`
  if ((m = v.match(/^(.+) 分钟前$/))) return `${m[1]} minutes ago`
  if ((m = v.match(/^(.+) 小时前$/))) return `${m[1]} hours ago`
  if ((m = v.match(/^(.+) 天前$/))) return `${m[1]} days ago`
  if ((m = v.match(/^(.+) 秒$/))) return `${m[1]} s`
  if ((m = v.match(/^(.+) 分钟$/))) return `${m[1]} min`
  if ((m = v.match(/^(.+) 小时$/))) return `${m[1]} h`
  if ((m = v.match(/^(.+) 项$/))) return `${m[1]} items`

  /* --- 收尾零散（长句 / 片段） --- */
  if ((m = v.match(/^(.+) 人$/))) return `${m[1]} players`
  if ((m = v.match(/^(.+) 个$/))) return `${m[1]}`
  if ((m = v.match(/^· (.+) 个进行中（(.+) 个已暂停）$/))) return `· ${m[1]} running (${m[2]} paused)`
  if ((m = v.match(/^· (.+) 个进行中[\s\S]*$/))) return `· ${m[1]} running`
  if ((m = v.match(/^（(.+) 个已暂停）$/))) return `(${m[1]} paused)`
  if ((m = v.match(/^游戏本体没装完：(.+)$/))) return `The game isn't fully installed: ${m[1]}`
  if ((m = v.match(/^开始安装（(.+) 个）$/))) return `Installing (${m[1]} items)`
  if ((m = v.match(/^装完会新建 (.+) 的 (.+) 版本并自动切过去，[\s\S]*$/)))
    return `A ${m[1]} ${m[2]} version is created and switched to; existing saves and mods stay as they are.`
  if ((m = v.match(/^迁移完成：复制 (.+) 个文件（(.+)）$/))) return `Migration done: copied ${m[1]} files (${m[2]})`
  if ((m = v.match(/^旧目录 (.+) 里还有 (.+) 个实例、(.+) 个账号。$/)))
    return `The old folder ${m[1]} still has ${m[2]} instances and ${m[3]} accounts.`
  if ((m = v.match(/^要复制到新目录 (.+) 吗？[\s\S]*$/)))
    return `Copy them to the new folder ${m[1]}? Nothing is deleted from the old folder — clean it up yourself once the new one checks out.`
  if ((m = v.match(/^进不去：服务器是 (.+)，你选的实例是 (.+)。换一个同版本的实例再来。$/)))
    return `Can't join: the server runs ${m[1]}, your instance is ${m[2]}. Switch to an instance with the same version.`
  if ((m = v.match(/^进不去：服务器用 (.+)，你的实例是 (.+)。请用同加载器的实例。$/)))
    return `Can't join: the server uses ${m[1]}, your instance is ${m[2]}. Use an instance with the same loader.`
  if ((m = v.match(/^服务器要 (.+) 个模组（(.+)），自动从房主那补齐…$/)))
    return `Server needs ${m[1]} mods (${m[2]}), pulling them from the host…`
  if ((m = v.match(/^服务器要的模组里还有 (.+) 个没弄到（(.+)）。[\s\S]*$/)))
    return `Still missing ${m[1]} mods the server needs (${m[2]}). You would probably be kicked, or blocks/items won't render for you (lucky blocks, for instance). Ask the host to confirm “mod list sharing” is on in the Online page, then join again — or just try anyway.`
  if ((m = v.match(/^模组清单已开在 (.+) 端口：[\s\S]*$/)))
    return `Mod list service is on port ${m[1]}: friends joining with WFMC get their mods checked and filled in automatically (locally: http://127.0.0.1:${m[1]}/manifest.json)`
  if ((m = v.match(/^要下载 (.+)（(.+) 个文件）。[\s\S]*$/)))
    return `Needs to download ${m[1]} (${m[2]} files). Over 500 MB takes a while and eats disk — download now?`
  if ((m = v.match(/^(.+)；模组清单端口 (.+) 也已映射（[\s\S]*$/)))
    return `${m[1]}; mod list port ${m[2]} is mapped too (when the host runs WFMC's mod list, friends' mods are filled in automatically)`

  if ((m = v.match(/^WFMC (.+) · WanFan Minecraft Launcher · Electron \+ React \+ @xmcl 内核（MIT）$/)))
    return `WFMC ${m[1]} · WanFan Minecraft Launcher · Electron + React + @xmcl core (MIT)`

  return undefined
}
