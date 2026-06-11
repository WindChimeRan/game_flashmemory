/**
 * ReactiveBot (§7, gate #2 adversary) — the strongest HEAT-BLIND member of
 * the reactive family.
 *
 * Doctrine (2026-06-11, formulation amendment pending human review): gate #2
 * exists to falsify "telegraphs alone suffice" (the §4.3 whack-a-mole hole).
 * A bot that times commitments off the heat ramp is doing PREDICTION, not
 * reaction — so heat/pips are out of bounds here (that strategy is ParBot,
 * src/bots/par.ts, the gate-4 human-par probe). A reactive bot may read:
 *   - telegraphs (view.waves) and rules knowledge (latencies via configure)
 *   - public non-predictive state: tiers, transfers, viewport/bus meters,
 *     chunk ages, line costs, summary decay counters
 * and NEVER chunk.heat / chunk.pips (enforced by a Proxy probe in
 * test/bots/heatblind.test.ts). Blind hedging — summary walls built from no
 * predictive signal — is allowed.
 *
 * Strategy (strongest blind variant per the 2026-06-11 A/B, PLAYTEST.md):
 *
 * REACT     EDF over telegraphed waves, sufficiency-capped (stop fetching
 *           once enough glyphs are expanded/scheduled to hit the credit
 *           override): expand summaries via the warm path; cold chains /
 *           partial-credit legs only when the latency math says they land
 *           (rules knowledge, no heat). Bus-full ⇒ retry next tick (intent
 *           is recomputed); headroom-block ⇒ evict and retry.
 * WALL      blind hedge wall: keep warmth (≥1 live summary, or any
 *           expanded/in-flight chunk) per covered glyph. Maintained almost
 *           entirely by FREE tier-downs — a chunk leaving the protected
 *           strip is downed expanded→summary, which both sheds lines and
 *           becomes the wall. Cold up-legs are repair only (post-panic /
 *           post-decay), priced by the bus. Wall policies (A/B'd):
 *             'none'      pure telegraph play, no wall (control)
 *             'uniform'   one summary per glyph, always
 *             'recency'   one summary per each of the K most recently
 *                         spawned glyphs only
 *             'eligible'  one summary per glyph unless the glyph already
 *                         has a non-summary blocker (expanded / in-flight
 *                         chunk) or is too young to matter (youngest chunk
 *                         age < stdMinAge − lead) — the minimal-residency
 *                         wall
 * HOUSEKEEP always-on tier-downs: idle expanded chunks (post-wave teardown),
 *           dup summaries beyond the wall, summaries the policy does not
 *           want. Keeps residency at the wall floor at all times.
 * PANIC     headroom ≤ panicHeadroom ⇒ shed lines, sacrificing wall pieces
 *           in safest-first order (excess → glyph-still-blocked → youngest
 *           glyph) and telegraphed chunks only as the last resort.
 *
 * Decay-aware (summaryTTL): a wall summary whose remaining life is below
 * rehedgeLead is treated as already gone, so a replacement leg starts before
 * the gap opens; Phase-REACT futility treats a summary that decays before
 * the action processes as the chip it is about to become.
 */

import type { Action, ChunkView, OracleView, SimConfig, SimView, WaveView } from '../sim'
import { busFree, canDown, canUp, down, headroom, needOf, pressure, up, upFits, type OomBot } from './common'

export type BlindWallPolicy = 'none' | 'uniform' | 'recency' | 'eligible'

export interface ReactiveOptions {
  /** Blind hedge-wall policy (see header). Default: strongest from the A/B. */
  wall?: BlindWallPolicy
  /** 'recency' wall: cover the K most recently spawned glyphs. */
  recencyGlyphs?: number
  /** 'eligible' wall: cover once youngest chunk age ≥ stdMinAge − lead. */
  eligibleLead?: number
  /** Repair up-legs allowed only while pressure < this. */
  hedgeCap?: number
  /** Repair up-legs allowed only while busFree > this. */
  hedgeBusReserve?: number
  panicHeadroom?: number
  /** Finite summaryTTL: treat a summary with remaining life below this as
   *  gone (seamless wall repair). Irrelevant at summaryTTL = Infinity. */
  rehedgeLead?: number
}

