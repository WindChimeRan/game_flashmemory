/**
 * ReactiveBot (§7, v1.1) — the STRONGEST reactive player gate #2 certifies
 * against. It uses rules knowledge (latencies via configure()) and the
 * present view only: NO future knowledge, NO heat-trend inference beyond the
 * prescribed hedge trigger.
 *
 * Phase A (hedge):  while used/budget < hedgeCap, keep one summary per glyph
 *                   whose current max heat ≥ hedgeHeat — warm hedges are the
 *                   only way a reactive player can beat L_cold > telegraph.
 * Phase B (react):  on telegraph, expand the best chunk per demanded glyph
 *                   ASAP, earliest landTick first; futile transfers (cannot
 *                   even improve credit by land) are skipped; rejected
 *                   actions are retried because intent is recomputed per tick.
 * Phase C (evict):  aggressive tier-downs of non-telegraphed chunks under
 *                   pressure or when a Phase-B fetch is blocked on headroom.
 *                   evictAt sits BELOW hedgeCap so Phase C keeps pressure in
 *                   the band where Phase A still works (see ReactiveOptions).
 */

import type { Action, ChunkView, OracleView, SimConfig, SimView, WaveView } from '../sim'
import { busFree, canDown, canUp, down, headroom, pressure, up, upFits, type OomBot } from './common'

export interface ReactiveOptions {
  hedgeHeat?: number
  hedgeCap?: number
  /** MUST stay below hedgeCap: if eviction only engages above the hedge cap,
   *  pressure equilibrates in the dead zone between them where the bot
   *  neither hedges nor evicts — wave glyphs then stay cold and the bot
   *  bleeds to collapse (measured: evictAt 0.75 > hedgeCap 0.6 ⇒ 99.4% surv
   *  / 0.39 credit; evictAt 0.5 ⇒ 100% / 0.89 over 100 seeds). */
  evictAt?: number
  panicHeadroom?: number
}

export class ReactiveBot implements OomBot {
  readonly name = 'reactive'
  private readonly hedgeHeat: number
  private readonly hedgeCap: number
  private readonly evictAt: number
  private readonly panicHeadroom: number
  private L_c2s = 40
  private L_warm = 14

  constructor(opts?: ReactiveOptions) {
    this.hedgeHeat = opts?.hedgeHeat ?? 0.3
    this.hedgeCap = opts?.hedgeCap ?? 0.6
    this.evictAt = opts?.evictAt ?? 0.5
    this.panicHeadroom = opts?.panicHeadroom ?? 2
  }

  configure(cfg: SimConfig): void {
    this.L_c2s = cfg.L_c2s
    this.L_warm = cfg.L_warm
  }

  reset(_seed: number): void {
    // desire-based: no per-round state beyond configure()
  }

  /** Phase C victim: prefer non-telegraphed, frees-most, coldest, oldest. */
  private victim(view: SimView, telegraphed: ReadonlySet<string>, any: boolean): ChunkView | null {
    let pick: ChunkView | null = null
    const better = (c: ChunkView, p: ChunkView | null): boolean =>
      p === null ||
      c.linesNow > p.linesNow ||
      (c.linesNow === p.linesNow && (c.heat < p.heat || (c.heat === p.heat && c.id < p.id)))
    for (const c of view.chunks) {
      if (!canDown(c) || telegraphed.has(c.glyph)) continue
      if (better(c, pick)) pick = c
    }
    if (pick === null && any) {
      for (const c of view.chunks) {
        if (!canDown(c)) continue
        if (better(c, pick)) pick = c
      }
    }
    return pick
  }

