/**
 * Game-test helpers: an injectable FakeTerm (Term contract over fake
 * streams), grid → string snapshots, and ScreenState fixture builders.
 */

import type { Grid, InputEvent, KeyEvent, Term } from '../../src/term'
import { CellGrid } from '../../src/term/grid'
import type { ChunkView, Meters, SimView, TransferState, WaveView } from '../../src/sim'
import type { ScreenState } from '../../src/game/screen'

// ── fake term ─────────────────────────────────────────────────────────────

export class FakeTerm implements Term {
  cols: number
  rows: number
  readonly supportsTruecolor = true
  droppedFrames = 0
  started = 0
  stopped = 0
  invalidated = 0
  flushes = 0
  /** Deep snapshot of the last flushed grid. */
  last: CellGrid | null = null
  private handlers = new Set<(e: InputEvent) => void>()

  constructor(cols = 100, rows = 30) {
    this.cols = cols
    this.rows = rows
  }

  start(): void {
    this.started++
  }
  stop(): void {
    this.stopped++
  }
  onInput(fn: (e: InputEvent) => void): () => void {
    this.handlers.add(fn)
    return () => this.handlers.delete(fn)
  }
  flush(grid: Grid): void {
    this.flushes++
    const snap = new CellGrid(grid.cols, grid.rows)
    snap.copyFrom(grid as CellGrid)
    this.last = snap
  }
  invalidate(): void {
    this.invalidated++
  }

  emit(e: InputEvent): void {
    for (const fn of [...this.handlers]) fn(e)
  }
  key(name: string, mods: Partial<Pick<KeyEvent, 'ctrl' | 'alt' | 'shift'>> = {}): void {
    this.emit({ kind: 'key', name, ctrl: false, alt: false, shift: false, seq: name, ...mods })
  }
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.emit({ kind: 'resize', cols, rows })
  }
}

// ── grid snapshots ────────────────────────────────────────────────────────

/** Characters of each row (wide-char continuations dropped), right-trimmed. */
export function gridRows(grid: Grid): string[] {
  const out: string[] = []
  for (let r = 0; r < grid.rows; r++) {
    let line = ''
    for (let c = 0; c < grid.cols; c++) line += grid.get(r, c).ch
    out.push(line.replace(/\s+$/, ''))
  }
  return out
}

export function gridText(grid: Grid): string {
  return gridRows(grid).join('\n')
}

/** One rectangular region as right-trimmed rows. */
export function gridRegion(grid: Grid, row0: number, col0: number, w: number, h: number): string[] {
  const out: string[] = []
  for (let r = row0; r < row0 + h; r++) {
    let line = ''
    for (let c = col0; c < col0 + w; c++) line += grid.get(r, c).ch
    out.push(line.replace(/\s+$/, ''))
  }
  return out
}

// ── fixture builders ──────────────────────────────────────────────────────

export interface ChunkSpecLite {
  id: number
  glyph: string
  tier: 0 | 1 | 2
  heat?: number
  pips?: number
  pinned?: boolean
  protected?: boolean
  transfer?: TransferState | null
  tokensShown?: number
  tokensTotal?: number
  linesExpanded?: number
}

export function chunk(c: ChunkSpecLite): ChunkView {
  const tokensTotal = c.tokensTotal ?? 55
  const tokensShown = c.tokensShown ?? tokensTotal
  const expanded = c.linesExpanded ?? 5
  const linesByTier = [0, 1, expanded] as const
  const transfer = c.transfer ?? null
  const base = c.tier === 0 ? 0 : c.tier === 1 ? 1 : expanded
  const linesNow = transfer ? Math.max(base, transfer.toTier === 0 ? 0 : transfer.toTier === 1 ? 1 : expanded) : base
  return {
    id: c.id,
    glyph: c.glyph,
    tier: c.tier,
    heat: c.heat ?? 0.5,
    pips: c.pips ?? 1,
    pinned: c.pinned ?? false,
    protected: c.protected ?? false,
    transfer,
    linesByTier,
    linesNow,
    ageTicks: 100,
    tokensShown,
    tokensTotal,
  }
}

export function wave(w: Partial<WaveView> & { id: number; glyphs: readonly string[] }): WaveView {
  return {
    archetype: 'standard',
    telegraphTick: 100,
    landTick: 136,
    sufficientExpandedFrac: 1,
    ...w,
  }
}

export function meters(m: Partial<Meters> = {}): Meters {
  return {
    viewportUsed: 21,
    viewportBudget: 34,
    coherence: 78,
    score: 1240,
    streak: 3,
    busInFlight: 1,
    busCap: 2,
    residencyMean: 0.43,
    ...m,
  }
}

export function simView(v: Partial<SimView> & { chunks: readonly ChunkView[] }): SimView {
  return {
    tick: 112,
    waves: [],
    meters: meters(),
    zenActive: false,
    cliffActive: false,
    done: false,
    ...v,
  }
}

export function screenState(s: Partial<ScreenState> & { view: SimView }): ScreenState {
  return {
    cols: 100,
    rows: 30,
    prose: new Map(),
    focusId: null,
    paused: false,
    flash: null,
    confirmQuit: false,
    corruptUntilTick: -1,
    tweens: null,
    title: 'default · seed 7',
    ticksPerSec: 10,
    over: null,
    tooSmall: false,
    ...s,
  }
}
