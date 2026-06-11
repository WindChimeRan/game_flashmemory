/**
 * layout() — pure-arithmetic greedy line breaking over prepared segments
 * (OOM_DESIGN.md §5.1, contract in src/pretext/types.ts).
 *
 * Wrapping rules implemented exactly per the contract:
 * - Break opportunities exist after 'space' segments, after each wide-unit
 *   word segment (a single width-2 grapheme: CJK glyph / emoji — emitted as
 *   such by prepare()), and at 'break' segments. Consecutive word segments
 *   with no break opportunity between them form an unbreakable CHUNK (e.g.
 *   "abc" + "日" glue; "日" + "本" do not).
 * - Space segments are held PENDING and placed only when the next word
 *   chunk fits after them on the same line; otherwise they are consumed
 *   (no placement). This uniformly yields "a space landing at a line end is
 *   consumed" and "spaces never start a wrapped line", while preserving
 *   leading indentation after hard breaks (those spaces are placed when the
 *   following word fits, and on a line with no visible content the chunk is
 *   placed without opening a spurious blank line).
 * - 'break' segments end the line, have no placement; the final line is
 *   always emitted, so "\n\n" yields a preserved blank line and "" yields a
 *   single empty line.
 * - A chunk wider than the wrap width starts on a fresh line and is
 *   hard-sliced at grapheme boundaries from col 0. Each segment split
 *   across lines gets one Placement per line with `slice: [fromCell,
 *   toCell)` covering its cells exactly once; a segment of the chunk that
 *   happens to fit entirely on one line gets a normal placement (no slice).
 *   A single width-2 grapheme at width 1 is placed anyway — the contract's
 *   one tolerated overflow.
 *
 * Incremental path (prev as a speed hint, REQUIRED to be invisible:
 * layout(p, w, prev) ≡ layout(p, w) by deep equality):
 * - prepare()'s journal chain gives D = the first segment index that may
 *   differ between prev.version and p.version (Infinity ⇒ no change ⇒ prev's
 *   lines are returned as-is). Every layout is tagged with the chain node it
 *   was built against; walking p's chain back to prev's node both collects D
 *   and PROVES prev belongs to this exact lineage branch — a prev from a
 *   different prepare(), a sibling branch, or a hand-built object fails the
 *   walk and triggers a full layout instead of silently wrong reuse.
 * - Greedy breaking is memoryless at line starts (col 0, no pending), so a
 *   per-Layout anchor table (WeakMap side cache) records for every line the
 *   index of the first segment it processed, whether it starts clean (not
 *   mid-slice), and why the previous line ended. Line f-1's construction
 *   looked at segments < anchor(f).seg, plus — when it ended by wrapping —
 *   the overflowing chunk that starts line f. We therefore reuse lines
 *   0..f-1 for the deepest f whose anchor is clean and whose dependency
 *   bound is < D ('break'-ended: anchor.seg ≤ D; 'wrap'-ended: chunk end
 *   < D), and recompute from anchor(f).seg. The final line always ends at
 *   EOF and is always recomputed. Anything missing (no journal, no anchor
 *   table, width mismatch) falls back to a full layout — correctness never
 *   depends on the caches.
 */

import { cellWidth, graphemes } from '../shared/width'
import type { Layout, Line, Placement, Prepared, Segment } from './types'
import { chainOf, type Chain } from './prepare'

/** Why a line ended ('start' marks the first line of a layout run). */
type EndReason = 'start' | 'break' | 'wrap'

interface Anchor {
  /** Index of the first segment processed for this line. */
  seg: number
  /** False when the line begins inside a hard-sliced over-wide chunk. */
  clean: boolean
  /** How the previous line ended ('start' for the first line). */
  prevEnd: EndReason
}

const anchorsCache = new WeakMap<Layout, readonly Anchor[]>()
/** Journal node each layout was built against (lineage-branch witness). */
const chainTag = new WeakMap<Layout, Chain>()
const wideUnitCache = new WeakMap<Segment, boolean>()
const graphemeWidthsCache = new WeakMap<Segment, readonly number[]>()

