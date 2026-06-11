/**
 * RecencyBot (§7) — the paper's Recency-Only control. Keeps only the newest
 * chunks: every tick it tier-downs the OLDEST non-protected chunk above chip.
 * Pure housekeeping, zero prediction — it must die to anti-recency waves
 * (standard waves demand aged, cold glyphs it threw away).
 */

import type { Action, ChunkView, OracleView, SimView } from '../sim'
import { canDown, down, type OomBot } from './common'

export class RecencyBot implements OomBot {
  readonly name = 'recency'

  reset(_seed: number): void {
    // stateless
  }

  act(view: SimView, _oracle: OracleView | null): Action[] {
    let oldest: ChunkView | null = null
    for (const c of view.chunks) {
      if (canDown(c) && (oldest === null || c.id < oldest.id)) oldest = c
    }
    return oldest ? [down(oldest)] : []
  }
}
