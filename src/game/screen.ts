/**
 * screen — pure composition: renderScreen(state) → Grid (golden-testable).
 *
 * Layout (target min 100×30, uses the full terminal):
 *   LEFT  story viewport (the managed area, width ≈ cols−36): chunks in
 *         spawn order — expanded = 1-line header + pretext-laid-out prose;
 *         summary = dim header line only; chip = nothing inline (rail).
 *         The protected strip carries a subtle left-border marker; the
 *         streaming chunk reveals words as tokensShown grows.
 *   RIGHT sidebar (34 cols): memory-pressure vertical gauge (red zone
 *         ≥ 90%), coherence bar, score + streak, bus slots, WAVE TELEGRAPH
 *         panel (boss waves bordered/red), zen indicator, chip RAIL at the
 *         bottom (age order, ≤ 3 rows, +N overflow).
 *   BOTTOM line: focus info + key hints (flash messages override).
 *
 * Miss effect: while tick < corruptUntilTick the incoming stream's newest
 * words render through a fixed zalgo-lite substitution table seeded by the
 * tick, and the coherence bar flashes.
 *
 * Pure: output depends only on ScreenState (tween samples included).
 */

import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_NONE,
  ATTR_REVERSE,
  ATTR_UNDERLINE,
  createGrid,
  type Color,
  type Grid,
} from '../term'
import type { Layout } from '../pretext'
import type { ChunkView, RoundResult, SimView, WaveView } from '../sim'
import { TIER_EXPANDED, TIER_SUMMARY } from '../sim'
import { characterFor } from '../content/scripted'
import { cellWidth, graphemes, stringWidth } from '../shared/width'
import type { TweenSample } from './anim'
import {
  CORRUPT_TABLE,
  UI,
  TIER_NAME,
  TIER_TAG,
  gaugeColor,
  glyphColor,
  heatColor,
  pipMarks,
} from './theme'

// ── state ────────────────────────────────────────────────────────────────

export interface ProseView {
  readonly layout: Layout
  readonly textOf: (segId: number) => string
}

export type OverKind = 'oom' | 'collapse' | 'survived'

export interface OverState {
  readonly kind: OverKind
  /** Death-cause / attribution summary line (or triumph line). */
  readonly summary: string
  readonly result: RoundResult
}

export interface ScreenState {
  readonly cols: number
  readonly rows: number
  readonly view: SimView
  /** chunkId → revealed prose (expanded chunks consult this). */
  readonly prose: ReadonlyMap<number, ProseView>
  readonly focusId: number | null
  readonly paused: boolean
  /** Bottom-line flash (rejection reasons etc.); null = none. */
  readonly flash: string | null
  readonly confirmQuit: boolean
  /** Stream corruption active while view.tick < corruptUntilTick. */
  readonly corruptUntilTick: number
  /** Render-clock tween samples (null = no animation). */
  readonly tweens: ReadonlyMap<string, TweenSample> | null
  /** Sidebar title tail, e.g. "default · seed 7". */
  readonly title: string
  readonly ticksPerSec: number
  readonly over: OverState | null
  /** Terminal below minimum size: render the friendly message instead. */
  readonly tooSmall: boolean
  /**
   * Story-language character name per glyph (ContentProvider.nameFor seam);
   * absent → the scripted English cast (characterFor).
   */
  readonly nameFor?: (glyph: string) => string
  /** Bot name when a pilot drives the actions — rendered as an honest
   *  PILOT tag in the bottom bar. Absent/null = human at the keys. */
  readonly pilot?: string | null
}

// ── geometry ─────────────────────────────────────────────────────────────

export const SIDEBAR_W = 34
export const MIN_COLS = 100
export const MIN_ROWS = 30
const RAIL_ROWS = 3
const GAUGE_H = 12

/** Prose wrap width for a terminal width (story viewport ≈ cols−36). */
export function proseWidth(cols: number): number {
  return Math.max(20, cols - 37)
}

