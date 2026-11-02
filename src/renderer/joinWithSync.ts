import { api } from './api'

interface Deps {
  instanceId: string
  host: string
  port: number
  toast: (msg: string, type?: 'info' | 'error' | 'success') => void
  askConfirm: (opts: {
    title?: string
    message: string
    okText?: string
    cancelText?: string
    danger?: boolean
  }) => Promise<boolean>
}

/**
 * 进服前先"体检"：
 * 1. 问一下服务端要什么版本 / 加载器 / mods（主机侧会开个清单服务）
 * 2. 版本或加载器不对 → 直接拦下来，别让玩家白等
 * 3. 缺 mod → 自动从主机下载补齐，补完再进服
 * 4. 连不上清单服务（老服务端/别人的服）→ 照常进，不挡人
 */
export async function joinWithSync({ instanceId, host, port, toast, askConfirm }: Deps): Promise<boolean> {
  let diff
  try {
    diff = await api.serverSyncCheck(instanceId, host, port)
  } catch {
    diff = undefined
  }

  if (!diff || !diff.reachable) {
    // 没有清单服务：正常进服（公共服务器大多是这种情况）
    await api.joinServer(instanceId, host, port)
    toast('正在启动并进服…', 'success')
    return true
  }

  if (diff.versionMismatch) {
    toast(
      `进不去：服务器是 ${diff.versionMismatch.server}，你选的实例是 ${diff.versionMismatch.client}。换一个同版本的实例再来。`,
      'error'
    )
    return false
  }

  if (diff.loaderMismatch) {
    toast(
      `进不去：服务器用 ${diff.loaderMismatch.server}，你的实例是 ${diff.loaderMismatch.client}。请用同加载器的实例。`,
      'error'
    )
    return false
  }

  if (diff.missing.length > 0) {
    // 用户要的就是「点进入 → 自动搞定」：缺模组是进不去的硬条件，
    // 所以不再弹窗问一遍（问了也只能点「好」），直接补，进度在右下角。
    const mb = (diff.missing.reduce((s, m) => s + m.size, 0) / 1024 / 1024).toFixed(1)
    toast(`服务器要 ${diff.missing.length} 个模组（${mb} MB），自动从房主那补齐…`, 'info')

    const res = await api.serverSyncApply(instanceId, diff)
    let added = res.added
    let still = res.stillMissing ?? res.failed

    if (still.length > 0) {
      // 一条条下模组在局域网里容易半截断掉（sha1 对不上，游戏就当没装 = 幸运方块丢不出来）。
      // 换个更笨但更稳的路子：把房主那份整包文件直接拷过来，再复查一次。
      toast(`还有 ${still.length} 个没下全，改用「整包直传」再试一次…`, 'info')
      try {
        const pack = await api.pullPackFromHost(instanceId, host, port)
        if (pack.ok) {
          const re = await api.serverSyncCheck(instanceId, host, port)
          if (re && re.reachable) {
            added += Math.max(0, still.length - re.missing.length)
            still = re.missing.map((m) => m.file)
          }
        }
      } catch {
        /* 整包直传也失败了：下面按 still 处理，不挡死 */
      }
    }

    if (still.length > 0) {
      const names = still.slice(0, 5).join('、')
      const more = still.length > 5 ? ` 等 ${still.length} 个` : ''
      // 不硬拦了：房主可能刚点共享、整包还没建好、或者玩家就是想先试试。
      // 把「为什么可能进不去」讲清楚，让他自己决定。
      const go = await askConfirm({
        title: '还有模组没到位',
        message: `服务器要的模组里还有 ${still.length} 个没弄到（${names}${more}）。\n\n现在进去大概率会被踢，或者方块/物品在你这儿显示不出来（比如幸运方块丢不出来）。\n\n建议先让房主在联机页确认「模组清单共享中」亮着，再点一次进入；想先试试也可以。`,
        okText: '仍然进入',
        cancelText: '先不进',
        danger: true
      })
      if (!go) return false
    } else {
      toast(`已自动补齐 ${added} 个模组`, 'success')
    }
  }

  if (diff.extra.length > 0) {
    toast(`注意：你有 ${diff.extra.length} 个服务器没装的模组，若进不去就先在「内容管理」里停用它们`, 'info')
  }

  await api.joinServer(instanceId, host, port)
  toast('环境已就绪，正在启动进服…', 'success')
  return true
}