/**
 * A word segment that is one single width-2 grapheme (CJK glyph, emoji):
 * the contract's break-after point. Narrow words can also have width 2
 * ("ab"), so the (cached) grapheme count disambiguates.
 */
function isWideUnit(seg: Segment): boolean {
  if (seg.kind !== 'word' || seg.width !== 2) return false
  let v = wideUnitCache.get(seg)
  if (v === undefined) {
    v = graphemes(seg.text).length === 1
    wideUnitCache.set(seg, v)
  }
  return v
}

/** Per-grapheme cell widths of a segment (cached; only sliced words pay). */
function graphemeWidths(seg: Segment): readonly number[] {
  let v = graphemeWidthsCache.get(seg)
  if (v === undefined) {
    v = graphemes(seg.text).map(cellWidth)
    graphemeWidthsCache.set(seg, v)
  }
  return v
}

/**
 * End of the unbreakable chunk starting at word index `i`: consecutive word
 * segments glue together unless the left one is a wide unit (break-after).
 */
function chunkEndAt(segments: readonly Segment[], i: number): number {
  let e = i + 1
  while (e < segments.length && segments[e]!.kind === 'word' && !isWideUnit(segments[e - 1]!)) e++
  return e
}

interface RunResult {
  lines: Line[]
  anchors: Anchor[]
}

/** Greedy-wrap segments[start..] at `width`, starting on a fresh line. */
function layoutRun(
  segments: readonly Segment[],
  start: number,
  width: number,
  firstPrevEnd: EndReason
): RunResult {
  const lines: Line[] = []
  const anchors: Anchor[] = []
  let placements: Placement[] = []
  let col = 0
  let anchor: Anchor = { seg: start, clean: true, prevEnd: firstPrevEnd }
  // Space segment indexes whose fate is undecided (see module header).
  let pending: number[] = []
  let pendingW = 0

  const endLine = (reason: EndReason, nextSeg: number, clean: boolean): void => {
    lines.push({ placements, width: col })
    anchors.push(anchor)
    placements = []
    col = 0
    anchor = { seg: nextSeg, clean, prevEnd: reason }
  }
  const dropPending = (): void => {
    pending = []
    pendingW = 0
  }
  const placePending = (): void => {
    for (const pi of pending) {
      const s = segments[pi]!
      placements.push({ segId: s.id, col, width: s.width })
      col += s.width
    }
    dropPending()
  }
  const placeWhole = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      const s = segments[k]!
      placements.push({ segId: s.id, col, width: s.width })
      col += s.width
    }
  }
  /** Hard-slice chunk [from, to) (wider than `width`) from the current col. */
  const sliceChunk = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      const s = segments[k]!
      const gws = graphemeWidths(s)
      let parts = 0
      let runCol = col
      let runFrom = 0 // cell offset within s where the current run began
      let cells = 0 // cells of s consumed so far (cumulative grapheme widths)
      for (const gw of gws) {
        if (col + gw > width && col > 0) {
          if (cells > runFrom) {
            placements.push({ segId: s.id, col: runCol, width: cells - runFrom, slice: [runFrom, cells] })
            parts++
          }
          endLine('wrap', k, false)
          runCol = 0
          runFrom = cells
        }
        // col === 0 && gw > width: the tolerated exception (width-2 grapheme
        // at width 1) — place it; the line will report its true width.
        col += gw
        cells += gw
      }
      if (parts === 0) {
        // Never split: one whole placement, no slice (covers all cells).
        placements.push({ segId: s.id, col: runCol, width: cells })
      } else if (cells > runFrom) {
        placements.push({ segId: s.id, col: runCol, width: cells - runFrom, slice: [runFrom, cells] })
      }
    }
  }

  let i = start
  while (i < segments.length) {
    const seg = segments[i]!
    if (seg.kind === 'break') {
      dropPending() // trailing spaces land at the line end → consumed
      endLine('break', i + 1, true)
      i++
    } else if (seg.kind === 'space') {
      pending.push(i)
      pendingW += seg.width
      i++
    } else {
      const e = chunkEndAt(segments, i)
      let chunkW = 0
      for (let k = i; k < e; k++) chunkW += segments[k]!.width
      if (col + pendingW + chunkW <= width) {
        placePending()
        placeWhole(i, e)
      } else if (chunkW <= width) {
        dropPending() // consumed: they may not start the wrapped line
        if (col > 0) endLine('wrap', i, true)
        placeWhole(i, e)
      } else {
        dropPending()
        if (col > 0) endLine('wrap', i, true)
        sliceChunk(i, e)
      }
      i = e
    }
  }
  dropPending() // trailing spaces land at the line end → consumed
  lines.push({ placements, width: col })
  anchors.push(anchor)
  return { lines, anchors }
}

