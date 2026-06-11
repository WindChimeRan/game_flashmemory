/**
 * pretext-tui — contracts for the layout engine (OOM_DESIGN.md §5.1).
 *
 * OWNED BY THE INTEGRATOR — implementation work must not edit this file.
 *
 * The Pretext architecture, ported to cells (§2.2 of the design doc):
 *   1. prepare/append — expensive pass: grapheme segmentation + cell width
 *      measurement, run once per text (incrementally on append).
 *   2. layout — cheap pure arithmetic line-breaking, incremental on append.
 *   3. positions — diff two layouts into per-segment moves, feeding FLIP
 *      tweens on the character grid.
 *
 * INVARIANTS (tested):
 * - Stable IDs: a Segment's id never changes across append() or layout();
 *   ids are never reused within one Prepared lineage.
 * - Purity: layout(p, w) depends only on (p.segments, w). Same inputs ⇒
 *   deeply equal outputs.
 * - Incrementality is invisible: layout(p, w, prevLayout) ≡ layout(p, w)
 *   (property-tested; prev is only a speed hint).
 * - Every non-'space' segment appears in exactly one Placement (or, if
 *   wider than the wrap width, in a contiguous run of sliced Placements
 *   covering all its cells exactly once).
 * - Line width never exceeds the wrap width (a single over-wide grapheme
 *   of width 2 at width 1 is the one tolerated exception).
 *
 * Wrapping rules:
 * - Break opportunities: after 'space' segments, after each CJK/wide word
 *   segment (prepare() emits each wide-char grapheme run as breakable
 *   units), and at 'break' segments (hard newlines).
 * - A 'space' segment that lands at a line end is consumed (zero width on
 *   that line, no placement); spaces never start a wrapped line.
 * - 'break' segments end the current line and have no placement.
 * - A word wider than the wrap width is hard-sliced at grapheme
 *   boundaries; each slice gets a Placement with `slice` set.
 */

export type SegmentKind = 'word' | 'space' | 'break'

export interface Segment {
  /** Stable, unique within a Prepared lineage; monotonically assigned. */
  readonly id: number
  readonly kind: SegmentKind
  /** Raw text. 'break' segments hold the newline character(s). */
  readonly text: string
  /** Total cell width (from src/shared/width.ts). 0 for 'break'. */
  readonly width: number
}

export interface Prepared {
  readonly segments: readonly Segment[]
  /** Monotonic; bumped by append(). Layouts record the version they saw. */
  readonly version: number
}

export interface Placement {
  readonly segId: number
  /** 0-based start column of this placement within its line. */
  readonly col: number
  /** Cells this placement occupies on the line. */
  readonly width: number
  /**
   * Only for hard-sliced over-wide words: the grapheme-cell range
   * [fromCell, toCell) of the segment that this placement renders.
   */
  readonly slice?: readonly [number, number]
}

export interface Line {
  readonly placements: readonly Placement[]
  /** Used cells on this line (≤ layout width). */
  readonly width: number
}

export interface Layout {
  readonly lines: readonly Line[]
  /** Wrap width this layout was computed for. */
  readonly width: number
  /** Prepared.version this layout reflects. */
  readonly version: number
}

export interface SegMove {
  readonly segId: number
  readonly fromRow: number
  readonly fromCol: number
  readonly toRow: number
  readonly toCol: number
}
export interface SegEnter {
  readonly segId: number
  readonly toRow: number
  readonly toCol: number
}
export interface SegExit {
  readonly segId: number
  readonly fromRow: number
  readonly fromCol: number
}

/**
 * positions(before, after): for segments present in both layouts and whose
 * (row, col) changed → moved; only in after → entered; only in before →
 * exited. Sliced segments are represented by their FIRST placement.
 * Unmoved segments are omitted.
 */
export interface PositionDiff {
  readonly moved: readonly SegMove[]
  readonly entered: readonly SegEnter[]
  readonly exited: readonly SegExit[]
}

/**
 * Implementation surface (src/pretext/index.ts re-exports):
 *
 *   prepare(text: string): Prepared
 *   append(p: Prepared, text: string): Prepared
 *     - Re-segments only the tail: if the last segment is a 'word' with no
 *       following space, it may be REPLACED (same id reused is forbidden —
 *       the old id is retired and a fresh id assigned) when the appended
 *       text extends that word. Document the chosen strategy in code; the
 *       invariant that matters: ids of all segments before the last
 *       whitespace boundary are untouched.
 *   layout(p: Prepared, width: number, prev?: Layout): Layout
 *     - With prev (same width, prev.version ≤ p.version): recompute only
 *       from the first line that could differ; reuse earlier lines.
 *   positions(before: Layout, after: Layout): PositionDiff
 *
 * Width helpers come from src/shared/width.ts — do not reimplement.
 */
export const PRETEXT_CONTRACT_VERSION = 1