export interface ChunkBlock {
  readonly id: number
  /** Absolute row of the header line (may be negative when clipped). */
  readonly top: number
  /** Rows including the header. */
  readonly height: number
  readonly badgeCol: number
}

export interface RailCell {
  readonly id: number
  readonly row: number
  readonly col: number
}

export interface Geometry {
  readonly storyRows: number
  readonly proseLeft: number
  readonly proseW: number
  readonly borderCol: number
  readonly sidebarX: number
  /** Inline (expanded / summary / transferring) chunks, spawn order. */
  readonly blocks: readonly ChunkBlock[]
  /** Story lines hidden above the top edge (stream-anchored clipping). */
  readonly clippedTop: number
  readonly rail: readonly RailCell[]
  readonly railOverflow: number
}

/** A chunk renders inline unless it is a plain chip (rail). */
export function isInline(c: ChunkView): boolean {
  return c.tier > 0 || c.transfer !== null
}

function blockHeight(c: ChunkView, prose: ProseView | undefined): number {
  if (c.tier !== TIER_EXPANDED) return 1 // header only (summary / transferring chip)
  const lines = prose ? prose.layout.lines.length : Math.max(1, c.linesByTier[2])
  return 1 + lines
}

export function computeGeometry(state: ScreenState): Geometry {
  const { cols, rows } = state
  const storyRows = rows - 1
  const proseLeft = 2
  const proseW = proseWidth(cols)
  const borderCol = cols - SIDEBAR_W - 1
  const sidebarX = cols - SIDEBAR_W

  const inline = state.view.chunks.filter(isInline)
  const heights = inline.map((c) => blockHeight(c, state.prose.get(c.id)))
  let total = 0
  for (const h of heights) total += h
  total += Math.max(0, inline.length - 1) // 1 blank row between blocks
  const clippedTop = Math.max(0, total - storyRows)

  const blocks: ChunkBlock[] = []
  let top = clippedTop > 0 ? -clippedTop : 0
  for (let i = 0; i < inline.length; i++) {
    const c = inline[i]!
    blocks.push({ id: c.id, top, height: heights[i]!, badgeCol: proseLeft })
    top += heights[i]! + 1
  }

  // Chip rail: cold chunks as badge cells in age order, bottom of sidebar.
  const chips = state.view.chunks.filter((c) => !isInline(c))
  const railTop = storyRows - RAIL_ROWS
  const perRow = Math.floor((SIDEBAR_W - 2) / 2)
  const capacity = perRow * RAIL_ROWS
  const shown = chips.length > capacity ? capacity - 1 : chips.length // keep room for +N
  const rail: RailCell[] = []
  for (let i = 0; i < shown; i++) {
    rail.push({
      id: chips[i]!.id,
      row: railTop + Math.floor(i / perRow),
      col: sidebarX + 1 + (i % perRow) * 2,
    })
  }
  return {
    storyRows,
    proseLeft,
    proseW,
    borderCol,
    sidebarX,
    blocks,
    clippedTop,
    rail,
    railOverflow: chips.length - shown,
  }
}

// ── small helpers ────────────────────────────────────────────────────────

const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : '—')

function bar(filled: number, len: number, fillCh = '█', emptyCh = '░'): string {
  const f = Math.max(0, Math.min(len, Math.round(filled * len)))
  return fillCh.repeat(f) + emptyCh.repeat(len - f)
}

/** Render the [fromCell, toCell) cell range of a segment's text. */
export function sliceCells(text: string, fromCell: number, toCell: number): string {
  let cell = 0
  let out = ''
  for (const g of graphemes(text)) {
    const w = cellWidth(g)
    if (cell >= toCell) break
    if (cell >= fromCell) out += g
    cell += w
  }
  return out
}

/** Deterministic zalgo-lite substitution, seeded by (tick, row, col). */
export function corruptChar(ch: string, tick: number, row: number, col: number): string {
  if (ch === ' ' || ch === '') return ch
  let h = (tick * 2654435761) >>> 0
  h = (h ^ (row * 8191) ^ (col * 131)) >>> 0
  if (h % 5 < 2) return ch // partial corruption reads better than full noise
  return CORRUPT_TABLE[h % CORRUPT_TABLE.length]!
}

