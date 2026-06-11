/**
 * Shared utilities for the pretext suite: seeded PRNG (mulberry32 — no
 * Math.random anywhere, determinism is a hard rule), random text generators
 * over mixed ASCII/CJK/emoji/combining/newline pools, contract-invariant
 * checkers (throw Error with context so fuzz loops stay fast), and a
 * renderer reconstructing visible line text from placements for goldens.
 */

import { cellWidth, graphemes } from '../../src/shared/width'
import type { Layout, Placement, Prepared, Segment } from '../../src/pretext'

// ---------------------------------------------------------------------------
// Seeded PRNG

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function int(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1))
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

// ---------------------------------------------------------------------------
// Random text generation

const ASCII_WORDS = [
  'fox', 'jumps', 'memory', 'cache', 'evict', 'prefetch', 'oom', 'a', 'bc',
  'wave', 'glyph', 'heat', 'indexer', 'k',
] as const
const CJK = ['日', '本', '語', '漢字', '中文流', 'テスト', '한국어'] as const
const EMOJI = ['😀', '👨‍👩‍👧‍👦', '🇺🇸', '🐈‍⬛', '✊🏿', '❤️'] as const
const COMBINING = ['café', 'naïve', 'é', 'äb', 'café'] as const
const SEPS = [' ', ' ', ' ', '  ', '\t', '\n', '\n\n', '\r\n', ''] as const

/** A word-ish chunk of text mixing all the scripts. */
export function randomPiece(rng: () => number): string {
  const n = int(rng, 1, 10)
  let out = ''
  for (let i = 0; i < n; i++) {
    const r = rng()
    if (r < 0.5) out += pick(rng, ASCII_WORDS)
    else if (r < 0.7) out += pick(rng, CJK)
    else if (r < 0.8) out += pick(rng, EMOJI)
    else out += pick(rng, COMBINING)
    if (i < n - 1) out += pick(rng, SEPS)
  }
  return out
}

/** Grapheme soup: deliberately nasty, includes lone marks, NBSP, ZWJ. */
export function randomSoup(rng: () => number, maxLen = 80): string {
  const pool = [
    'a', 'b', 'z', 'Q', '9', '.', '-', ' ', ' ', '\t', '\n', '\r\n',
    '日', '本', '語', '漢', 'ヲ', '한',
    '😀', '👨‍👩‍👧‍👦', '🇺🇸', '🇫', '✊🏿', '❤️',
    '\u0301', '\u0308', '\u200d', '\u00a0', '\u3000', '\u2028',
  ] as const
  const n = int(rng, 0, maxLen)
  let out = ''
  for (let i = 0; i < n; i++) out += pick(rng, pool)
  return out
}

// ---------------------------------------------------------------------------
// Invariant checkers (contract invariants (b), (c), (d))

function fail(msg: string, ctx: unknown): never {
  throw new Error(`${msg}\ncontext: ${JSON.stringify(ctx)}`)
}

/**
 * (b) Every word segment is placed exactly once, or hard-sliced into ≥2
 * contiguous placements covering [0, width) exactly once. Spaces are placed
 * at most once (never sliced); breaks never. No placement references an
 * unknown segment.
 */