  /** Phase B: first worthwhile expand toward a telegraphed wave, EDF order.
   *  Returns the action, or 'blocked' when only headroom stands in the way. */
  private react(view: SimView, now: number): Action | 'blocked' | null {
    const waves: WaveView[] = [...view.waves].sort((a, b) => a.landTick - b.landTick || a.id - b.id)
    let blocked = false
    for (const w of waves) {
      if (w.landTick <= now) continue
      for (const g of w.glyphs) {
        const mine = view.chunks.filter((c) => c.glyph === g)
        if (mine.some((c) => c.tier === 2)) continue // served
        if (mine.some((c) => c.transfer?.toTier === 2 && c.transfer.arriveTick <= w.landTick)) continue
        // chip→summary in flight whose warm leg still lands in time: progress.
        if (mine.some((c) => c.transfer?.toTier === 1 && c.transfer.arriveTick + 1 + this.L_warm <= w.landTick)) continue
        const cands = mine
          .filter((c) => canUp(c))
          .sort((a, b) => b.tier - a.tier || a.linesByTier[2] - b.linesByTier[2] || a.id - b.id)
        for (const c of cands) {
          // Futility check (rules knowledge): an action processed next tick
          // must still improve the credit served at landTick.
          const worth =
            c.tier === 1
              ? now + 1 + this.L_warm <= w.landTick
              : now + 2 + this.L_c2s + this.L_warm <= w.landTick || // full chain
                now + 1 + this.L_c2s <= w.landTick // partial credit at summary
          if (!worth) continue
          if (busFree(view) <= 0) return blocked ? 'blocked' : null // bus saturated: retry next tick
          if (!upFits(view, c, 2)) {
            blocked = true
            continue
          }
          return up(c)
        }
      }
    }
    return blocked ? 'blocked' : null
  }

  /** Phase A: hedge one summary per hot glyph (hottest, best-corroborated first). */
  private hedge(view: SimView, telegraphed: ReadonlySet<string>): Action | null {
    if (pressure(view) >= this.hedgeCap || busFree(view) <= 0) return null
    const byGlyph = new Map<string, { heat: number; pips: number; warm: boolean; cand: ChunkView | null }>()
    for (const c of view.chunks) {
      let s = byGlyph.get(c.glyph)
      if (!s) {
        s = { heat: 0, pips: 0, warm: false, cand: null }
        byGlyph.set(c.glyph, s)
      }
      if (c.heat > s.heat) s.heat = c.heat
      if (c.pips > s.pips) s.pips = c.pips
      if (c.tier >= 1 || c.transfer) s.warm = true // hedge present or in progress
      if (c.tier === 0 && canUp(c)) {
        if (
          s.cand === null ||
          c.linesByTier[2] < s.cand.linesByTier[2] ||
          (c.linesByTier[2] === s.cand.linesByTier[2] && c.id < s.cand.id)
        )
          s.cand = c
      }
    }
    const hot = [...byGlyph.entries()]
      .filter(([g, s]) => !telegraphed.has(g) && !s.warm && s.heat >= this.hedgeHeat && s.cand !== null)
      .sort((a, b) => b[1].pips - a[1].pips || b[1].heat - a[1].heat || (a[0] < b[0] ? -1 : 1))
    for (const [, s] of hot) {
      if (upFits(view, s.cand!, 2)) return up(s.cand!)
    }
    return null
  }

  act(view: SimView, _oracle: OracleView | null): Action[] {
    const now = view.tick
    const telegraphed = new Set<string>()
    for (const w of view.waves) for (const g of w.glyphs) telegraphed.add(g)

    // Panic eviction first — never OOM while reacting.
    if (headroom(view) <= this.panicHeadroom) {
      const v = this.victim(view, telegraphed, true)
      if (v) return [down(v)]
    }

    // Phase B: imminent demands outrank everything.
    const r = this.react(view, now)
    if (r !== null && r !== 'blocked') return [r]

    // Phase C: pressure relief / clear headroom for a blocked Phase-B fetch.
    if (r === 'blocked' || pressure(view) > this.evictAt) {
      const v = this.victim(view, telegraphed, r === 'blocked')
      if (v) return [down(v)]
    }

    // Phase A: hedging with whatever budget is left.
    const h = this.hedge(view, telegraphed)
    return h ? [h] : []
  }
}
