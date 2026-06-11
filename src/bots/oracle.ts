/**
 * OracleBot (§7) — the skill ceiling. Sees OracleView (all committed waves,
 * including not-yet-telegraphed, plus per-chunk next-demand times).
 *
 * Per tick it rebuilds a fetch plan:
 *  1. For every future demand, pick the best chunk per needed glyph
 *     (sufficiency-aware: bosses only need ceil(frac·|G|) expanded) and
 *     compute its serial chain latency from the current tier.
 *  2. Simulate the B-slot bus schedule in latest-start-time order with
 *     starts serialized at 1/tick; each job gets a projected start, finish,
 *     and slack vs its landTick.
 *  3. Issue a start only when its SUFFIX of the schedule (itself or anything
 *     queued behind it, which its delay would push) has shrunk to the safety
 *     margin (just-in-time starts keep residency low); under contention this
 *     degrades to ASAP starts. Bus-full rejections retry next tick because
 *     the plan is recomputed from scratch.
 *  4. Evict far-future / never-demanded chunks (distractors first — their
 *     next demand is Infinity) when pressure > evictAt, when a due fetch is
 *     blocked on headroom, or when the maxResidency cap needs room.
 *
 * `maxResidency` (0..1): skip expansions that would push instantaneous
 * residency above the cap — the §4.4 oracle-sweep calibration mode.
 */

import type { Action, ChunkView, OracleView, SimConfig, SimView } from '../sim'
import { busFree, canDown, down, headroom, needOf, pressure, up, upDelta, type OomBot } from './common'

export interface OracleOptions {
  /** Residency cap 0..1 (calibration sweeps); 1 = viewport is the only cap. */
  maxResidency?: number
  /** Aim to finish fetches this many ticks before landing. */
  safety?: number
  /** Extra slack beyond safety at which starts are released (JIT band). */
  jitGrace?: number
  /** Background eviction pressure threshold. */
  evictAt?: number
  panicHeadroom?: number
}

interface Job {
  glyph: string
  chunkId: number
  /** Earliest tick the first action can be processed. */
  gate: number
  /** Busy span from processed start to arrival at the target tier. */
  lat: number
  land: number
  /** True when this fetch can only reach summary by land (partial credit). */
  degraded: boolean
  cost: number
  /** Projected start tick under the B-slot + 1-action/tick schedule. */
  start: number
  slack: number
}

export class OracleBot implements OomBot {
  readonly name: string
  readonly wantsOracle = true
  private readonly maxResidency: number
  private readonly safety: number
  private readonly jitGrace: number
  private readonly evictAt: number
  private readonly panicHeadroom: number
  private L_c2s = 40
  private L_warm = 14
  private B = 2

  constructor(opts?: OracleOptions) {
    this.maxResidency = Math.min(1, Math.max(0, opts?.maxResidency ?? 1))
    this.safety = opts?.safety ?? 8
    this.jitGrace = opts?.jitGrace ?? 4
    // Default tuned on seeds 1000..1019: disciplined eviction (0.40) beats
    // the lazier 0.75 on EVERY axis — credit 0.99, residency 0.39, pareto
    // 0.61, aps 0.73 — because only all-chip aged glyphs are wave-eligible,
    // so tidy shelves keep the director's wave stream (and score) flowing.
    this.evictAt = opts?.evictAt ?? 0.4
    this.panicHeadroom = opts?.panicHeadroom ?? 2
    this.name = this.maxResidency < 1 ? `oracle@${this.maxResidency}` : 'oracle'
  }

  configure(cfg: SimConfig): void {
    this.L_c2s = cfg.L_c2s
    this.L_warm = cfg.L_warm
    this.B = cfg.B
  }

  reset(_seed: number): void {
    // plan is rebuilt every tick from the oracle view
  }

  /** Chain latency from a processed start, by starting tier. */
  private chainLat(tier: number): number {
    return tier === 0 ? this.L_c2s + 1 + this.L_warm : tier === 1 ? this.L_warm : 0
  }