/** Greedy word-wrap for panel text (no pretext needed at this size). */
function wrapText(text: string, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const cand = cur === '' ? w : `${cur} ${w}`
    if (cand.length <= width) {
      cur = cand
    } else {
      lines.push(cur)
      cur = w.length > width ? w.slice(0, width - 1) + '…' : w
      if (lines.length === maxLines) break
    }
  }
  if (lines.length < maxLines && cur !== '') lines.push(cur)
  if (lines.length > maxLines) lines.length = maxLines
  return lines
}

const truncate = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…')

/** Character name in the story language (provider seam; scripted fallback). */
function displayName(state: ScreenState, glyph: string): string {
  return state.nameFor?.(glyph) ?? characterFor(glyph).name
}

/** Truncate to `cells` terminal cells (… when over) and pad — CJK-safe.
 *  For ASCII this matches truncate(s, cells).padEnd(cells) exactly. */
function padCells(s: string, cells: number): string {
  let out = s
  let w = stringWidth(s)
  if (w > cells) {
    out = ''
    w = 0
    for (const g of graphemes(s)) {
      const gw = cellWidth(g)
      if (w + gw > cells - 1) break
      out += g
      w += gw
    }
    out += '…'
    w += 1
  }
  return out + ' '.repeat(Math.max(0, cells - w))
}

// ── story (left column) ──────────────────────────────────────────────────

interface Ctx {
  readonly grid: Grid
  readonly state: ScreenState
  readonly geo: Geometry
}

function tween(ctx: Ctx, key: string): TweenSample | undefined {
  return ctx.state.tweens?.get(key)
}

/** Vertical block offset from an active whole-block tween. */
function blockOffset(ctx: Ctx, b: ChunkBlock): number {
  const tw = tween(ctx, `b${b.id}`)
  return tw && tw.kind === 'move' ? tw.row - b.top : 0
}

function drawHeader(ctx: Ctx, b: ChunkBlock, c: ChunkView, row: number): void {
  const { grid, state, geo } = ctx
  if (row < 0 || row >= geo.storyRows) return
  const dim = c.tier === TIER_SUMMARY ? ATTR_DIM : ATTR_NONE
  const focused = state.focusId === c.id
  const bold = focused ? ATTR_BOLD : ATTR_NONE
  const hc = heatColor(c.glyph, c.heat)

  // gutter: focus marker wins over the protected strip marker on this row
  if (focused) grid.set(row, 0, '▶', UI.text, undefined, ATTR_BOLD)

  let x = b.badgeCol
  grid.set(row, x, c.glyph, hc, undefined, ATTR_REVERSE | ATTR_BOLD)
  x += 2
  x += grid.text(row, x, pipMarks(c.pips), UI.dim, undefined, dim)
  x += 1
  const name = padCells(displayName(state, c.glyph), 16)
  x += grid.text(row, x, name, hc, undefined, dim | bold)
  x += 1
  x += grid.text(row, x, bar(c.heat, 5, '█', '·'), hc, undefined, dim)
  x += 1

  // tail: transfer progress > stream progress > line cost
  if (c.transfer) {
    const span = Math.max(1, c.transfer.arriveTick - c.transfer.startTick)
    const pct = Math.max(0, Math.min(99, Math.floor(((state.view.tick - c.transfer.startTick) / span) * 100)))
    x += grid.text(row, x, `⇡${TIER_TAG[c.transfer.toTier]} ${String(pct).padStart(2)}%`, UI.accent, undefined, ATTR_BOLD)
  } else if (c.tokensShown < c.tokensTotal) {
    x += grid.text(row, x, `+${c.tokensShown}/${c.tokensTotal}`, UI.dim, undefined, dim)
  } else {
    x += grid.text(row, x, `${c.linesNow}L`, UI.dim, undefined, ATTR_DIM)
  }
  if (c.pinned) grid.text(row, x + 1, '◆pin', UI.warn, undefined, ATTR_BOLD)
}

