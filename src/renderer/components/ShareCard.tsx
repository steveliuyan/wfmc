import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useLauncher } from '../store'
import type { Instance } from '../../shared/types'

/**
 * 分享卡：canvas 画一张 1080×1440 的竖图，底部固定品牌条。
 * 图从主进程拿 data URL（渲染层直接用 file:// 画进 canvas 会把 canvas 污染，
 * 之后 toDataURL 会抛 SecurityError），所以背景图一律走 api.shareReadImage。
 */

const CARD_W = 1080
const CARD_H = 1440

function fmtPlayTime(ms?: number): string {
  if (!ms || ms < 60_000) return '刚开始玩'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `玩了 ${min} 分钟`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `玩了 ${h} 小时 ${m} 分` : `玩了 ${h} 小时`
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这张图读不出来'))
    img.src = src
  })
}

/** 等比铺满（cover）后居中裁切 */
function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  const scale = Math.max(CARD_W / img.width, CARD_H / img.height)
  const w = img.width * scale
  const h = img.height * scale
  ctx.drawImage(img, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h)
}

/** 字太长就缩字号，直到塞得下 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, start: number, weight = '800') {
  let size = start
  do {
    ctx.font = `${weight} ${size}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`
    if (ctx.measureText(text).width <= maxW) break
    size -= 4
  } while (size > 36)
  return size
}

interface Props {
  instance: Instance
  /** 指定用哪张截图；不给就用这个实例最新的一张，没有就纯色渐变底 */
  shotPath?: string
  /** 这一次玩了多久（首页「本次游玩总结」用），不给就不画这一行 */
  sessionMs?: number
  /** 首页自动弹的那种卡片，给一个「以后不自动弹」的出口 */
  onMute?: () => void
  onClose: () => void
}

