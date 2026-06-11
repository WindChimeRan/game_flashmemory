/**
 * positions() — diff two layouts into per-segment moves for FLIP tweening
 * on the character grid (OOM_DESIGN.md §2.2/§5.1, contract in types.ts).
 *
 * Each segment is represented by the (row, col) of its FIRST placement in
 * reading order — for hard-sliced segments that is the first slice, so a
 * sliced segment contributes at most one entry. Segments present in both
 * layouts at the same position are omitted. Consumed spaces and 'break'
 * segments have no placements, so they only ever appear as entered/exited
 * when their visibility changes.
 *
 * Ordering is deterministic: `moved` and `entered` follow `after`'s reading
 * order; `exited` follows `before`'s reading order.
 */

import type { Layout, PositionDiff, SegEnter, SegExit, SegMove } from './types'

interface Pos {
  row: number
  col: number
}

/** segId → (row, col) of its first placement, in reading order. */
function firstPlacements(lay: Layout): Map<number, Pos> {
  const m = new Map<number, Pos>()
  for (let row = 0; row < lay.lines.length; row++) {
    for (const pl of lay.lines[row]!.placements) {
      if (!m.has(pl.segId)) m.set(pl.segId, { row, col: pl.col })
    }
  }
  return m
}

export function positions(before: Layout, after: Layout): PositionDiff {
  const a = firstPlacements(before)
  const b = firstPlacements(after)
  const moved: SegMove[] = []
  const entered: SegEnter[] = []
  const exited: SegExit[] = []
  for (const [segId, pos] of b) {
    const old = a.get(segId)
    if (old === undefined) {
      entered.push({ segId, toRow: pos.row, toCol: pos.col })
    } else if (old.row !== pos.row || old.col !== pos.col) {
      moved.push({ segId, fromRow: old.row, fromCol: old.col, toRow: pos.row, toCol: pos.col })
    }
  }
  for (const [segId, pos] of a) {
    if (!b.has(segId)) exited.push({ segId, fromRow: pos.row, fromCol: pos.col })
  }
  return { moved, entered, exited }
}
