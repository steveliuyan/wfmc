/**
 * 自适应模糊：壁纸模糊（backdrop/filter blur）在核显 + 4K 屏上很吃 GPU，
 * 一刀切 18px 会让侧栏滚动都掉帧。
 *
 * 做法同 PCL 的 AdaptiveBlur：先按「够用」给一个较高档，跑一小段自检帧，
 * 帧时间（不是帧率估个大概，而是 p90 帧时间）不达标就逐档往下退，
 * 直到流畅为止；窗口失焦/后台时再降一档，回来复测一次。
 * 结果写进 CSS 变量 --wall-blur，CSS 只负责用。
 */

export type BlurTier = 'high' | 'mid' | 'low' | 'off'

const STEPS: { tier: BlurTier; px: number }[] = [
  { tier: 'high', px: 18 },
  { tier: 'mid', px: 10 },
  { tier: 'low', px: 4 },
  { tier: 'off', px: 0 }
]

/** p90 帧时间超过这个值就算不流畅（16.7ms ≈ 60fps，24ms ≈ 40fps） */
const FRAME_BUDGET_MS = 24

function measureFrameTimes(frames = 90): Promise<number[]> {
  return new Promise((resolve) => {
    const out: number[] = []
    let last = 0
    let n = 0
    let raf = 0
    const tick = (t: number) => {
      if (last > 0) out.push(t - last)
      last = t
      if (++n >= frames) {
        cancelAnimationFrame(raf)
        resolve(out)
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
  })
}

function p90(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))
  return sorted[i]
}

export interface AdaptiveBlurHandle {
  /** 立刻重新测一遍（切壁纸、窗口回来时用） */
  remeasure: () => void
  dispose: () => void
}

/**
 * @param onChange 档位变化时回调（调用方负责把 px 写进 CSS 变量）
 * @param enabled false 时不测帧（没开壁纸就别白烧 CPU）
 */
export function startAdaptiveBlur(
  onChange: (tier: BlurTier, px: number) => void,
  enabled = true
): AdaptiveBlurHandle {
  let disposed = false
  let busy = false
  let current: BlurTier = 'high'
  /** 用户切到别的窗口时先压一档，回来复测 */
  let backgrounded = false

  const set = (tier: BlurTier) => {
    current = tier
    const step = STEPS.find((s) => s.tier === tier) ?? STEPS[0]
    onChange(step.tier, step.px)
  }

  const run = async () => {
    if (!enabled || busy || disposed) return
    busy = true
    try {
      // 先摆高档，让自检在真实负载下跑（否则测出来永远是满帧）
      set('high')
      const times = await measureFrameTimes()
      if (disposed) return
      const worst = p90(times)
      if (worst > FRAME_BUDGET_MS * 1.6) set('off')
      else if (worst > FRAME_BUDGET_MS) set('mid')
      else set('high')
      if (backgrounded && current === 'high') set('mid')
    } finally {
      busy = false
    }
  }

  const onVisibility = () => {
    backgrounded = document.visibilityState === 'hidden' || !document.hasFocus()
    if (backgrounded) {
      if (current === 'high') set('mid')
    } else {
      void run()
    }
  }

  window.addEventListener('focus', onVisibility)
  window.addEventListener('blur', onVisibility)

  // 首帧布局稳定后再测，避免把「首屏渲染」算成掉帧
  const timer = window.setTimeout(() => void run(), 900)

  return {
    remeasure: () => void run(),
    dispose: () => {
      disposed = true
      busy = true
      window.clearTimeout(timer)
      window.removeEventListener('focus', onVisibility)
      window.removeEventListener('blur', onVisibility)
    }
  }
}
