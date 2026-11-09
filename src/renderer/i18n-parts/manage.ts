/**
 * manage 区域的补充对照表（自动扫描出来的漏翻文案，人工补翻的）。
 * 格式：[中文原文, English]，原文必须和源码里的字面量完全一致（运行时按 trim 后的整段匹配）。
 */
export const PAIRS: [string, string][] = [
  // tab 名
  ['模组', 'Mods'],
  ['依赖', 'Dependencies'],
  ['资源包', 'Resource Packs'],
  ['光影', 'Shaders'],
  ['存档', 'Saves'],
  ['存档工坊', 'Save Workshop'],
  ['数据包', 'Data Packs'],
  ['截图', 'Screenshots'],
  ['Mod 更新', 'Mod Updates'],
  ['崩溃报告', 'Crash Reports'],
  ['运行日志', 'Logs'],

  // 空状态 / 实例选择
  ['先在左侧选一个实例，或去新建一个。', 'Pick an instance on the left, or create a new one'],
  ['去实例页', 'Go to Instances'],
  ['看哪个实例的内容', 'Which instance to manage'],
  ['直接在这切，不用回首页。下面的模组 / 存档 / 日志都跟着这个实例走。', 'Switch right here without going back to Home. Mods / saves / logs below follow this instance'],
  ['原版（vanilla）', 'Vanilla'],

  // 汉化包
  ['已装汉化包：', 'Installed language packs:'],
  ['收起明细', 'Hide details'],
  ['看是哪些', 'See which ones'],
  ['下面这些模组的界面已经是中文：', 'These mods already have Chinese interfaces:'],
  [
    '汉化包里没有它们的语言文件，界面还是英文——这类只能等汉化组收录，或者去找作者自己发布的中文语言文件塞进 jar：',
    'The pack has no language files for these, so they stay in English — wait for the translation team to include them, or put a Chinese language file published by the author into the jar:'
  ],
  [
    '另外：模组里直接写死的文字（比如标题栏那种）资源包也翻不了，那是作者代码里的字符串。',
    'Note: text hardcoded inside mods (such as window titles) cannot be translated by resource packs, since those are strings in the author code'
  ],
  [
    '还没装汉化包。装模组后界面是英文的话，点上面的「装中文汉化包」。',
    'No language pack installed yet. If mods show English, click Install Chinese Language Pack above'
  ],
  ['看看翻了哪些模组', 'See which mods are translated'],
  ['卸载汉化包', 'Uninstall language packs'],
  ['卸载', 'Uninstall'],
  ['删之前会自动清掉 options.txt 里的引用，不留悬空条目', 'References in options.txt are cleared before deletion, leaving no dangling entries'],
  ['已停用（文件改成 .disabled，需要时再点一次恢复）', 'Disabled (file renamed to .disabled, click again to restore)'],
  [
    '模组的中文是作者写在 jar 里的，没写就是英文。装这个汉化资源包后模组界面会变中文（VM 汉化组维护，覆盖 1.12 ~ 最新版）',
    'Mod Chinese text is written by its author inside the jar; without it the UI stays English. Install this language pack to turn mod interfaces Chinese (maintained by the VM translation team, covers 1.12 through latest)'
  ],
  ['正在装汉化包，进度看右下角', 'Installing language pack, see progress at bottom right'],
  ['装中文汉化包', 'Install Chinese language pack'],

  // 资源包顺序
  ['读取启用顺序', 'Load enabled order'],
  ['顺序即叠加顺序：上面的覆盖下面的（写进 options.txt）', 'Order is stacking order: items above override those below (written to options.txt)'],
  ['上移', 'Move up'],
  ['下移', 'Move down'],
  ['停用', 'Disable'],

  // 体检
  ['重新体检', 'Re-check'],
  ['体检模组（重复 / 加载器 / 前置）', 'Check mods (duplicates / loader / dependencies)'],
  [
    '开着的时候会一直盯着 mods 目录，装/删模组后自动重扫；只读 jar 里的元数据，离线可跑',
    'Watches the mods folder while open and rescans after installs or removals; reads only jar metadata and works offline'
  ],
  ['✕ 忽略', '✕ Dismiss'],
  ['错误', 'Error'],
  ['警告', 'Warning'],
  ['提示', 'Info'],
  ['收起说明', 'Hide explanation'],
  ['这是什么？', 'What is this?'],
  ['自动从 Modrinth 找同名项目，连带它自己的前置一起装', 'Finds the same-name project on Modrinth and installs its own dependencies too'],
  ['启用这个前置', 'Enable this dependency'],
  ['文件已经在本机，只是名字带 .disabled，改回来就行，不用重新下载', 'The file is already on disk, only named with .disabled; rename it back, no re-download needed'],
  ['装完自动切过去，存档 / mods 都不动', 'Switches over automatically after install, saves / mods stay untouched'],

  // 模组快照
  ['模组快照', 'Mod snapshots'],
  [
    '「Mod 更新」每次替换旧 jar 前会自动存一份；手动备份会把整个 mods 目录打包（大整合包可能要等十几秒）。回滚前也会先把当前状态备份一次。',
    'Mod Updates saves a copy before each jar swap; manual backup packs the whole mods folder (big modpacks may take a while). Current state is backed up before a rollback too'
  ],
  ['正在备份整个 mods 目录…', 'Backing up the whole mods folder…'],
  ['mods 目录是空的，没什么可备份', 'The mods folder is empty, nothing to back up'],
  ['备份当前 mods', 'Back up current mods'],
  ['刷新', 'Refresh'],
  ['还没有快照。更新模组时会自动生成，或者点「备份当前 mods」。', 'No snapshots yet. One is created automatically when updating mods, or click Back up current mods'],
  ['更新前备份', 'Pre-update backup'],
  ['回滚模组', 'Roll back mods'],
  ['把 mods 目录回滚到这份快照？回滚前会先自动备份当前 mods，后悔了还能退回来。', 'Roll the mods folder back to this snapshot? Current mods are backed up first, so you can undo it'],
  ['回滚', 'Roll back'],
  ['正在回滚…', 'Rolling back…'],

  // 内容操作
  ['导入本地文件', 'Import local files'],
  ['打开文件夹', 'Open folder'],
  ['这个目录还是空的。可以点上面的「导入本地文件」。', 'This folder is empty. Click Import local files above'],
  ['已禁用', 'Disabled'],
  ['目录', 'Folder'],
  ['打包', 'Package'],
  ['内容', 'Contents'],
  ['启用', 'Enable'],
  ['禁用', 'Disable'],
  ['删除文件', 'Delete file'],
  ['删除', 'Delete'],

  // 存档 / 备份
  ['导入存档包', 'Import save archive'],
  ['这个 zip 里没有 WFMC 校验清单，只能当普通压缩包恢复', 'This zip has no WFMC manifest, so it can only be restored as a plain archive'],
  ['校验存档包', 'Verify save archive'],
  ['备份所有存档', 'Back up all saves'],
  ['开始备份', 'Start backup'],
  ['存档目录是空的，没什么可备份', 'The saves folder is empty, nothing to back up'],
  ['已存在同名存档，新的这份自动改了名', 'A save with the same name exists, so this one was renamed automatically'],
  ['存档快照', 'Save snapshots'],
  [
    '启动游戏前自动打一份，最多留 12 份；回滚时会先把当前存档再备份一次，不会把新世界弄丢。',
    'A copy is made before each launch, up to 12 kept; a rollback backs up current saves first, so new worlds are not lost'
  ],
  ['立即备份', 'Back up now'],
  ['打开备份文件夹', 'Open backup folder'],
  ['打开备份所在文件夹', 'Open backup folder'],
  ['收起', 'Collapse'],
  ['还没有快照。启动一次游戏就会自动生成，或者点「立即备份」。', 'No snapshots yet. One is created on the next launch, or click Back up now'],
  ['回滚存档', 'Roll back saves'],
  ['把存档回滚到这份快照？回滚前会先自动备份当前存档。', 'Roll saves back to this snapshot? Current saves are backed up first'],
  ['回滚前的存档也留了一份，后悔了还能退回来', 'The saves from before the rollback were kept too, so you can undo it'],

  // 数据包
  ['选择存档…', 'Choose a save…'],
  ['刷新存档列表', 'Refresh save list'],
  ['导入数据包', 'Import data pack'],
  ['先选一个存档（数据包是存档级的）。', 'Choose a save first (data packs are per save)'],
  ['这个存档还没有数据包。', 'This save has no data packs yet'],
  ['已停用', 'Disabled'],

  // 截图
  ['打开截图目录', 'Open screenshots folder'],
  ['做分享卡', 'Make share card'],
  ['还没有截图。', 'No screenshots yet'],
  ['打开', 'Open'],
  ['分享卡', 'Share card'],

  // Mod 更新
  ['按文件指纹比对中…', 'Comparing file fingerprints…'],
  ['检查 Mod 更新', 'Check mod updates'],
  ['用 mods 里每个 jar 的 SHA1 去 Modrinth 反查最新版本，不靠猜文件名。', 'Looks up the latest version on Modrinth by each jar SHA1 instead of guessing from filenames'],
  ['有新版本', 'New version'],
  ['已是最新', 'Up to date'],
  ['更新', 'Update'],

  // 崩溃报告 / 日志
  ['没找到崩溃报告或日志', 'No crash report or log found'],
  ['一键诊断崩溃原因', 'Diagnose crash cause'],
  [
    '没命中已知问题，往下看原始内容，或去「运行日志」翻更早的记录。',
    'No known issue matched. Scroll down for the raw content, or check Logs for earlier entries'
  ],
  ['查看报告开头', 'View report header'],
  ['没有崩溃报告，挺稳。', 'No crash reports, looking stable'],
  ['查看', 'View'],
  ['崩溃报告内容', 'Crash report content'],
  ['导出', 'Export'],
  ['导出日志', 'Export log'],
  ['清空', 'Clear'],
  ['正在打包日志 / 崩溃报告 / 体检结果 / 系统信息…', 'Packing logs / crash reports / health check / system info…'],
  ['导出诊断包（日志+崩溃+体检+系统信息）', 'Export diagnostics (logs + crashes + health check + system info)'],
  ['还没有日志，去首页启动一次游戏。', 'No logs yet. Launch the game once from Home'],

  // 包内容弹窗
  ['关闭', 'Close'],
  ['这个包里的其它文件（最多列 60 条）：', 'Other files in this pack (up to 60 listed):'],
  ['删除资源包', 'Delete resource pack'],
  ['删除这个包', 'Delete this pack'],
  ['删之前会先从 options.txt 的启用列表里摘掉，不留悬空条目', 'Removed from the enabled list in options.txt first, leaving no dangling entries'],
  ['· 没检测到中文语言文件（不是汉化包，或者是纯贴图/音效的资源包）', '· No Chinese language files detected (not a language pack, or a texture/audio-only resource pack)'],

  // 补漏（自动扫描剩下的静态字面量）
  ['· 原版', '· Vanilla'],
  ['，全都有中文了', ', all translated'],
  ['，options.txt 里的引用也清了', ', references in options.txt cleared'],
  ['Modrinth 上没找到对应项目', 'No matching project found on Modrinth'],
  ['已备份：', 'Backed up: '],
  ['备份失败：', 'Backup failed: '],
  ['回滚失败：', 'Roll back failed: '],

  // 云端存档备份（/v1/saves/*）
  ['这份已经同步到云端', 'Synced to cloud'],
  ['上传失败：', 'Upload failed: '],
  ['传这份到云端', 'Upload this one'],
  ['已用 ${formatSize(cloudUsage.usedBytes)} / ${formatSize(cloudUsage.quotaBytes)}，共 ${cloudUsage.count} 份 · 每个实例云端最多留 ${cloudLimits?.savesKeep ?? 10} 份', 'Used ${formatSize(cloudUsage.usedBytes)} / ${formatSize(cloudUsage.quotaBytes)}, ${cloudUsage.count} save(s) · up to ${cloudLimits?.savesKeep ?? 10} per instance'],
  ['读云端清单中…', 'Reading cloud list…'],
  ['打一份新的传上云', 'Back up now and upload'],
  ['未知版本', 'Unknown version'],
  ['从云端回滚', 'Restore from cloud'],
  ['把这份云端存档下载下来并覆盖本地存档？下载后会先校验，回滚前也会先本地备份一份。', 'Download this cloud save and overwrite local saves? It is verified after download, and local saves are backed up first.'],
  ['下载并回滚', 'Download and restore'],
  ['回滚前的存档也留了一份', 'A backup of your saves before restoring was kept'],
  ['删除云端存档', 'Delete cloud save'],
  ['从云端删掉这份存档？本地的那份不受影响。', 'Delete this save from the cloud? The local copy is untouched.'],
  ['已从云端删掉', 'Deleted from cloud'],
  ['删除失败：', 'Delete failed: ']
]
