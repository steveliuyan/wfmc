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
    const list = diff.missing
      .slice(0, 8)
      .map((m, i) => `${i + 1}. ${m.file}`)
      .join('\n')
    const more = diff.missing.length > 8 ? `\n…还有 ${diff.missing.length - 8} 个` : ''
    const ok = await askConfirm({
      title: '这个服需要额外模组',
      message: `服务器「${diff.manifest?.name ?? host}」有 ${diff.missing.length} 个你没有的模组，不装直接进会连不上或被踢。\n\n${list}${more}\n\n现在从服务器自动下载补齐（${(diff.missing.reduce((s, m) => s + m.size, 0) / 1024 / 1024).toFixed(1)} MB），补完直接进服？`,
      okText: '下载并进入',
      cancelText: '先不进'
    })
    if (!ok) return false

    const res = await api.serverSyncApply(instanceId, diff)
    if (res.failed.length > 0) {
      toast(`${res.added} 个补齐成功，${res.failed.length} 个失败（${res.failed[0]}…），先重试一次`, 'error')
      return false
    }
    toast(`已自动补齐 ${res.added} 个模组`, 'success')
  }

  if (diff.extra.length > 0) {
    toast(`注意：你有 ${diff.extra.length} 个服务器没装的模组，若进不去就先在「内容管理」里停用它们`, 'info')
  }

  await api.joinServer(instanceId, host, port)
  toast('环境已就绪，正在启动进服…', 'success')
  return true
}
