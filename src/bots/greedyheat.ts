/**
 * GreedyHeatBot (§7) — acts on the CURRENT heat channel only (heat +
 * consensus pips), no lookahead, no telegraph reading, no future knowledge:
 * the in-game analog of the paper's per-step indexer.
 *
 * - Tier-up the hottest non-expanded chunk once its heat crosses `upHeat`
 *   (1-pip chunks — likely distractors — are skipped unless ≥ hotOverride).
 *   One fetch per glyph at a time; glyphs already serving at expanded are
 *   skipped (the wave is satisfied by any chunk of the glyph).
 * - Tier-down the coldest non-protected chunk when viewport pressure
 *   exceeds `evictAt` (and always when the stream is about to OOM).
 */

import type { Action, ChunkView, OracleView, SimView } from '../sim'
import { busFree, canDown, canUp, down, effTier, headroom, pressure, up, upFits, type OomBot } from './common'

export interface GreedyHeatOptions {
  upHeat?: number
  hotOverride?: number
  evictAt?: number
  panicHeadroom?: number
}

export class GreedyHeatBot implements OomBot {
  readonly name = 'greedy-heat'
  private readonly upHeat: number
  private readonly hotOverride: number
  private readonly evictAt: number
  private readonly panicHeadroom: number

  constructor(opts?: GreedyHeatOptions) {
    this.upHeat = opts?.upHeat ?? 0.55
    this.hotOverride = opts?.hotOverride ?? 0.8
    this.evictAt = opts?.evictAt ?? 0.7
    this.panicHeadroom = opts?.panicHeadroom ?? 2
  }

  reset(_seed: number): void {
    // stateless
  }

  /** Coldest evictable chunk: heat asc, then frees-most, then oldest. */
  private victim(view: SimView): ChunkView | null {
    let pick: ChunkView | null = null
    for (const c of view.chunks) {
      if (!canDown(c)) continue
      if (
        pick === null ||
        c.heat < pick.heat ||
        (c.heat === pick.heat && (c.linesNow > pick.linesNow ||
          (c.linesNow === pick.linesNow && c.id < pick.id)))
      )
        pick = c
    }
    return pick
  }

  act(view: SimView, _oracle: OracleView | null): Action[] {
    // 0. Panic eviction — never let the stream OOM us.
    if (headroom(view) <= this.panicHeadroom) {
      const v = this.victim(view)
      if (v) return [down(v)]
    }

    // 1. Fetch the hottest believable chunk. Glyph-level state (not future
    //    knowledge): skip glyphs already expanded / heading there / mid-fetch.
    const glyphBusy = new Set<string>()
    for (const c of view.chunks) {
      if (effTier(c) === 2 || c.transfer) glyphBusy.add(c.glyph)
    }
    let cand: ChunkView | null = null
    for (const c of view.chunks) {
      if (!canUp(c) || glyphBusy.has(c.glyph)) continue
      if (c.heat < this.upHeat) continue
      if (c.pips < 2 && c.heat < this.hotOverride) continue // 1-pip = likely distractor
      if (
        cand === null ||
        c.heat > cand.heat ||
        (c.heat === cand.heat && (c.tier > cand.tier ||
          (c.tier === cand.tier && (c.linesByTier[2] < cand.linesByTier[2] ||
            (c.linesByTier[2] === cand.linesByTier[2] && c.id < cand.id)))))
      )
        cand = c
    }
    if (cand && busFree(view) > 0 && upFits(view, cand, 2)) return [up(cand)]

    // 2. Pressure relief (also clears room when a wanted fetch didn't fit).
    if (pressure(view) > this.evictAt || (cand && !upFits(view, cand, 2))) {
      const v = this.victim(view)
      if (v) return [down(v)]
    }
    return []
  }
}
