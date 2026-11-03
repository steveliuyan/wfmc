/**
 * 颜色工具：sRGB ↔ 线性 ↔ XYZ ↔ CIELAB。
 *
 * 为什么用 LAB 而不是直接插值 hex：sRGB 里两个颜色「平均」经常发灰发脏，
 * LAB 的 L 轴才是感知亮度，按 L 调深浅、按 a/b 调色相饱和度，出图更接近人眼预期
 * （PCL 的 ToneProfile 也是同一思路：从主色派生一整套色调，而不是只换一个色号）。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

export interface Lab {
  L: number
  a: number
  b: number
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** #rgb / #rrggbb / #rrggbbaa → {r,g,b}（非法输入回落到灰色，避免整页样式崩掉） */
export function hexToRgb(hex: string): Rgb {
  let s = (hex || '').trim().replace(/^#/, '')
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2]
  if (s.length === 8) s = s.slice(0, 6)
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return { r: 128, g: 128, b: 128 }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16)
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const h = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

const srgbToLinear = (c: number) => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}

const linearToSrgb = (v: number) => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
  return clamp(c * 255, 0, 255)
}

// D65 白点
const Xn = 0.95047
const Yn = 1
const Zn = 1.08883

const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
const finv = (t: number) => {
  const t3 = t * t * t
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787
}

export function rgbToLab(rgb: Rgb): Lab {
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)

  const x = 0.4124564 * r + 0.3575761 * g + 0.1804375 * b
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = 0.0193339 * r + 0.119192 * g + 0.9503041 * b

  const fx = f(x / Xn)
  const fy = f(y / Yn)
  const fz = f(z / Zn)

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** LAB → sRGB，超出色域的分量按线性裁剪（够用，不做色域映射） */
export function labToRgb(lab: Lab): Rgb {
  const fy = (lab.L + 16) / 116
  const fx = fy + lab.a / 500
  const fz = fy - lab.b / 200

  const x = Xn * finv(fx)
  const y = Yn * finv(fy)
  const z = Zn * finv(fz)

  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z

  return { r: linearToSrgb(r), g: linearToSrgb(g), b: linearToSrgb(b) }
}

/** 在 LAB 空间插值：t=0 得 a，t=1 得 b */
export function mixLab(a: string, b: string, t: number): string {
  const la = rgbToLab(hexToRgb(a))
  const lb = rgbToLab(hexToRgb(b))
  const k = clamp(t, 0, 1)
  return rgbToHex(
    labToRgb({
      L: la.L + (lb.L - la.L) * k,
      a: la.a + (lb.a - la.a) * k,
      b: la.b + (lb.b - la.b) * k
    })
  )
}

/** 只动感知亮度（dL 正数变亮、负数变暗），色相饱和度尽量保持不变 */
export function shiftL(hex: string, dL: number): string {
  const lab = rgbToLab(hexToRgb(hex))
  return rgbToHex(labToRgb({ L: clamp(lab.L + dL, 0, 100), a: lab.a, b: lab.b }))
}

/** 缩放彩度（0 = 灰度，>1 更艳），用来做低饱和的背景色块 */
export function scaleChroma(hex: string, k: number): string {
  const lab = rgbToLab(hexToRgb(hex))
  return rgbToHex(labToRgb({ L: lab.L, a: lab.a * k, b: lab.b * k }))
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex)
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${clamp(alpha, 0, 1)})`
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

/** 这张色块上应该压深色字还是浅色字（WCAG 对比度择优） */
export function readableInk(bg: string, dark = '#0f1117', light = '#ffffff'): string {
  const l = relativeLuminance(bg)
  const contrastDark = (l + 0.05) / (relativeLuminance(dark) + 0.05)
  const contrastLight = (relativeLuminance(light) + 0.05) / (l + 0.05)
  return contrastDark >= contrastLight ? dark : light
}

export interface AccentPalette {
  /** 主色本身（浅色模式压暗、深色模式提亮，保证在底色上看得清） */
  accent: string
  /** 渐变里的第二个色（更亮一点） */
  accent2: string
  /** 浅底/悬浮块用的半透明主色 */
  soft: string
  /** 焦点环 */
  ring: string
  /** 主色块上的文字色 */
  ink: string
  /** 光晕阴影 */
  glow: string
}

/**
 * 从一个主色派生整套主色系。
 * light 模式：把 L 压到 32-54，否则白底上太飘、按钮看不清；
 * dark 模式：把 L 抬到 58-74，否则黑底上糊成一片。
 * 彩度太低（挑了灰）时补一点，避免主色看着像「禁用态」。
 */
export function deriveAccent(accent: string, mode: 'light' | 'dark'): AccentPalette {
  const lab = rgbToLab(hexToRgb(accent))
  const chroma = Math.hypot(lab.a, lab.b)
  // 彩度极低（灰、黑白）就别硬造色相：同乘一个系数也变不出颜色，原样保留即可
  const scale = chroma < 10 ? 1 : clamp(18 / chroma, 1, 1.6)

  const L = mode === 'dark' ? clamp(lab.L, 58, 74) : clamp(lab.L, 32, 54)
  const base = rgbToHex(labToRgb({ L, a: lab.a * scale, b: lab.b * scale }))
  const lighter = rgbToHex(
    labToRgb({
      L: clamp(L + (mode === 'dark' ? 9 : 11), 0, 96),
      a: lab.a * scale,
      b: lab.b * scale
    })
  )

  return {
    accent: base,
    accent2: lighter,
    soft: withAlpha(base, mode === 'dark' ? 0.2 : 0.13),
    ring: withAlpha(base, mode === 'dark' ? 0.34 : 0.26),
    ink: readableInk(base),
    glow: withAlpha(base, mode === 'dark' ? 0.34 : 0.22)
  }
}

/** 主色系 → 直接喂给 document.documentElement.style.setProperty 的键值对 */
export function accentVars(p: AccentPalette): Record<string, string> {
  return {
    '--accent': p.accent,
    '--accent-2': p.accent2,
    '--accent-soft': p.soft,
    '--accent-ring': p.ring,
    '--accent-ink': p.ink,
    '--accent-glow': p.glow
  }
}

export const ACCENT_KEYS = ['--accent', '--accent-2', '--accent-soft', '--accent-ring', '--accent-ink', '--accent-glow']
