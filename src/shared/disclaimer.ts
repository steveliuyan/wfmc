/** 软件内展示的免责声明（设置页可随时查看，首启需确认一次） */
export const DISCLAIMER_VERSION = '2026-10'
export const DISCLAIMER_TITLE = '免责声明与使用须知'

export interface DisclaimerSection {
  heading: string
  body: string
}

export const DISCLAIMER_SECTIONS: DisclaimerSection[] = [
  {
    heading: '一、非官方软件',
    body:
      'WFMC（WanFan Minecraft Launcher）是万凡科技制作的第三方 Minecraft 启动器，与 Mojang Studios、Microsoft、Mojang AB 及其关联公司没有任何隶属、合作或授权关系。' +
      '「Minecraft」「我的世界」及相关商标、游戏素材、游戏文件的一切权利归其各自权利人所有。'
  },
  {
    heading: '二、游戏授权由你自负',
    body:
      '本软件只是下载、整理并启动游戏文件的工具，不提供、不出售、不代购任何游戏授权，也不绕过任何正版验证。' +
      '使用正版服务器或官方服务时，你需要自行拥有合法的 Minecraft 账号；离线模式仅适用于你自建或已获授权的服务器。' +
      '下载与使用游戏文件时请遵守 Minecraft 最终用户许可协议（EULA）及所在地区的法律法规。'
  },
  {
    heading: '三、账号与凭据',
    body:
      '离线账号仅保存在本机。微软正版与外置登录（Yggdrasil / authlib-injector，如 LittleSkin）的登录令牌使用 Windows DPAPI（Electron safeStorage）加密后存放于本机数据目录，不会上传到本软件作者的服务器。' +
      '令牌因系统级加密绑定本机，换机器或重装系统后需要重新登录。请自行保管账号密码，因账号泄露、共享或第三方皮肤站自身安全事件造成的损失由使用者承担。'
  },
  {
    heading: '四、本地数据与备份',
    body:
      '游戏实例、存档、模组、世界备份都存放在你本机的数据目录中，本软件不代管、不备份到云端（除非你自行配置了第三方备份服务）。' +
      '删除实例、清理临时文件、卸载软件等操作可能造成数据不可恢复，请在操作前自行备份重要存档。'
  },
  {
    heading: '五、联机、开机端口与网络',
    body:
      '「局域网联机」「P2P 直连（UPnP 端口映射）」「公网中继穿透（bore）」会修改路由器端口映射或经由第三方中继服务器转发流量，可能把你的游戏端口暴露到公网。' +
      '请仅在可信网络、且你拥有该网络与设备处置权的情况下使用；因开放端口、使用中继服务引发的安全问题、带宽费用、运营商条款争议由使用者自行承担。'
  },
  {
    heading: '六、第三方服务',
    body:
      '本软件依赖并调用多个第三方服务：Mojang 版本清单与 Java 运行时、BMCLAPI（国内镜像，bangbang93）、FabricMC、QuiltMC、Forge / NeoForged、Modrinth、CurseForge、PaperMC、bore.pub、LittleSkin 等。' +
      '这些服务由其各自运营方提供，可用性、内容合法性、速率限制与条款由其决定，本软件不对其中断、变更或数据准确性负责。'
  },
  {
    heading: '七、素材与开源致谢',
    body:
      '图标、动画与配色来自万凡科技品牌素材包（靛紫电光）；所用开源库（@xmcl 系列、Electron、React、lottie-web、skinview3d、bore 等）遵循其各自许可证。' +
      '同类启动器（XMCL、Daybreak、HMCL、PCL2、PrismLauncher、MultiMC 等）仅作为功能设计与规则思路的参考，未复制其代码。完整名单见「设置 → 致谢」。'
  },
  {
    heading: '八、「按现状」提供',
    body:
      '本软件按「现状」提供，不附带任何明示或暗示的担保，包括但不限于适销性、特定用途适用性与不侵权担保。' +
      '作者不对因使用或无法使用本软件而产生的任何直接或间接损失（包括存档损坏、数据丢失、账号封禁、设备故障、时间损失）承担责任。' +
      '在适用法律允许的最大范围内，使用本软件的风险由使用者自行承担。'
  },
  {
    heading: '九、条款变更',
    body:
      '本声明可能随版本更新调整，更新后会在软件内提示重新确认。' +
      '请勿移除软件中的本声明，再分发时需一并保留。若你不同意上述任一条款，请停止使用并删除本软件。'
  }
]