function tagged(lay: Layout, p: Prepared): Layout {
  const node = chainOf(p)
  if (node !== undefined) chainTag.set(lay, node)
  return lay
}

function fullLayout(p: Prepared, w: number): Layout {
  const run = layoutRun(p.segments, 0, w, 'start')
  const lay: Layout = { lines: run.lines, width: w, version: p.version }
  anchorsCache.set(lay, run.anchors)
  return tagged(lay, p)
}

/**
 * Walk p's journal chain back to the node prev was built against, collecting
 * the minimum dirty index along the way. Returns undefined when prev is not
 * an ancestor state of p on this exact branch (then reuse would be unsound).
 */
function dirtySince(p: Prepared, prev: Layout): number | undefined {
  const target = chainTag.get(prev)
  let node = chainOf(p)
  if (target === undefined || node === undefined) return undefined
  let dirty = Infinity
  while (node !== undefined && node !== target && node.version > target.version) {
    if (node.dirty < dirty) dirty = node.dirty
    node = node.parent
  }
  return node === target ? dirty : undefined
}

function tryIncremental(p: Prepared, w: number, prev: Layout): Layout | undefined {
  const dirty = dirtySince(p, prev)
  if (dirty === undefined) return undefined // not this lineage branch
  if (dirty === Infinity) {
    // Provably no segment changed since prev was computed.
    if (prev.version === p.version) return prev
    const lay: Layout = { lines: prev.lines, width: w, version: p.version }
    const anchors = anchorsCache.get(prev)
    if (anchors !== undefined) anchorsCache.set(lay, anchors)
    return tagged(lay, p)
  }
  if (dirty <= 0) return undefined
  const anchors = anchorsCache.get(prev)
  if (anchors === undefined || anchors.length !== prev.lines.length) return undefined
  // Deepest line f whose whole construction provably saw only segments with
  // index < dirty (the last line ends at EOF and is never reusable).
  let reuse = 0
  for (let f = prev.lines.length - 1; f >= 1; f--) {
    const a = anchors[f]!
    if (!a.clean || a.seg > p.segments.length) continue
    if (a.prevEnd === 'break') {
      if (a.seg <= dirty) {
        reuse = f
        break
      }
    } else if (a.prevEnd === 'wrap') {
      const s = p.segments[a.seg]
      if (s !== undefined && s.kind === 'word' && chunkEndAt(p.segments, a.seg) < dirty) {
        reuse = f
        break
      }
    }
  }
  if (reuse === 0) return undefined
  const a = anchors[reuse]!
  const run = layoutRun(p.segments, a.seg, w, a.prevEnd)
  const lay: Layout = {
    lines: prev.lines.slice(0, reuse).concat(run.lines),
    width: w,
    version: p.version,
  }
  anchorsCache.set(lay, anchors.slice(0, reuse).concat(run.anchors))
  return tagged(lay, p)
}

/**
 * Wrap `p` at `width` cells. With `prev` (same width, prev.version ≤
 * p.version, from the same lineage), lines that cannot have changed are
 * reused and computation restarts at the first potentially-dirty line; the
 * result is deeply equal to the from-scratch layout in all cases.
 */
export function layout(p: Prepared, width: number, prev?: Layout): Layout {
  // Defensive width guard: integer ≥ 1 (Infinity allowed: no wrapping).
  const w = width >= 1 ? Math.floor(width) : 1
  if (prev !== undefined && prev.width === w && prev.version <= p.version) {
    const inc = tryIncremental(p, w, prev)
    if (inc !== undefined) return inc
  }
  return fullLayout(p, w)
}