export function checkCoverage(p: Prepared, lay: Layout): void {
  const known = new Map<number, Segment>()
  for (const s of p.segments) known.set(s.id, s)
  const bySeg = new Map<number, Placement[]>()
  for (const line of lay.lines) {
    for (const pl of line.placements) {
      if (!known.has(pl.segId)) fail('placement references unknown segment', pl)
      let arr = bySeg.get(pl.segId)
      if (arr === undefined) bySeg.set(pl.segId, (arr = []))
      arr.push(pl)
    }
  }
  for (const seg of p.segments) {
    const pls = bySeg.get(seg.id) ?? []
    if (seg.kind === 'break') {
      if (pls.length !== 0) fail('break segment has placements', { seg, pls })
    } else if (seg.kind === 'space') {
      if (pls.length > 1) fail('space segment placed more than once', { seg, pls })
      if (pls.length === 1 && (pls[0]!.slice !== undefined || pls[0]!.width !== seg.width))
        fail('space placement malformed', { seg, pls })
    } else if (pls.length === 0) {
      fail('word segment never placed', { seg })
    } else if (pls.length === 1 && pls[0]!.slice === undefined) {
      if (pls[0]!.width !== seg.width) fail('whole placement width mismatch', { seg, pls })
    } else {
      if (pls.length < 2) fail('lone placement carries a slice', { seg, pls })
      let at = 0
      for (const pl of pls) {
        if (pl.slice === undefined) fail('sliced segment has unsliced placement', { seg, pls })
        const [from, to] = pl.slice
        if (from !== at) fail('slice not contiguous', { seg, pls })
        if (to <= from) fail('empty slice', { seg, pls })
        if (pl.width !== to - from) fail('slice width mismatch', { seg, pls })
        at = to
      }
      if (at !== seg.width) fail('slices do not cover all cells', { seg, pls, at })
    }
  }
}

/**
 * (c) Placements tile each line contiguously from col 0, line.width is
 * their sum, and no line exceeds the wrap width except the one tolerated
 * case: a single width-2 grapheme at width 1.
 */
export function checkLineWidths(lay: Layout, width: number): void {
  for (let row = 0; row < lay.lines.length; row++) {
    const line = lay.lines[row]!
    let at = 0
    for (const pl of line.placements) {
      if (pl.col !== at) fail('placement not contiguous', { row, pl, at })
      at += pl.width
    }
    if (line.width !== at) fail('line width != sum of placements', { row, line })
    if (line.width > width && !(width === 1 && line.width === 2))
      fail('line exceeds wrap width', { row, line, width })
  }
}

/**
 * (d) Reading placements line by line, left to right, visits segments in
 * segment order (adjacent duplicates = slices of one segment), and every
 * word segment is visited.
 */
export function checkOrder(p: Prepared, lay: Layout): void {
  const indexOf = new Map<number, number>()
  p.segments.forEach((s, i) => indexOf.set(s.id, i))
  const seq: number[] = []
  for (const line of lay.lines) {
    for (const pl of line.placements) {
      const idx = indexOf.get(pl.segId)
      if (idx === undefined) fail('placement references unknown segment', pl)
      if (seq.length === 0 || seq[seq.length - 1] !== idx) seq.push(idx)
    }
  }
  for (let k = 1; k < seq.length; k++) {
    if (seq[k]! <= seq[k - 1]!) fail('placements out of segment order', { seq })
  }
  const placed = new Set(seq)
  p.segments.forEach((s, i) => {
    if (s.kind === 'word' && !placed.has(i)) fail('word segment missing from reading order', { s })
  })
}

/** All contract invariants at once (used by fuzz loops). */
export function checkAll(p: Prepared, lay: Layout, width: number): void {
  checkCoverage(p, lay)
  checkLineWidths(lay, width)
  checkOrder(p, lay)
}

// ---------------------------------------------------------------------------
// Rendering (for golden tests)

/**
 * Reconstruct the visible text of every line from placements. Sliced
 * placements re-walk the segment's graphemes by cell offset (zero-width
 * graphemes sitting exactly on a slice boundary are ambiguous — goldens
 * avoid that case).
 */
export function renderLines(p: Prepared, lay: Layout): string[] {
  const segs = new Map<number, Segment>()
  for (const s of p.segments) segs.set(s.id, s)
  return lay.lines.map((line) => {
    let out = ''
    for (const pl of line.placements) {
      const seg = segs.get(pl.segId)!
      if (pl.slice === undefined) {
        out += seg.text
      } else {
        const [from, to] = pl.slice
        let cells = 0
        for (const g of graphemes(seg.text)) {
          const w = cellWidth(g)
          if (cells >= from && cells + w <= to && (w > 0 || cells < to)) out += g
          cells += w
        }
      }
    }
    return out
  })
}