  /** Build the per-glyph fetch jobs for all future demands (EDF order). */
  private buildJobs(view: SimView, oracle: OracleView, now: number): Job[] {
    const waves = oracle.allWaves
      .filter((w) => w.landTick > now)
      .sort((a, b) => a.landTick - b.landTick || a.id - b.id)
    const byGlyph = new Map<string, ChunkView[]>()
    for (const c of view.chunks) {
      let arr = byGlyph.get(c.glyph)
      if (!arr) byGlyph.set(c.glyph, (arr = []))
      arr.push(c)
    }
    const planned = new Map<string, number>() // glyph → projected expanded tick
    const jobs: Job[] = []

    for (const w of waves) {
      const need = needOf(w.sufficientExpandedFrac, w.glyphs.length)
      let served = 0
      const pending: { glyph: string; opt: Job | null }[] = []
      for (const g of w.glyphs) {
        const mine = byGlyph.get(g) ?? []
        const servedNow =
          mine.some((c) => c.tier === 2) ||
          mine.some((c) => c.transfer?.toTier === 2 && c.transfer.arriveTick <= w.landTick)
        const plannedTick = planned.get(g)
        if (servedNow || (plannedTick !== undefined && plannedTick <= w.landTick)) {
          served++
          continue
        }
        pending.push({ glyph: g, opt: this.bestOption(g, mine, w.landTick, now) })
      }
      if (served >= need) continue
      // Cheapest viable options first; full fetches outrank degraded ones.
      pending.sort((a, b) => {
        const ka = a.opt === null ? 2 : a.opt.degraded ? 1 : 0
        const kb = b.opt === null ? 2 : b.opt.degraded ? 1 : 0
        if (ka !== kb) return ka - kb
        if (a.opt && b.opt)
          return a.opt.lat - b.opt.lat || a.opt.cost - b.opt.cost || a.opt.chunkId - b.opt.chunkId
        return a.glyph < b.glyph ? -1 : 1
      })
      for (const p of pending) {
        if (served >= need) break
        if (!p.opt) continue
        jobs.push(p.opt)
        planned.set(p.glyph, p.opt.gate + p.opt.lat)
        if (!p.opt.degraded) served++
      }
    }
    return jobs
  }

  /** Best fetch option for one glyph against one landTick (null = hopeless). */
  private bestOption(glyph: string, mine: readonly ChunkView[], land: number, now: number): Job | null {
    let best: Job | null = null
    const consider = (j: Job): void => {
      if (
        best === null ||
        (best.degraded && !j.degraded) ||
        (best.degraded === j.degraded &&
          (j.lat < best.lat || (j.lat === best.lat && (j.cost < best.cost ||
            (j.cost === best.cost && j.chunkId < best.chunkId)))))
      )
        best = j
    }
    for (const c of mine) {
      if (c.protected) continue
      const cost = c.linesByTier[2]
      if (c.transfer) {
        // Mid-chain to summary: the warm continuation is the job.
        if (c.transfer.toTier === 1) {
          const gate = c.transfer.arriveTick + 1
          if (gate + this.L_warm <= land)
            consider({ glyph, chunkId: c.id, gate, lat: this.L_warm, land, degraded: false, cost, start: 0, slack: 0 })
        }
        continue
      }
      const gate = now + 1
      if (c.tier === 1) {
        if (gate + this.L_warm <= land)
          consider({ glyph, chunkId: c.id, gate, lat: this.L_warm, land, degraded: false, cost, start: 0, slack: 0 })
      } else if (c.tier === 0) {
        if (gate + this.chainLat(0) <= land)
          consider({ glyph, chunkId: c.id, gate, lat: this.chainLat(0), land, degraded: false, cost, start: 0, slack: 0 })
        else if (gate + this.L_c2s <= land)
          consider({ glyph, chunkId: c.id, gate, lat: this.L_c2s, land, degraded: true, cost, start: 0, slack: 0 })
      }
    }
    return best
  }

  /** Greedy B-slot schedule; fills job.start/job.slack. Jobs are ordered by
   *  LATEST-START-TIME (land − lat; full jobs first) — for equal lands this
   *  is the old longest-chain-first rule, and across lands it lets a tight
   *  long chain claim a slot before a slack-rich short warm leg. Starts of
   *  gate-ready jobs are additionally serialized at one per tick (the bot
   *  can release only one action per tick), so a band-cluster's 2nd/3rd job
   *  sees its true, later start — and therefore its true, smaller slack. */
  private schedule(view: SimView, jobs: Job[], now: number): void {
    const slots: number[] = []
    for (const c of view.chunks) if (c.transfer) slots.push(c.transfer.arriveTick + 1)
    slots.sort((a, b) => a - b)
    while (slots.length < this.B) slots.push(now + 1)
    while (slots.length > this.B) slots.pop()

    jobs.sort(
      (a, b) =>
        Number(a.degraded) - Number(b.degraded) ||
        a.land - a.lat - (b.land - b.lat) ||
        a.land - b.land ||
        a.cost - b.cost ||
        a.chunkId - b.chunkId,
    )
    let cursor = now + 1 // next tick an 'up' action can be processed
    for (const j of jobs) {
      let si = 0
      for (let i = 1; i < slots.length; i++) if (slots[i]! < slots[si]!) si = i
      const base = Math.max(slots[si]!, j.gate)
      if (j.gate <= now + 1 && base <= cursor) {
        j.start = cursor
        cursor++
      } else {
        j.start = base // slot- or gate-bound future start; no action needed yet
      }
      const finish = j.start + j.lat
      slots[si] = finish + 1
      j.slack = j.land - finish
    }
  }