/** segIds of the newest ~15 word placements (corruption targets). */
function corruptionSet(prose: ProseView): Set<number> {
  const out = new Set<number>()
  const lines = prose.layout.lines
  for (let li = lines.length - 1; li >= 0 && out.size < 15; li--) {
    const pls = lines[li]!.placements
    for (let pi = pls.length - 1; pi >= 0 && out.size < 15; pi--) {
      const id = pls[pi]!.segId
      if (prose.textOf(id).trim() !== '') out.add(id)
    }
  }
  return out
}

function drawProse(ctx: Ctx, b: ChunkBlock, c: ChunkView, offset: number): void {
  const { grid, state, geo } = ctx
  const prose = state.prose.get(c.id)
  if (!prose) return
  const corrupting = state.view.tick < state.corruptUntilTick && c.tokensShown < c.tokensTotal
  const corrupt = corrupting ? corruptionSet(prose) : null
  const baseRow = b.top + 1 + offset
  const lines = prose.layout.lines
  // Tween-moved segments draw AFTER the settled text so they stay visible
  // while crossing other words (they are the animation).
  const deferred: { row: number; col: number; piece: string; segId: number }[] = []

  const put = (row: number, col: number, piece: string, segId: number, attrs: number): void => {
    if (row < 0 || row >= geo.storyRows) return
    if (corrupt?.has(segId)) {
      let cx = col
      for (const g of graphemes(piece)) {
        grid.set(row, cx, corruptChar(g, state.view.tick, row, cx), UI.danger, undefined, attrs)
        cx += cellWidth(g)
      }
    } else {
      grid.text(row, col, piece, UI.text, undefined, attrs)
    }
  }

  for (let li = 0; li < lines.length; li++) {
    for (const pl of lines[li]!.placements) {
      const text = prose.textOf(pl.segId)
      if (text === '') continue
      const piece = pl.slice ? sliceCells(text, pl.slice[0], pl.slice[1]) : text
      const tw = tween(ctx, `c${c.id}s${pl.segId}`)
      if (tw && tw.kind === 'move') {
        deferred.push({ row: baseRow + tw.row, col: geo.proseLeft + tw.col, piece, segId: pl.segId })
        continue
      }
      const attrs = tw && tw.kind === 'enter' ? ATTR_DIM : ATTR_NONE // fade in
      put(baseRow + li, geo.proseLeft + pl.col, piece, pl.segId, attrs)
    }
  }
  for (const d of deferred) put(d.row, d.col, d.piece, d.segId, ATTR_NONE)
}

function drawStory(ctx: Ctx): void {
  const { grid, state, geo } = ctx
  const byId = new Map(state.view.chunks.map((c) => [c.id, c]))
  for (const b of geo.blocks) {
    const c = byId.get(b.id)
    if (!c) continue
    const off = blockOffset(ctx, b)
    const top = b.top + off
    // protected strip: subtle left-border marker down the whole block
    if (c.protected) {
      for (let r = top; r < top + b.height; r++) {
        if (r >= 0 && r < geo.storyRows) grid.set(r, 0, '▎', UI.protected)
      }
    }
    drawHeader(ctx, b, c, top)
    if (c.tier === TIER_EXPANDED) drawProse(ctx, b, c, off)
  }
  if (geo.clippedTop > 0) {
    grid.text(0, geo.proseLeft, `⋯ ${geo.clippedTop} earlier line${geo.clippedTop === 1 ? '' : 's'}`, UI.faint, undefined, ATTR_DIM)
  }
  // exit tweens: words collapsing toward their chunk badge (absolute coords)
  if (state.tweens) {
    for (const tw of state.tweens.values()) {
      if (tw.kind !== 'exit' || tw.text === undefined) continue
      if (tw.row < 0 || tw.row >= geo.storyRows) continue
      const keep = Math.max(1, Math.ceil(tw.text.length * (1 - tw.t)))
      grid.text(tw.row, tw.col, tw.text.slice(0, keep), UI.dim, undefined, ATTR_DIM)
    }
  }
}

