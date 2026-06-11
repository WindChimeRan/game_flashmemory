/**
 * ParBot — the mechanical par for human play: heat + telegraphs, no future
 * knowledge. This is the heat-timed hybrid formerly fielded as ReactiveBot
 * (hedgeHeat 0.45, PLAYTEST.md 2026-06-10): it times cold legs off the heat
 * ramp ~56 ticks before a landing, so its chip→summary leg arrives just
 * after the telegraph and is expanded immediately — JIT staging with public
 * channels only.
 *
 * Doctrine (2026-06-11, pending human review): heat-timed commitment is
 * PREDICTION, not reaction — two information channels (heat + telegraph)
 * beating one (greedy's heat-only) is information theory, not a commitment
 * hole, so this bot is NOT a gate-2 adversary. It is the gate-4 human-like
 * tension probe (with greedy-heat) and the par line the score table shows
 * between greedy-heat and oracle. The gate-2 reactive family is heat-blind
 * (src/bots/reactive.ts).
 *
 * Phase A (hedge):  while used/budget < hedgeCap, keep one summary per glyph
 *                   whose current max heat ≥ hedgeHeat. Under summary-tier
 *                   decay (summaryTTL) the wall is no longer a one-time
 *                   purchase: hedges expire unless used, so Phase A
 *                   continuously re-hedges — seamlessly, starting a sibling
 *                   chip's replacement leg one L_c2s before a hedge dies
 *                   (rehedgeLead).
 * Phase B (react):  on telegraph, expand the best chunk per demanded glyph
 *                   ASAP, earliest landTick first; futile transfers (cannot
 *                   even improve credit by land) are skipped — including
 *                   summaries that decay before the action would process —
 *                   rejected actions are retried because intent is
 *                   recomputed per tick.
 * Phase C (evict):  aggressive tier-downs of non-telegraphed chunks under
 *                   pressure or when a Phase-B fetch is blocked on headroom.
 *                   evictAt sits BELOW hedgeCap so Phase C keeps pressure in
 *                   the band where Phase A still works (see ParOptions).
 */

import type { Action, ChunkView, OracleView, SimConfig, SimView, WaveView } from '../sim'
import { busFree, canDown, canUp, down, headroom, pressure, up, upFits, type OomBot } from './common'

export interface ParOptions {
  hedgeHeat?: number
  hedgeCap?: number
  /** MUST stay below hedgeCap: if eviction only engages above the hedge cap,
   *  pressure equilibrates in the dead zone between them where the bot
   *  neither hedges nor evicts — wave glyphs then stay cold and the bot
   *  bleeds to collapse (measured: evictAt 0.75 > hedgeCap 0.6 ⇒ 99.4% surv
   *  / 0.39 credit; evictAt 0.5 ⇒ 100% / 0.89 over 100 seeds). */
  evictAt?: number
  panicHeadroom?: number
  /** Decay-aware wall maintenance (summaryTTL): a hedge summary whose
   *  remaining life is below this is treated as already gone, so a sibling
   *  chip's replacement leg starts before the gap opens ("seamless"
   *  re-hedge). 0 = re-hedge only after the decay (purely reactive).
   *  Irrelevant at summaryTTL = Infinity. */
  rehedgeLead?: number
  /** Hedge only while busFree > this (reserve slots for telegraph
   *  reactions). 0 = hedging may take the last bus slot. */
  hedgeBusReserve?: number
}

export class ParBot implements OomBot {
  readonly name = 'par'
  private readonly hedgeHeat: number
  private readonly hedgeCap: number
  private readonly evictAt: number
  private readonly panicHeadroom: number
  private readonly rehedgeLeadOpt: number | null
  private readonly hedgeBusReserve: number
  private L_c2s = 40
  private L_warm = 14
  private summaryTTL = Infinity

  constructor(opts?: ParOptions) {
    // hedgeHeat 0.45 (was 0.3) — strongest-variant finding, 2026-06-10 decay
    // A/B (PLAYTEST.md): a hedge triggered at heat ≥ 0.45 starts its cold leg
    // ≈ 56 ticks before the landing, arrives at summary just after the
    // telegraph and is expanded immediately — pareto 0.45 vs 0.36 for the
    // old 0.3 wall (50 seeds @4000 and 100 @1000 agree; 0.45–0.48 is a
    // plateau, 0.5 falls off the L_warm cliff). Side effect: it parks
    // almost nothing at summary, so it is also the most decay-robust
    // heat-timed play — see the gate-2 escalation note in PLAYTEST.md.
    this.hedgeHeat = opts?.hedgeHeat ?? 0.45
    this.hedgeCap = opts?.hedgeCap ?? 0.6
    this.evictAt = opts?.evictAt ?? 0.5
    this.panicHeadroom = opts?.panicHeadroom ?? 2
    // Seamless re-hedging (lead = L_c2s + 2) is the strongest
    // wall-maintenance variant when summaries DO get parked; reserving a
    // bus slot for reactions lost more hedge throughput than it saved.
    this.rehedgeLeadOpt = opts?.rehedgeLead ?? null
    this.hedgeBusReserve = opts?.hedgeBusReserve ?? 0
  }

  /** Seamless re-hedge lead (defaults to a full replacement leg + slack). */
  private rehedgeLead(): number {
    return this.rehedgeLeadOpt ?? this.L_c2s + 2
  }

  configure(cfg: SimConfig): void {
    this.L_c2s = cfg.L_c2s
    this.L_warm = cfg.L_warm
    this.summaryTTL = cfg.summaryTTL
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
          // must still improve the credit served at landTick. A summary
          // that decays before the action processes (summaryTTL) is really
          // a chip: the up issued now lands on the decayed chip next tick.
          const stillSummary = c.tier === 1 && c.summaryAgeTicks + 1 <= this.summaryTTL
          const worth =
            stillSummary
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

  /** Phase A: hedge one summary per hot glyph (hottest, best-corroborated first).
   *  Decay-aware (summaryTTL): a summary whose remaining life is below the
   *  re-hedge lead no longer counts as a live hedge, so a sibling chip's
   *  replacement leg starts BEFORE the wall gap opens — the recurring bus
   *  + action spend that prices wall maintenance. */
  private hedge(view: SimView, telegraphed: ReadonlySet<string>): Action | null {
    if (pressure(view) >= this.hedgeCap || busFree(view) <= this.hedgeBusReserve) return null
    const byGlyph = new Map<string, { heat: number; pips: number; warm: boolean; cand: ChunkView | null }>()
    for (const c of view.chunks) {
      let s = byGlyph.get(c.glyph)
      if (!s) {
        s = { heat: 0, pips: 0, warm: false, cand: null }
        byGlyph.set(c.glyph, s)
      }
      if (c.heat > s.heat) s.heat = c.heat
      if (c.pips > s.pips) s.pips = c.pips
      const dying =
        c.tier === 1 && !c.transfer &&
        this.summaryTTL - c.summaryAgeTicks < this.rehedgeLead()
      if ((c.tier >= 1 && !dying) || c.transfer) s.warm = true // live hedge or in progress
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