  /** Eviction victim: farthest next demand first (∞ = distractor / never),
   *  then frees-most, then oldest. Skips chunks needed soon and the chunks
   *  the current plan is about to fetch. */
  private victim(
    view: SimView,
    oracle: OracleView,
    now: number,
    keep: ReadonlySet<number>,
    relax: boolean,
  ): ChunkView | null {
    let pick: ChunkView | null = null
    let pickDemand = -1
    for (const c of view.chunks) {
      if (!canDown(c) || keep.has(c.id)) continue
      const d = oracle.nextDemandByChunk.get(c.id) ?? Infinity
      if (!relax && d !== Infinity) {
        // Re-fetch latency if we tier this chunk down one step now.
        const refetch = c.tier === 2 ? this.L_warm + 1 : this.chainLat(0) + 1
        if (d - now <= refetch + this.safety + 8) continue
      }
      if (
        pick === null ||
        d > pickDemand ||
        (d === pickDemand && (c.linesNow > pick.linesNow ||
          (c.linesNow === pick.linesNow && c.id < pick.id)))
      ) {
        pick = c
        pickDemand = d
      }
    }
    return pick
  }

  act(view: SimView, oracle: OracleView | null): Action[] {
    if (!oracle) return []
    const now = view.tick
    const meters = view.meters
    const jobs = this.buildJobs(view, oracle, now)
    this.schedule(view, jobs, now)
    const keep = new Set<number>(jobs.map((j) => j.chunkId))

    let needRoom = false

    // Release a job when the JIT band is hit by its SUFFIX — itself or any
    // job scheduled behind it, since delaying this start delays everything
    // queued after it on the slots/action cursor. A per-job-slack trigger
    // strands pipelines (a boss's 3rd chain queued on a busy slot can be 40
    // ticks late while the two front chains still sit outside their own
    // band); a global min-slack trigger over FULL jobs only (the original)
    // (a) never fired when only degraded jobs remained, silently dropping
    // banked partial credit, and (b) released in EDF order, spending the
    // urgent chain's last tick on a slack-rich earlier-landing warm leg.
    const band = this.safety + this.jitGrace
    // suffixTight[i]: jobs[i..] contains a job with slack ≤ band. Monotone
    // (non-increasing along i), so the release loop can stop at the first
    // position whose whole suffix is slack-rich.
    const suffixTight: boolean[] = new Array<boolean>(jobs.length)
    for (let i = jobs.length - 1, t = false; i >= 0; i--) {
      if (jobs[i]!.slack <= band) t = true
      suffixTight[i] = t
    }
    for (let i = 0; i < jobs.length; i++) {
      if (!suffixTight[i]) break // everything from here has room to wait
      const j = jobs[i]!
      if (j.start > now + 1) continue // slot/gate/cursor-bound: not yet
      const c = view.chunks[j.chunkId]
      if (!c || c.transfer || c.tier >= 2) continue
      if (busFree(view) <= 0) break // bus saturated; retry next tick
      const delta = upDelta(c)
      if (meters.viewportUsed + delta > meters.viewportBudget * this.maxResidency) {
        needRoom = true // calibration cap: try to evict into compliance
        continue
      }
      if (meters.viewportUsed + delta > meters.viewportBudget - 1) {
        needRoom = true
        continue
      }
      return [up(c)]
    }

    // Eviction: panic, blocked fetch, calibration cap, or background pressure.
    const evictThreshold = Math.min(this.evictAt, this.maxResidency)
    const panic = headroom(view) <= this.panicHeadroom
    if (panic || needRoom || pressure(view) > evictThreshold) {
      const v = this.victim(view, oracle, now, keep, false) ??
        (panic || needRoom ? this.victim(view, oracle, now, keep, true) : null)
      if (v) return [down(v)]
      if (panic) {
        // Last resort: even planned chunks beat an OOM.
        const v2 = this.victim(view, oracle, now, new Set(), true)
        if (v2) return [down(v2)]
      }
    }
    return []
  }
}