// ── sidebar ──────────────────────────────────────────────────────────────

function drawGauge(ctx: Ctx): void {
  const { grid, state } = ctx
  const m = state.view.meters
  const fill = m.viewportBudget > 0 ? m.viewportUsed / m.viewportBudget : 1
  const gx = state.cols - 3
  grid.text(1, gx - 1, 'MEM', UI.dim, undefined, ATTR_DIM)
  const filledRows = Math.max(0, Math.min(GAUGE_H, Math.round(fill * GAUGE_H)))
  const zoneFrom = Math.floor(0.9 * GAUGE_H) // red zone ≥ 90%
  for (let i = 0; i < GAUGE_H; i++) {
    const row = 2 + (GAUGE_H - 1 - i) // i = 0 is the bottom cell
    const inZone = i >= zoneFrom
    const filled = i < filledRows
    const ch = filled ? '█' : inZone ? '▒' : '·'
    const color = filled ? (inZone ? UI.gaugeHot : gaugeColor(fill)) : inZone ? UI.gaugeHot : UI.faint
    grid.set(row, gx, ch, color, undefined, filled ? ATTR_NONE : ATTR_DIM)
    grid.set(row, gx + 1, ch, color, undefined, filled ? ATTR_NONE : ATTR_DIM)
  }
  const pct = `${Math.round(fill * 100)}%`.padStart(4)
  grid.text(2 + GAUGE_H, gx - 1, pct, fill >= 0.9 ? UI.gaugeHot : UI.dim, undefined, fill >= 0.9 ? ATTR_BOLD : ATTR_NONE)
}

function drawWaveLine(ctx: Ctx, w: WaveView, row: number, x: number, width: number): void {
  const { grid, state } = ctx
  const boss = w.archetype === 'boss'
  const tick = state.view.tick
  const span = Math.max(1, w.landTick - w.telegraphTick)
  const remaining = Math.max(0, Math.min(1, (w.landTick - tick) / span))
  const secs = Math.max(0, Math.ceil((w.landTick - tick) / Math.max(1, state.ticksPerSec)))

  if (boss) grid.set(row, x, '▌', UI.boss, undefined, ATTR_BOLD)
  let gx = x + 1
  for (const g of w.glyphs.slice(0, 6)) {
    grid.set(row, gx, g, glyphColor(g), undefined, ATTR_REVERSE | ATTR_BOLD)
    gx += 1
  }
  const barX = x + 8
  const barLen = 10
  const color = boss ? UI.boss : remaining < 0.25 ? UI.warn : UI.accent
  grid.text(row, barX, bar(remaining, barLen, '▓', '░'), color, undefined, boss ? ATTR_BOLD : ATTR_NONE)
  grid.text(row, barX + barLen + 1, `${String(secs).padStart(2)}s`, color)
  if (boss) grid.text(row, barX + barLen + 5, 'BOSS', UI.boss, undefined, ATTR_BOLD | ATTR_REVERSE)
  void width
}

