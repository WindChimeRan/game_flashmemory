/**
 * theme — palette & glyph styling for the OOM screen (game layer).
 *
 * Glyph badges are ASCII letters + a per-glyph color from a colorblind-safe
 * categorical palette (Paul Tol light/bright derived, 12 entries — ≥ 10
 * distinguishable); the letter itself is the redundant code (§4.7, never
 * emoji). Heat renders as a fg brightness lerp (dim → hot) applied to the
 * chunk's badge + header. Colors are packed truecolor; the term renderer
 * downconverts to 256 automatically when the terminal lacks truecolor.
 */

import { rgb, type Color } from '../term'

/** Colorblind-safe categorical palette (Tol light + muted picks), 12 ≥ 10. */
export const GLYPH_PALETTE: readonly Color[] = [
  rgb(0x77, 0xaa, 0xdd), // pale blue
  rgb(0xee, 0x88, 0x66), // orange
  rgb(0xee, 0xdd, 0x88), // light yellow
  rgb(0xff, 0xaa, 0xbb), // pink
  rgb(0x99, 0xdd, 0xff), // light cyan
  rgb(0x44, 0xbb, 0x99), // mint
  rgb(0xbb, 0xcc, 0x33), // pear
  rgb(0xcc, 0x66, 0x77), // rose
  rgb(0xdd, 0xdd, 0xdd), // pale grey
  rgb(0xaa, 0x44, 0x99), // purple
  rgb(0x44, 0x77, 0xaa), // blue
  rgb(0xdd, 0xcc, 0x77), // sand
]

/** Stable letter → palette mapping (same glyph = same color, any config). */
export function glyphColor(glyph: string): Color {
  const code = glyph.length > 0 ? glyph[0]!.toUpperCase().charCodeAt(0) : 63
  const idx = ((code - 65) % GLYPH_PALETTE.length + GLYPH_PALETTE.length) % GLYPH_PALETTE.length
  return GLYPH_PALETTE[idx]!
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** Channel-wise lerp between two packed truecolor values. */
export function lerpColor(a: Color, b: Color, t: number): Color {
  const k = clamp01(t)
  const ar = (a >> 16) & 0xff
  const ag = (a >> 8) & 0xff
  const ab = a & 0xff
  const br = (b >> 16) & 0xff
  const bg = (b >> 8) & 0xff
  const bb = b & 0xff
  return rgb(
    Math.round(ar + (br - ar) * k),
    Math.round(ag + (bg - ag) * k),
    Math.round(ab + (bb - ab) * k),
  )
}

const HEAT_COLD = rgb(0x55, 0x55, 0x5c)
const HEAT_WHITE = rgb(0xff, 0xff, 0xff)

/**
 * Heat channel as fg brightness: 0 → dim grey-tinted glyph color,
 * 0.75 → full glyph color, 1 → pushed toward white ("hot").
 */
export function heatColor(glyph: string, heat: number): Color {
  const base = glyphColor(glyph)
  const t = clamp01(heat)
  if (t <= 0.75) return lerpColor(lerpColor(base, HEAT_COLD, 0.72), base, t / 0.75)
  return lerpColor(base, HEAT_WHITE, ((t - 0.75) / 0.25) * 0.45)
}

/** Corroboration pips (§4.6) as 1–3 small marks, count + weight redundant. */
export function pipMarks(pips: number): string {
  const p = Math.max(0, Math.min(3, Math.round(pips)))
  if (p === 0) return '   '
  if (p === 1) return '·  '
  if (p === 2) return '•• '
  return '●●●'
}

export const TIER_NAME = ['chip', 'summary', 'expanded'] as const
/** Single-letter tier tag for bus slots / compact UI. */
export const TIER_TAG = ['c', 'S', 'E'] as const

/** Non-glyph UI colors. */
export const UI = {
  text: rgb(0xc9, 0xc9, 0xc9),
  dim: rgb(0x6e, 0x6e, 0x76),
  faint: rgb(0x4a, 0x4a, 0x52),
  border: rgb(0x50, 0x50, 0x5a),
  accent: rgb(0x66, 0xcc, 0xee),
  good: rgb(0x55, 0xbb, 0x66),
  warn: rgb(0xcc, 0xbb, 0x44),
  danger: rgb(0xee, 0x55, 0x55),
  boss: rgb(0xff, 0x44, 0x44),
  zen: rgb(0x44, 0xbb, 0x99),
  protected: rgb(0x55, 0x77, 0x99),
  gaugeLow: rgb(0x55, 0xbb, 0x66),
  gaugeMid: rgb(0xcc, 0xbb, 0x44),
  gaugeHot: rgb(0xee, 0x55, 0x55),
  score: rgb(0xee, 0xdd, 0x88),
} as const

/** Memory-gauge fill color by fill fraction (red zone ≥ 0.9). */
export function gaugeColor(fill: number): Color {
  if (fill >= 0.9) return UI.gaugeHot
  if (fill >= 0.7) return UI.gaugeMid
  return UI.gaugeLow
}

/** Zalgo-lite substitution table for the miss-corruption effect (all width-1). */
export const CORRUPT_TABLE = '▒▓░#%&@§×¿?!~^*' as const
