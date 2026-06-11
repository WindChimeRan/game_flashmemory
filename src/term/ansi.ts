/**
 * ANSI/VT escape-sequence builders. Pure string functions, no I/O, no state.
 *
 * Reimplemented from public specs (xterm ctlseqs, ECMA-48); see
 * ARCHITECTURE.md D5/D6 for the protocol decisions and reference policy.
 */

import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_REVERSE,
  ATTR_UNDERLINE,
  TRUECOLOR_BIT,
  type Color,
} from './types'

export const ESC = '\x1b'
export const CSI = '\x1b['

// ── cursor ────────────────────────────────────────────────────────────

export const CURSOR_HOME = '\x1b[H'
export const CURSOR_SHOW = '\x1b[?25h'
export const CURSOR_HIDE = '\x1b[?25l'

/** Move cursor to 0-based (row, col); emits 1-based CUP. */
export function cursorTo(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}

/** Erase the whole screen (does not move the cursor). */
export const CLEAR_SCREEN = '\x1b[2J'

// ── DEC private modes ─────────────────────────────────────────────────

export const MODE_MOUSE_PRESS = 1000
export const MODE_MOUSE_DRAG = 1002
export const MODE_FOCUS = 1004
export const MODE_MOUSE_SGR = 1006
export const MODE_ALT_SCREEN = 1049
export const MODE_BRACKETED_PASTE = 2004
export const MODE_SYNC_UPDATE = 2026

/** DECSET — turn DEC private mode(s) on. */
export function decset(...modes: number[]): string {
  return `\x1b[?${modes.join(';')}h`
}

/** DECRST — turn DEC private mode(s) off. */
export function decrst(...modes: number[]): string {
  return `\x1b[?${modes.join(';')}l`
}

export const ALT_SCREEN_ON = decset(MODE_ALT_SCREEN)
export const ALT_SCREEN_OFF = decrst(MODE_ALT_SCREEN)
export const FOCUS_ON = decset(MODE_FOCUS)
export const FOCUS_OFF = decrst(MODE_FOCUS)
export const PASTE_ON = decset(MODE_BRACKETED_PASTE)
export const PASTE_OFF = decrst(MODE_BRACKETED_PASTE)
export const MOUSE_ON = decset(MODE_MOUSE_PRESS, MODE_MOUSE_DRAG, MODE_MOUSE_SGR)
export const MOUSE_OFF = decrst(MODE_MOUSE_SGR, MODE_MOUSE_DRAG, MODE_MOUSE_PRESS)
/** Begin Synchronized Update (DEC 2026). */
export const BSU = decset(MODE_SYNC_UPDATE)
/** End Synchronized Update (DEC 2026). */
export const ESU = decrst(MODE_SYNC_UPDATE)

// ── SGR ───────────────────────────────────────────────────────────────

export const SGR_RESET = '\x1b[0m'

/** Compose one SGR sequence from parameter fragments ('' for none). */
export function sgr(params: ReadonlyArray<string | number>): string {
  return params.length === 0 ? '' : `\x1b[${params.join(';')}m`
}

/** SGR codes for the attribute bits set in `attrs` (additive only). */
export function attrParams(attrs: number): number[] {
  const out: number[] = []
  if (attrs & ATTR_BOLD) out.push(1)
  if (attrs & ATTR_DIM) out.push(2)
  if (attrs & ATTR_ITALIC) out.push(3)
  if (attrs & ATTR_UNDERLINE) out.push(4)
  if (attrs & ATTR_REVERSE) out.push(7)
  return out
}

/** Foreground SGR parameter fragment for a packed Color. */
export function fgParam(c: Color, truecolor: boolean): string {
  if (c < 0) return '39'
  if (c & TRUECOLOR_BIT) {
    const r = (c >> 16) & 0xff
    const g = (c >> 8) & 0xff
    const b = c & 0xff
    return truecolor ? `38;2;${r};${g};${b}` : `38;5;${rgbTo256(r, g, b)}`
  }
  return `38;5;${c & 0xff}`
}

/** Background SGR parameter fragment for a packed Color. */
export function bgParam(c: Color, truecolor: boolean): string {
  if (c < 0) return '49'
  if (c & TRUECOLOR_BIT) {
    const r = (c >> 16) & 0xff
    const g = (c >> 8) & 0xff
    const b = c & 0xff
    return truecolor ? `48;2;${r};${g};${b}` : `48;5;${rgbTo256(r, g, b)}`
  }
  return `48;5;${c & 0xff}`
}

/** Pack r,g,b (0–255) into a truecolor Color. */
export function rgb(r: number, g: number, b: number): Color {
  return TRUECOLOR_BIT | ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff)
}

// ── truecolor → 256 quantization ──────────────────────────────────────

/** xterm 6×6×6 cube component levels. */
const CUBE = [0, 95, 135, 175, 215, 255] as const

/** Index of the nearest cube level for one component. */
function cubeIndex(v: number): number {
  if (v < 48) return 0
  if (v < 115) return 1
  const i = Math.floor((v - 35) / 40)
  return i > 5 ? 5 : i
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

/**
 * Quantize an RGB triple to the xterm 256-color palette: nearest of the
 * 6×6×6 color cube (16..231) or the 24-step grayscale ramp (232..255),
 * by squared-distance comparison.
 */
export function rgbTo256(r: number, g: number, b: number): number {
  r = clamp255(r)
  g = clamp255(g)
  b = clamp255(b)
  const ri = cubeIndex(r)
  const gi = cubeIndex(g)
  const bi = cubeIndex(b)
  const cr = CUBE[ri]!
  const cg = CUBE[gi]!
  const cb = CUBE[bi]!
  const dCube = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb)

  const avg = Math.round((r + g + b) / 3)
  let gray = Math.round((avg - 8) / 10)
  if (gray < 0) gray = 0
  if (gray > 23) gray = 23
  const gv = 8 + gray * 10
  const dGray = (r - gv) * (r - gv) + (g - gv) * (g - gv) + (b - gv) * (b - gv)

  return dGray < dCube ? 232 + gray : 16 + 36 * ri + 6 * gi + bi
}

/** Downconvert any packed Color to a 256-palette index (default stays -1). */
export function colorTo256(c: Color): number {
  if (c < 0) return -1
  if (c & TRUECOLOR_BIT) return rgbTo256((c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff)
  return c & 0xff
}