function drawSidebar(ctx: Ctx, geo: Geometry): void {
  const { grid, state } = ctx
  const m = state.view.meters
  const x = geo.sidebarX + 1
  const R = geo.storyRows

  // border
  for (let r = 0; r < R; r++) grid.set(r, geo.borderCol, '│', UI.border, undefined, ATTR_DIM)

  // title
  grid.text(0, x, 'OOM', UI.accent, undefined, ATTR_BOLD)
  grid.text(0, x + 4, truncate(state.title, 22), UI.dim, undefined, ATTR_DIM)
  if (state.paused) grid.text(0, x + 4 + Math.min(22, state.title.length) + 1, 'PAUSED', UI.warn, undefined, ATTR_BOLD)

  drawGauge(ctx)

  // coherence (flashes red while the miss-corruption window is active)
  const cohFlash = state.view.tick < state.corruptUntilTick
  const cohFrac = m.coherence / 100
  grid.text(2, x, 'COH', UI.dim, undefined, ATTR_DIM)
  grid.text(2, x + 4, bar(cohFrac, 16), cohFlash ? UI.danger : cohFrac < 0.3 ? UI.danger : UI.good, undefined, cohFlash ? ATTR_REVERSE | ATTR_BOLD : ATTR_NONE)
  grid.text(2, x + 21, String(Math.round(m.coherence)).padStart(3), cohFlash ? UI.danger : UI.text)

  // score + streak
  grid.text(3, x, 'PTS', UI.dim, undefined, ATTR_DIM)
  grid.text(3, x + 4, String(Math.round(m.score)).padStart(6), UI.score, undefined, ATTR_BOLD)
  grid.text(3, x + 12, 'STRK', UI.dim, undefined, ATTR_DIM)
  grid.text(3, x + 17, `×${m.streak}`, m.streak > 0 ? UI.good : UI.dim)

  // bus slots: B boxes; in-flight transfers show progress + target badge
  grid.text(5, x, 'BUS', UI.dim, undefined, ATTR_DIM)
  const inFlight = state.view.chunks
    .filter((c) => c.transfer !== null)
    .sort((a, b) => a.transfer!.arriveTick - b.transfer!.arriveTick)
  let bx = x + 4
  for (let i = 0; i < Math.min(3, m.busCap); i++) {
    const c = inFlight[i]
    if (c && c.transfer) {
      const span = Math.max(1, c.transfer.arriveTick - c.transfer.startTick)
      const prog = Math.max(0, Math.min(1, (state.view.tick - c.transfer.startTick) / span))
      grid.set(5, bx, c.glyph, glyphColor(c.glyph), undefined, ATTR_REVERSE | ATTR_BOLD)
      grid.text(5, bx + 1, `↑${TIER_TAG[c.transfer.toTier]}`, UI.accent)
      grid.text(5, bx + 3, bar(prog, 4, '▰', '▱'), UI.accent)
      bx += 9
    } else {
      grid.text(5, bx, '·······', UI.faint, undefined, ATTR_DIM)
      bx += 9
    }
  }
  if (m.busCap > 3) grid.text(5, bx, `+${m.busCap - 3}`, UI.dim, undefined, ATTR_DIM)

  // wave telegraph panel
  const railTop = R - RAIL_ROWS
  const statusRow = railTop - 2
  const waveBottom = railTop - 3
  grid.text(7, x, 'INCOMING', UI.dim, undefined, ATTR_DIM)
  const waves = [...state.view.waves].sort((a, b) => a.landTick - b.landTick || a.id - b.id)
  const maxLines = Math.max(0, waveBottom - 8 + 1)
  for (let i = 0; i < Math.min(waves.length, maxLines); i++) {
    drawWaveLine(ctx, waves[i]!, 8 + i, x, SIDEBAR_W - 2)
  }
  if (waves.length > maxLines && maxLines > 0) {
    grid.text(8 + maxLines - 1, x + 26, `+${waves.length - maxLines}`, UI.dim, undefined, ATTR_DIM)
  }
  if (waves.length === 0) grid.text(8, x + 1, '— quiet —', UI.faint, undefined, ATTR_DIM)

  // status: zen / 2× cliff
  if (state.view.zenActive) {
    grid.text(statusRow, x, '◌ ZEN — purge for bonus', UI.zen, undefined, ATTR_BOLD)
  } else if (state.view.cliffActive) {
    grid.text(statusRow, x, '▲ SIGNAL DEGRADED', UI.danger, undefined, ATTR_BOLD)
  }

  // chip rail
  const chips = geo.rail
  grid.text(railTop - 1, x, `COLD ${chips.length + geo.railOverflow}`, UI.dim, undefined, ATTR_DIM)
  for (const cell of chips) {
    const c = state.view.chunks[cell.id]
    if (!c) continue
    const focused = state.focusId === cell.id
    grid.set(cell.row, cell.col, c.glyph, heatColor(c.glyph, c.heat), undefined, ATTR_REVERSE | (focused ? ATTR_BOLD : ATTR_NONE))
    if (focused) grid.set(cell.row, cell.col + 1, '‹', UI.text, undefined, ATTR_BOLD)
  }
  if (geo.railOverflow > 0) {
    const last = chips[chips.length - 1]
    const row = last ? last.row : railTop
    const col = last ? last.col + 2 : x
    grid.text(row, col, `+${geo.railOverflow}`, UI.dim, undefined, ATTR_DIM)
  }
}

