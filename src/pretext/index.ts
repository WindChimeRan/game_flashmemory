/**
 * pretext-tui — incremental, diffable text layout for terminal cells.
 * Public API per src/pretext/types.ts (the binding contract):
 *
 *   prepare(text)            → Prepared      (expensive pass, stable ids)
 *   append(prepared, text)   → Prepared      (tail-only re-segmentation)
 *   layout(prepared, width, prev?) → Layout  (greedy wrap, incremental)
 *   positions(before, after) → PositionDiff  (FLIP-ready move/enter/exit)
 */

export { prepare, append } from './prepare'
export { layout } from './layout'
export { positions } from './positions'
export { PRETEXT_CONTRACT_VERSION } from './types'
export type {
  SegmentKind,
  Segment,
  Prepared,
  Placement,
  Line,
  Layout,
  SegMove,
  SegEnter,
  SegExit,
  PositionDiff,
} from './types'