export default function ShareCard({ instance, shotPath, sessionMs, onMute, onClose }: Props) {
  const { toast } = useLauncher()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [bgData, setBgData] = useState<string | undefined>()
  const [modCount, setModCount] = useState(0)
  const [drawing, setDrawing] = useState(true)
  const [saving, setSaving] = useState(false)

  // 背景图 + 模组数
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        if (shotPath) {
          const dataUrl = await api.shareReadImage(shotPath)
          if (alive) setBgData(dataUrl)
        } else {
          const latest = await api.shareLatestShot(instance.id)
          if (alive && latest) setBgData(latest.dataUrl)
        }
      } catch {
        /* 没图就用渐变底，不算错 */
      }
      try {
        const mods = await api.listContent(instance.id, 'mods')
        if (alive) setModCount(mods.length)
      } catch {
        if (alive) setModCount(0)
      }
    })()
    return () => {
      alive = false
    }
  }, [instance.id, shotPath])

  // 画卡片
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let alive = true
    ;(async () => {
      setDrawing(true)
      ctx.clearRect(0, 0, CARD_W, CARD_H)

      // 底：深色渐变
      const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H)
      bg.addColorStop(0, '#0d1b2a')
      bg.addColorStop(0.55, '#132b3f')
      bg.addColorStop(1, '#0a1520')
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, CARD_W, CARD_H)

      if (bgData) {
        try {
          const img = await loadImage(bgData)
          if (alive) drawCover(ctx, img)
        } catch {
          /* 图坏了就留着渐变底 */
        }
      }

      // 上下的暗角，保证文字压得住图
      const top = ctx.createLinearGradient(0, 0, 0, 460)
      top.addColorStop(0, 'rgba(4,10,16,0.86)')
      top.addColorStop(1, 'rgba(4,10,16,0)')
      ctx.fillStyle = top
      ctx.fillRect(0, 0, CARD_W, 460)
      const bottom = ctx.createLinearGradient(0, CARD_H - 620, 0, CARD_H)
      bottom.addColorStop(0, 'rgba(4,10,16,0)')
      bottom.addColorStop(0.55, 'rgba(4,10,16,0.78)')
      bottom.addColorStop(1, 'rgba(4,10,16,0.94)')
      ctx.fillStyle = bottom
      ctx.fillRect(0, CARD_H - 620, CARD_W, 620)

      // 顶部品牌
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.font = '600 34px "Microsoft YaHei", system-ui, sans-serif'
      ctx.fillText('WFMC 启动器', 72, 108)

      // 实例名
      ctx.fillStyle = '#ffffff'
      const nameSize = fitText(ctx, instance.name, CARD_W - 144, 92)
      ctx.font = `800 ${nameSize}px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`
      ctx.shadowColor = 'rgba(0,0,0,0.55)'
      ctx.shadowBlur = 24
      ctx.fillText(instance.name, 72, CARD_H - 420)
      ctx.shadowBlur = 0

      // 版本 / 加载器 / 模组数
      const loaderName = instance.loader
        ? instance.loader[0].toUpperCase() + instance.loader.slice(1)
        : '原版'
      const meta = [`Minecraft ${instance.mcVersion}`, loaderName, `${modCount} 个模组`].join('  ·  ')
      ctx.fillStyle = 'rgba(255,255,255,0.86)'
      ctx.font = '500 40px "Microsoft YaHei", system-ui, sans-serif'
      ctx.fillText(meta, 72, CARD_H - 348)

      // 游玩时长
      ctx.fillStyle = 'rgba(140, 220, 255, 0.96)'
      ctx.font = '600 38px "Microsoft YaHei", system-ui, sans-serif'
      ctx.fillText(fmtPlayTime(instance.playTimeMs), 72, CARD_H - 280)

      if (sessionMs && sessionMs > 60_000) {
        ctx.fillStyle = 'rgba(255,255,255,0.82)'
        ctx.font = '500 32px "Microsoft YaHei", system-ui, sans-serif'
        ctx.fillText(`这次玩了 ${Math.round(sessionMs / 60_000)} 分钟`, 72, CARD_H - 226)
      }

      // 底部品牌条
      ctx.fillStyle = 'rgba(255,255,255,0.14)'
      ctx.fillRect(0, CARD_H - 132, CARD_W, 132)
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.font = '600 34px "Microsoft YaHei", system-ui, sans-serif'
      ctx.fillText('WFMC 启动器 · 一起开黑', 72, CARD_H - 62)
      const d = new Date()
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      ctx.fillStyle = 'rgba(255,255,255,0.62)'
      ctx.font = '500 30px "Microsoft YaHei", system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(stamp, CARD_W - 72, CARD_H - 62)
      ctx.textAlign = 'left'

      if (alive) setDrawing(false)
    })()
    return () => {
      alive = false
    }
  }, [instance, bgData, modCount, sessionMs])

  const toPng = (): string => {
    const canvas = canvasRef.current
    if (!canvas) throw new Error('画布还没准备好')
    return canvas.toDataURL('image/png')
  }

  const save = async () => {
    setSaving(true)
    try {
      const file = await api.shareSavePng(instance.id, toPng())
      toast('分享卡已经存到截图目录了', 'success')
      await api.revealBackup(file).catch(() => undefined)
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const copy = async () => {
    try {
      await api.shareCopyImage(toPng())
      toast('图片已经复制，直接粘到聊天窗就行', 'success')
    } catch (e) {
      toast(`复制失败：${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className="dialog-mask" onClick={onClose}>
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontWeight: 700 }}>分享卡</div>
            <div className="muted small">
              {bgData ? '用的这张截图当底图' : '这个实例还没有截图，用的纯色底'}
            </div>
          </div>
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.25)',
            borderRadius: 12,
            padding: 10
          }}
        >
          <canvas
            ref={canvasRef}
            width={CARD_W}
            height={CARD_H}
            style={{ width: '100%', maxWidth: 420, height: 'auto', borderRadius: 8, display: 'block' }}
          />
        </div>

        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          {onMute && (
            <button className="btn" onClick={onMute} style={{ marginRight: 'auto' }}>
              以后不自动弹
            </button>
          )}
          <button className="btn" onClick={save} disabled={drawing || saving}>
            {saving ? '保存中…' : '保存到截图目录'}
          </button>
          <button className="btn" onClick={copy} disabled={drawing}>
            复制图片
          </button>
        </div>
        <div className="muted small">
          1080×1440，直接发群里/贴吧都清楚。想知道好友缺什么模组，去「联机」页生成清单码更快。
        </div>
      </div>
    </div>
  )
}