// ── bottom line ──────────────────────────────────────────────────────────

const HINTS = 'j/k·nav a–z·jump f·fetch d·evict p·pin ␣·pause q·quit'

function drawBottom(ctx: Ctx): void {
  const { grid, state } = ctx
  const row = state.rows - 1
  if (state.over) {
    grid.text(row, 2, 'r·restart   q·quit', UI.dim, undefined, ATTR_DIM)
    return
  }
  if (state.flash) {
    grid.text(row, 2, `✗ ${state.flash}`, UI.danger, undefined, ATTR_BOLD)
  } else if (state.confirmQuit) {
    grid.text(row, 2, 'q again to quit — any other key cancels', UI.warn, undefined, ATTR_BOLD)
  } else if (state.paused) {
    grid.text(row, 2, 'PAUSED — mouse off, select/copy enabled · ␣ resume', UI.warn, undefined, ATTR_BOLD)
  } else {
    const c = state.focusId !== null ? state.view.chunks[state.focusId] : undefined
    if (c) {
      let x = 2
      grid.set(row, x, '▶', UI.text, undefined, ATTR_BOLD)
      x += 2
      grid.set(row, x, c.glyph, heatColor(c.glyph, c.heat), undefined, ATTR_REVERSE | ATTR_BOLD)
      x += 2
      const info = `${displayName(state, c.glyph)} · ${TIER_NAME[c.tier]}${c.pinned ? ' · pinned' : ''}${c.protected ? ' · protected' : ''}`
      grid.text(row, x, truncate(info, 36), UI.dim)
    } else if (!state.pilot) {
      grid.text(row, 2, 'j/k to focus a chunk', UI.faint, undefined, ATTR_DIM)
    }
  }
  // right side: key hints — or the honest PILOT tag (keys shrink to ␣/q)
  if (state.pilot) {
    const tag = ` PILOT ${state.pilot} `
    const keys = '␣·pause q·quit'
    const hx = state.cols - (tag.length + 1 + keys.length) - 2
    if (hx > 43) {
      grid.text(row, hx, tag, UI.accent, undefined, ATTR_BOLD | ATTR_REVERSE)
      grid.text(row, hx + tag.length + 1, keys, UI.faint, undefined, ATTR_DIM)
    }
  } else {
    const hx = state.cols - HINTS.length - 2
    if (hx > 43) grid.text(row, hx, HINTS, UI.faint, undefined, ATTR_DIM)
  }
}

// ── death / survival screen ──────────────────────────────────────────────

/** Pareto table rows styled after the paper's Table 1 (fixed benchmarks). */
export function paretoRows(r: RoundResult): string[][] {
  const surv = Math.min(1, r.ticksSurvived / r.roundTicks)
  return [
    ['policy', 'surv', 'recall', 'resid', 'pareto'],
    ['YOU', f2(surv), f2(r.meanCredit), f2(r.residencyMean), f2(r.pareto)],
    ['FM-DS-V4', '1.00', '1.01', '0.135', '0.87'],
    ['Recency-Only', '—', '0.33', '—', '—'],
    ['Random-10%', '—', '0.39', '0.10', '—'],
  ]
}

const OVER_TITLE: Record<OverKind, string> = {
  oom: 'OUT OF MEMORY',
  collapse: 'COHERENCE COLLAPSE',
  survived: 'ROUND SURVIVED',
}