interface GlyphStat {
  glyph: string
  youngest: number // min ageTicks across the glyph's chunks
  /** Non-summary warmth: an expanded chunk or any up-transfer in flight —
   *  blocks std-wave eligibility on its own, no wall summary needed. */
  blocker: boolean
  /** Any live (not dying) idle summary. */
  liveSummary: boolean
  /** Best live idle summary to KEEP (cheapest expanded cost, then id). */
  keep: ChunkView | null
  /** Best chip for a repair up-leg (cheapest expanded cost, then id). */
  upCand: ChunkView | null
}

export class ReactiveBot implements OomBot {
  readonly name = 'reactive'
  private readonly wall: BlindWallPolicy
  private readonly recencyGlyphs: number
  private readonly eligibleLead: number
  private readonly hedgeCap: number
  private readonly hedgeBusReserve: number
  private readonly panicHeadroom: number
  private readonly rehedgeLeadOpt: number | null
  private L_c2s = 40
  private L_warm = 14
  private summaryTTL = Infinity
  private stdMinAge = 160

  constructor(opts?: ReactiveOptions) {
    // 'eligible' — strongest blind wall in the 2026-06-11 A/B (PLAYTEST.md):
    // same full wave-suppression as 'uniform' but sheds wall summaries while
    // a glyph is blocked anyway, for the lowest residency of the family.
    this.wall = opts?.wall ?? 'eligible'
    this.recencyGlyphs = opts?.recencyGlyphs ?? 6
    this.eligibleLead = opts?.eligibleLead ?? 50
    this.hedgeCap = opts?.hedgeCap ?? 0.92
    this.hedgeBusReserve = opts?.hedgeBusReserve ?? 0
    this.panicHeadroom = opts?.panicHeadroom ?? 2
    this.rehedgeLeadOpt = opts?.rehedgeLead ?? null
  }

  private rehedgeLead(): number {
    return this.rehedgeLeadOpt ?? this.L_c2s + 2
  }

  configure(cfg: SimConfig): void {
    this.L_c2s = cfg.L_c2s
    this.L_warm = cfg.L_warm
    this.summaryTTL = cfg.summaryTTL
    this.stdMinAge = cfg.stdMinAge
  }

  reset(_seed: number): void {
    // desire-based: no per-round state beyond configure()
  }

  // ── glyph bookkeeping (no heat, no pips) ─────────────────────────────

  private dying(c: ChunkView): boolean {
    return c.tier === 1 && !c.transfer && this.summaryTTL - c.summaryAgeTicks < this.rehedgeLead()
  }

  private glyphStats(view: SimView): Map<string, GlyphStat> {
    const stats = new Map<string, GlyphStat>()
    for (const c of view.chunks) {
      let s = stats.get(c.glyph)
      if (!s) {
        s = { glyph: c.glyph, youngest: Infinity, blocker: false, liveSummary: false, keep: null, upCand: null }
        stats.set(c.glyph, s)
      }
      if (c.ageTicks < s.youngest) s.youngest = c.ageTicks
      if (c.tier === 2 || c.transfer) s.blocker = true
      if (c.tier === 1 && !c.transfer && !this.dying(c)) {
        s.liveSummary = true
        if (
          s.keep === null ||
          c.linesByTier[2] < s.keep.linesByTier[2] ||
          (c.linesByTier[2] === s.keep.linesByTier[2] && c.id < s.keep.id)
        )
          s.keep = c
      }
      if (c.tier === 0 && canUp(c)) {
        if (
          s.upCand === null ||
          c.linesByTier[2] < s.upCand.linesByTier[2] ||
          (c.linesByTier[2] === s.upCand.linesByTier[2] && c.id < s.upCand.id)
        )
          s.upCand = c
      }
    }
    return stats
  }

  /** Does the wall policy want warmth kept on this glyph? */
  private covered(s: GlyphStat, stats: Map<string, GlyphStat>): boolean {
    switch (this.wall) {
      case 'none':
        return false
      case 'uniform':
        return true
      case 'recency': {
        // K most recently spawned glyphs (smallest youngest-age first).
        let rank = 0
        for (const o of stats.values()) {
          if (o.glyph === s.glyph) continue
          if (o.youngest < s.youngest || (o.youngest === s.youngest && o.glyph < s.glyph)) rank++
        }
        return rank < this.recencyGlyphs
      }
      case 'eligible':
        // A blocker keeps the glyph ineligible for free; a glyph whose
        // youngest chunk is far from stdMinAge is ineligible by age.
        return !s.blocker && s.youngest >= this.stdMinAge - this.eligibleLead
    }
  }

