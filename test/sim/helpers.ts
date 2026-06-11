/**
 * Test drivers: a seeded random action script (determinism tests) and a
 * greedy EDF oracle executor (feasibility / heat / zen / collapse tests).
 * The executor is written independently of the director's internal greedy
 * so the feasibility invariant is checked end-to-end, not circularly.
 */

import type { Action, OracleView, Sim, SimConfig } from '../../src/sim'
import { makeRng } from '../../src/sim'

/** Per-tick action lists, generated once from a seed (mostly invalid on purpose). */
export function scriptedActions(seed: number, ticks: number, maxChunkId = 40): Action[][] {
  const rng = makeRng(seed)
  const out: Action[][] = []
  for (let t = 0; t < ticks; t++) {
    const acts: Action[] = []
    const n = rng.next() < 0.45 ? rng.int(1, 2) : 0
    for (let i = 0; i < n; i++) {
      const kind = (['up', 'down', 'pin'] as const)[rng.int(0, 2)]!
      acts.push({ kind, chunkId: rng.int(0, maxChunkId) })
    }
    out.push(acts)
  }
  return out
}

/**
 * Greedy earliest-deadline-first executor with eviction pressure relief.
 * - Serves every unresolved wave (oracle.allWaves): expands the best chunk
 *   of each still-needed glyph, bus/budget permitting.
 * - Evicts the largest non-demanded, non-protected chunk when the viewport
 *   nears its budget (or when a fetch is blocked on headroom).
 */
export function edfExecutor(cfg: SimConfig) {
  return (oracle: OracleView): Action[] => {
    const actions: Action[] = []
    const budget = cfg.actionBudget
    const demanded = new Set<string>()
    for (const w of oracle.allWaves) for (const g of w.glyphs) demanded.add(g)

    const used = oracle.meters.viewportUsed
    const headroom = oracle.meters.viewportBudget - used
    let bus = oracle.meters.busInFlight

    const evictable = oracle.chunks
      .filter((c) => c.tier > 0 && !c.protected && !c.pinned && !c.transfer && !demanded.has(c.glyph))
      .sort((a, b) => b.linesNow - a.linesNow || a.id - b.id) // biggest first

    const pushEvict = (): boolean => {
      const c = evictable.shift()
      if (!c) return false
      actions.push({ kind: 'down', chunkId: c.id })
      return true
    }

    // Urgent pressure first: stream adds lines every few ticks.
    if (headroom <= 2) {
      while (actions.length < budget && pushEvict()) { /* relieve */ }
    }

    // EDF fetches.
    const waves = [...oracle.allWaves].sort((a, b) => a.landTick - b.landTick || a.id - b.id)
    for (const w of waves) {
      if (actions.length >= budget) break
      const need = Math.max(1, Math.ceil(w.sufficientExpandedFrac * w.glyphs.length))
      // glyphs already expanded or in flight to expanded count as handled
      let handled = 0
      const pending: string[] = []
      for (const g of w.glyphs) {
        const mine = oracle.chunks.filter((c) => c.glyph === g)
        const servedNow = mine.some((c) => c.tier === 2)
        const arriving = mine.some((c) => c.transfer?.toTier === 2 && c.transfer.arriveTick <= w.landTick)
        // chip→summary in flight whose warm leg can still land in time: that
        // chain is progress — do NOT burn a second bus slot on the same glyph.
        const chaining = mine.some(
          (c) => c.transfer?.toTier === 1 && c.transfer.arriveTick + 1 + cfg.L_warm <= w.landTick,
        )
        if (servedNow || arriving || chaining) handled++
        else pending.push(g)
      }
      // prefer warmest pending glyphs (fewest legs left)
      pending.sort((a, b) => {
        const tier = (g: string): number =>
          Math.max(-1, ...oracle.chunks.filter((c) => c.glyph === g).map((c) => (c.transfer ? c.transfer.toTier : c.tier)))
        return tier(b) - tier(a) || (a < b ? -1 : 1)
      })
      for (const g of pending) {
        if (handled >= need || actions.length >= budget || bus >= cfg.B) break
        const cands = oracle.chunks
          .filter((c) => c.glyph === g && !c.transfer && c.tier < 2 && !c.protected)
          .sort((a, b) => b.tier - a.tier || a.linesNow - b.linesNow || a.id - b.id)
        const c = cands[0]
        if (!c) continue
        const delta = (c.tier === 1 ? c.linesByTier[2] : 1) - c.linesNow
        if (delta > headroom - 1) {
          // blocked on headroom → trade an eviction for it
          if (actions.length < budget) pushEvict()
          continue
        }
        actions.push({ kind: 'up', chunkId: c.id })
        bus++
        handled++
      }
    }

    // Spare budget → keep residency low. This also matters for pacing: only
    // all-chip aged glyphs are standard-wave-eligible, so disciplined
    // eviction is what keeps the director's wave stream flowing.
    while (actions.length < budget && pushEvict()) { /* tidy */ }

    return actions.slice(0, budget)
  }
}

/** Simple evictor: relentlessly tiers down the oldest unprotected chunk. */
export function evictor() {
  return (oracle: OracleView): Action[] => {
    const c = oracle.chunks
      .filter((k) => k.tier > 0 && !k.protected && !k.pinned && !k.transfer)
      .sort((a, b) => a.id - b.id)[0]
    return c ? [{ kind: 'down', chunkId: c.id }] : []
  }
}

/** Advance with no actions until pred(sim) holds; throws if it never does. */
export function tickUntil(sim: Sim, pred: (sim: Sim) => boolean, maxTicks = 5000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (pred(sim)) return
    if (sim.done) throw new Error(`tickUntil: sim ended at t${sim.tickNow} before predicate held`)
    sim.tick([])
  }
  throw new Error(`tickUntil: predicate never held within ${maxTicks} ticks`)
}

/** Run a sim to completion (or maxTicks) with a per-tick driver. */
export function run(
  sim: Sim,
  driver: (oracle: OracleView) => Action[],
  onTick?: (events: ReturnType<Sim['tick']>, sim: Sim) => void,
  maxTicks = 100000,
): void {
  for (let i = 0; i < maxTicks && !sim.done; i++) {
    const events = sim.tick(driver(sim.oracleView()))
    onTick?.(events, sim)
  }
}