function drawOver(ctx: Ctx): void {
  const { grid, state } = ctx
  const over = state.over!
  // dim the frozen game underneath
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = grid.get(r, c)
      if (cell.ch === '' || cell.ch === ' ') continue
      grid.set(r, c, cell.ch, UI.faint, cell.bg, ATTR_DIM)
    }
  }
  const W = 66
  const H = 19
  const x0 = Math.max(0, Math.floor((state.cols - W) / 2))
  const y0 = Math.max(0, Math.floor((state.rows - H) / 2))
  const accent = over.kind === 'survived' ? UI.good : over.kind === 'oom' ? UI.danger : UI.boss

  // panel
  grid.fill(y0, x0, W, H, ' ', UI.text, undefined, ATTR_NONE)
  grid.text(y0, x0, '┌' + '─'.repeat(W - 2) + '┐', accent)
  grid.text(y0 + H - 1, x0, '└' + '─'.repeat(W - 2) + '┘', accent)
  for (let r = y0 + 1; r < y0 + H - 1; r++) {
    grid.set(r, x0, '│', accent)
    grid.set(r, x0 + W - 1, '│', accent)
  }
  const center = (row: number, s: string, fg: Color, attrs = ATTR_NONE): void => {
    grid.text(row, x0 + Math.max(1, Math.floor((W - s.length) / 2)), s, fg, undefined, attrs)
  }

  const title = OVER_TITLE[over.kind]
  center(y0 + 2, ` ${title} `, accent, ATTR_BOLD | ATTR_REVERSE)

  const summary = wrapText(over.summary, W - 6, 3)
  for (let i = 0; i < summary.length; i++) center(y0 + 4 + i, summary[i]!, UI.dim)

  // the additive score, big
  const scoreText = `  SCORE  ${[...String(Math.round(over.result.score))].join(' ')}  `
  center(y0 + 8, scoreText, UI.score, ATTR_BOLD | ATTR_REVERSE)

  // Pareto table (Table 1 homage)
  const rows = paretoRows(over.result)
  const colW = [15, 7, 8, 8, 8]
  for (let ri = 0; ri < rows.length; ri++) {
    const cells = rows[ri]!
    let line = ''
    for (let ci = 0; ci < cells.length; ci++) {
      line += ci === 0 ? cells[ci]!.padEnd(colW[ci]!) : cells[ci]!.padStart(colW[ci]!)
    }
    const y = y0 + 10 + ri
    const isYou = ri === 1
    grid.text(y, x0 + 4, line, UI.dim, undefined, isYou ? ATTR_BOLD : ri === 0 ? ATTR_DIM | ATTR_UNDERLINE : ATTR_DIM)
    if (isYou) grid.text(y, x0 + 4, line, UI.text, undefined, ATTR_BOLD)
    if (isYou) grid.set(y, x0 + 2, '▸', accent, undefined, ATTR_BOLD)
  }

  center(y0 + 16, over.kind === 'survived' ? 'the indexer held — r·again   q·quit' : 'r·restart   q·quit', UI.text, ATTR_BOLD)
}

// ── top-level ────────────────────────────────────────────────────────────

function drawTooSmall(grid: Grid, state: ScreenState): void {
  const msgs = [
    'OOM needs a bigger window',
    `minimum ${MIN_COLS}×${MIN_ROWS} — current ${state.cols}×${state.rows}`,
    'resize the terminal, or press q to quit',
  ]
  const y = Math.max(0, Math.floor(state.rows / 2) - 1)
  for (let i = 0; i < msgs.length; i++) {
    const s = msgs[i]!
    grid.text(y + i, Math.max(0, Math.floor((state.cols - s.length) / 2)), s, i === 0 ? UI.warn : UI.dim, undefined, i === 0 ? ATTR_BOLD : ATTR_DIM)
  }
}

/** Pure render: ScreenState → fresh Grid (composition root for one frame). */
export function renderScreen(state: ScreenState): Grid {
  const grid = createGrid(state.cols, state.rows)
  if (state.tooSmall) {
    drawTooSmall(grid, state)
    return grid
  }
  const geo = computeGeometry(state)
  const ctx: Ctx = { grid, state, geo }
  drawStory(ctx)
  drawSidebar(ctx, geo)
  drawBottom(ctx)
  if (state.over) drawOver(ctx)
  return grid
}