  // ── REACT (telegraph response, EDF, sufficiency-capped) ──────────────

  private react(view: SimView, now: number): Action | 'blocked' | null {
    const waves: WaveView[] = [...view.waves].sort((a, b) => a.landTick - b.landTick || a.id - b.id)
    let blocked = false
    for (const w of waves) {
      if (w.landTick <= now) continue
      const need = needOf(w.sufficientExpandedFrac, w.glyphs.length)
      let served = 0
      const pending: { glyph: string; mine: ChunkView[] }[] = []
      for (const g of w.glyphs) {
        const mine = view.chunks.filter((c) => c.glyph === g)
        const full =
          mine.some((c) => c.tier === 2) ||
          mine.some((c) => c.transfer?.toTier === 2 && c.transfer.arriveTick <= w.landTick) ||
          // chip→summary in flight whose warm continuation still lands in
          // time: the full chain is scheduled (continuation issued on arrival).
          mine.some((c) => c.transfer?.toTier === 1 && c.transfer.arriveTick + 1 + this.L_warm <= w.landTick)
        if (full) {
          served++
          continue
        }
        // A partial leg already in flight (summary by land, no time for the
        // continuation): banked partial credit — don't double-fetch.
        if (mine.some((c) => c.transfer !== null && c.transfer.arriveTick <= w.landTick)) continue
        pending.push({ glyph: g, mine })
      }
      if (served >= need) continue // sufficiency hit: extra fetches buy nothing
      // Cheapest viable first: warm candidates before cold, small expansions
      // before large (more served glyphs per line and per bus-tick).
      const bestTier = (p: { mine: ChunkView[] }): number =>
        p.mine.reduce((m, c) => (canUp(c) && c.tier > m ? c.tier : m), -1)
      const bestCost = (p: { mine: ChunkView[] }): number =>
        p.mine.reduce((m, c) => (canUp(c) && c.linesByTier[2] < m ? c.linesByTier[2] : m), Infinity)
      pending.sort(
        (a, b) =>
          bestTier(b) - bestTier(a) ||
          bestCost(a) - bestCost(b) ||
          (a.glyph < b.glyph ? -1 : 1),
      )
      for (const p of pending) {
        const cands = p.mine
          .filter((c) => canUp(c))
          .sort((a, b) => b.tier - a.tier || a.linesByTier[2] - b.linesByTier[2] || a.id - b.id)
        for (const c of cands) {
          // Futility check (rules knowledge): an action processed next tick
          // must still improve the credit served at landTick. A summary that
          // decays before the action processes (summaryTTL) is really a
          // chip: the up issued now lands on the decayed chip next tick.
          const stillSummary = c.tier === 1 && c.summaryAgeTicks + 1 <= this.summaryTTL
          const worth = stillSummary
            ? now + 1 + this.L_warm <= w.landTick
            : now + 2 + this.L_c2s + this.L_warm <= w.landTick || // full chain
              now + 1 + this.L_c2s <= w.landTick // partial credit at summary
          if (!worth) continue
          if (busFree(view) <= 0) return blocked ? 'blocked' : null // retry next tick
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

  // ── HOUSEKEEP / PANIC downs ───────────────────────────────────────────

  /** Ordered tier-down candidates, safest/most-valuable first:
   *   1. idle expanded, non-telegraphed (sheds most; also builds the wall —
   *      the down lands at summary)
   *   2. summaries the wall does not need: dups beyond `keep`, uncovered
   *      glyphs — then (relax) wall pieces on glyphs that are still blocked
   *      or young, then aged wall pieces (eligibility risk last)
   *   3. (panic only) telegraphed chunks — survival outranks the wave. */
  private downCandidates(
    view: SimView,
    telegraphed: ReadonlySet<string>,
    stats: Map<string, GlyphStat>,
    relax: boolean,
    panic: boolean,
  ): ChunkView | null {
    let exp: ChunkView | null = null
    for (const c of view.chunks) {
      if (!canDown(c) || c.tier !== 2 || telegraphed.has(c.glyph)) continue
      if (
        exp === null ||
        c.linesNow > exp.linesNow ||
        (c.linesNow === exp.linesNow && (c.ageTicks > exp.ageTicks ||
          (c.ageTicks === exp.ageTicks && c.id < exp.id)))
      )
        exp = c
    }
    if (exp) return exp

    // Summary candidates, scored by sacrifice safety.
    let pick: ChunkView | null = null
    let pickScore = -1
    for (const c of view.chunks) {
      if (!canDown(c) || c.tier !== 1 || telegraphed.has(c.glyph)) continue
      const s = stats.get(c.glyph)!
      const cov = this.covered(s, stats)
      // 3 = excess (uncovered / dup beyond `keep` / dying while other warmth
      // stands — a dying LAST summary is spared: chipping it would open the
      // eligibility gap before its replacement leg lands), 2 = wall but the
      // glyph is blocked elsewhere anyway, 1 = wall on a young glyph, 0 =
      // aged wall (a down here opens std-wave eligibility — last resort).
      const excess =
        !cov ||
        (s.keep !== null && s.keep.id !== c.id) ||
        (this.dying(c) && (s.liveSummary || s.blocker))
      const score = excess
        ? 3
        : s.blocker
          ? 2
          : s.youngest < this.stdMinAge - this.eligibleLead
            ? 1
            : 0
      if (!relax && score < 3) continue // housekeeping touches only excess
      if (
        score > pickScore ||
        (score === pickScore && pick !== null && (c.ageTicks > pick.ageTicks ||
          (c.ageTicks === pick.ageTicks && c.id < pick.id)))
      ) {
        pick = c
        pickScore = score
      }
    }
    if (pick) return pick

    if (panic) {
      // Last resort: telegraphed chunks beat an OOM.
      let any: ChunkView | null = null
      for (const c of view.chunks) {
        if (!canDown(c)) continue
        if (
          any === null ||
          c.linesNow > any.linesNow ||
          (c.linesNow === any.linesNow && c.id < any.id)
        )
          any = c
      }
      return any
    }
    return null
  }

  // ── WALL repair up-legs ───────────────────────────────────────────────

  private wallRepair(view: SimView, telegraphed: ReadonlySet<string>, stats: Map<string, GlyphStat>): Action | null {
    if (pressure(view) >= this.hedgeCap || busFree(view) <= this.hedgeBusReserve) return null
    let best: GlyphStat | null = null
    for (const s of stats.values()) {
      if (telegraphed.has(s.glyph)) continue // react owns telegraphed glyphs
      if (s.blocker || s.liveSummary || s.upCand === null) continue // warm already / nothing to up
      if (!this.covered(s, stats)) continue
      // Most urgent first: closest to (or past) std-wave eligibility age.
      if (best === null || s.youngest > best.youngest ||
        (s.youngest === best.youngest && s.glyph < best.glyph))
        best = s
    }
    if (best && upFits(view, best.upCand!, 2)) return up(best.upCand!)
    return null
  }

  // ── act ───────────────────────────────────────────────────────────────

  act(view: SimView, _oracle: OracleView | null): Action[] {
    const now = view.tick
    const telegraphed = new Set<string>()
    for (const w of view.waves) for (const g of w.glyphs) telegraphed.add(g)
    const stats = this.glyphStats(view)

    // PANIC — never OOM; sacrifice wall pieces safest-first.
    if (headroom(view) <= this.panicHeadroom) {
      const v = this.downCandidates(view, telegraphed, stats, true, true)
      if (v) return [down(v)]
    }

    // REACT — imminent telegraphed demands outrank everything.
    const r = this.react(view, now)
    if (r !== null && r !== 'blocked') return [r]
    if (r === 'blocked') {
      const v = this.downCandidates(view, telegraphed, stats, true, false)
      if (v) return [down(v)]
    }

    // WALL repair — cold legs when warmth is missing on a covered glyph.
    // Before housekeeping: repair starts are rare and deadline-bound (a
    // dying summary's replacement must launch rehedgeLead before the gap).
    const w = this.wallRepair(view, telegraphed, stats)
    if (w) return [w]

    // HOUSEKEEP — always-on: shed idle expandeds (the down IS the wall) and
    // summaries the wall policy does not want.
    const h = this.downCandidates(view, telegraphed, stats, false, false)
    return h ? [down(h)] : []
  }
}
