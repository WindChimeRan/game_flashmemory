/**
 * Adversarial verifier suite — attacks on the contract's sharpest edges:
 *  1. rejected actions must be pure no-ops (no rng, no state, hash-identical);
 *  2. tick order: an arrival exactly AT landTick serves the wave (arrivals
 *     fire before resolution); one tick later must not;
 *  3. protected strip when fewer than protectedChunks chunks exist;
 *  4. greedyClearable: demands feasible alone but jointly infeasible must be
 *     rejected; in-flight bus occupancy honored to the exact tick;
 *  5. spawn suppression: a committed wave's glyphs are never respawned while
 *     pending, so zero-fetch play can never clear a standard wave (the §4.4
 *     "cold at telegraph" structure cannot be dodged by lucky respawns);
 *  6. needCount: fp-robust sufficiency thresholds.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULTS, createSim, greedyClearable,
  type Action, type ActiveDemand, type DirectorChunk, type DirectorWorld,
  type SimConfig, type Tier,
} from '../../src/sim'
import { needCount } from '../../src/sim/util'
import { edfExecutor, evictor, run, scriptedActions, tickUntil } from './helpers'

describe('rejected actions are pure no-ops', () => {
  test('garbage-injected run is hash-identical to the clean run, every tick', () => {
    const ticks = 1000
    const script = scriptedActions(0xdead, ticks)
    const a = createSim(DEFAULTS, 1234)
    const b = createSim(DEFAULTS, 1234)
    for (let t = 0; t < ticks; t++) {
      const real = script[t]!
      const evA = a.tick(real)

      // Build guaranteed-rejected garbage from B's own pre-tick view.
      const vb = b.view()
      const garbage: Action[] = [{ kind: 'down', chunkId: 4096 }] // no-such-chunk
      const newest = vb.chunks[vb.chunks.length - 1]
      if (newest) garbage.push({ kind: 'down', chunkId: newest.id }) // protected
      const transferring = vb.chunks.find((c) => c.transfer !== null)
      if (transferring) garbage.push({ kind: 'up', chunkId: transferring.id }) // transferring
      const evB = b.tick([{ kind: 'up', chunkId: 4096 }, ...real, ...garbage])

      // identical acceptance, identical state — rejections consumed nothing
      expect(evB.accepted).toEqual(evA.accepted)
      expect(evB.rejected.length).toBe(evA.rejected.length + 1 + garbage.length)
      expect(b.stateHash()).toBe(a.stateHash())
      if (a.done || b.done) break
    }
    expect(b.done).toBe(a.done)
    const ra = a.result()
    const rb = b.result()
    expect(rb.actionsAccepted).toBe(ra.actionsAccepted)
    expect(rb.score).toBe(ra.score)
    expect(rb.residencyMean).toBe(ra.residencyMean)
    expect(rb.death?.tick ?? null).toBe(ra.death?.tick ?? null)
    expect(rb.actionsRejected).toBeGreaterThan(ra.actionsRejected) // they were seen…
  })
})

describe('arrival/resolution order at the land tick', () => {
  const TIMING: SimConfig = {
    ...DEFAULTS,
    roundTicks: 3000,
    viewportLines: 60,
    actionBudget: 2,
    missCost: 0, // never collapse — we need many waves
    stdGlyphsMin: 1,
    stdGlyphsMax: 1,
    bossCount: 0,
    zenCount: 0,
  }

  test('transfer arriving exactly AT landTick counts; landTick+1 does not', () => {
    const sim = createSim(TIMING, 77)
    interface Plan {
      waveId: number
      glyph: string
      land: number
      exact: boolean
      phase: 0 | 1 | 2
    }
    let plan: Plan | null = null
    let exactNext = true
    const skipped = new Set<number>()
    let checkedExact = 0
    let checkedLate = 0

    for (let guard = 0; guard < 4000 && !sim.done && (checkedExact < 2 || checkedLate < 2); guard++) {
      const o = sim.oracleView()
      const acts: Action[] = []
      let timedUp: Action | null = null

      if (!plan) {
        const w = o.allWaves.find((x) => !skipped.has(x.id))
        if (w) {
          // need the full pre-telegraph runway so the chip→summary leg lands
          // before the telegraph (keeps lastHelpfulArrival clean for `late`)
          if (w.landTick - o.tick >= 85) {
            plan = { waveId: w.id, glyph: w.glyphs[0]!, land: w.landTick, exact: exactNext, phase: 0 }
            exactNext = !exactNext
          } else skipped.add(w.id)
        }
      }

      if (plan) {
        const mine = o.chunks.filter((c) => c.glyph === plan!.glyph && !c.protected)
        if (plan.phase === 0) {
          const chip = mine.filter((c) => c.tier === 0 && !c.transfer).sort((x, y) => x.id - y.id)[0]
          if (chip && o.meters.busInFlight < TIMING.B) {
            acts.push({ kind: 'up', chunkId: chip.id })
            plan.phase = 1
          }
        } else if (plan.phase === 1) {
          // exact: accepted at land−L_warm → arrives land
          // late:  accepted at land−L_warm+1 → arrives land+1
          const fireAt = plan.land - TIMING.L_warm - (plan.exact ? 1 : 0)
          if (o.tick === fireAt) {
            const warm = mine.filter((c) => c.tier === 1 && !c.transfer).sort((x, y) => x.id - y.id)[0]
            expect(warm).toBeDefined()
            timedUp = { kind: 'up', chunkId: warm!.id }
            acts.push(timedUp)
            plan.phase = 2
          }
        }
      }

      // background eviction (never touches demanded glyphs) keeps waves flowing
      if (acts.length < TIMING.actionBudget) {
        const demanded = new Set<string>()
        for (const w of o.allWaves) for (const g of w.glyphs) demanded.add(g)
        const e = o.chunks.find(
          (c) => c.tier > 0 && !c.protected && !c.pinned && !c.transfer && !demanded.has(c.glyph),
        )
        if (e) acts.push({ kind: 'down', chunkId: e.id })
      }

      const ev = sim.tick(acts)
      if (timedUp) expect(ev.accepted).toContainEqual(timedUp) // timing must not be silently rejected

      for (const r of ev.resolved) {
        if (!plan || r.waveId !== plan.waveId) continue
        if (plan.exact) {
          // arrivals fire BEFORE resolution: the glyph reads expanded at land
          expect(r.credit).toBe(1)
          expect(r.cleared).toBe(true)
          expect(r.lastHelpfulArrival).toBe(plan.land)
          checkedExact++
        } else {
          // still in flight at land: serving tier is summary, arrival is late
          expect(r.credit).toBeCloseTo(TIMING.creditSummary, 10)
          expect(r.cleared).toBe(false)
          expect(r.lastHelpfulArrival).toBeNull()
          checkedLate++
        }
        plan = null
      }
    }
    expect(checkedExact).toBeGreaterThanOrEqual(2)
    expect(checkedLate).toBeGreaterThanOrEqual(2)
  })
})

describe('protected strip boundary', () => {
  test('every chunk is protected while fewer than protectedChunks exist', () => {
    const cfg: SimConfig = {
      ...DEFAULTS,
      protectedChunks: 3,
      viewportLines: 100,
      chunkTokensMin: 22,
      chunkTokensMax: 22,
      spawnGapMin: 8,
      spawnGapMax: 8,
      stdMinAge: 1_000_000,
      bossCount: 0,
      zenCount: 0,
      roundTicks: 100_000,
    }
    const sim = createSim(cfg, 2)
    tickUntil(sim, (s) => s.view().chunks.length === 1)
    expect(sim.view().chunks[0]!.protected).toBe(true)
    for (const kind of ['down', 'up', 'pin'] as const) {
      const ev = sim.tick([{ kind, chunkId: 0 }])
      expect(ev.accepted).toHaveLength(0)
      expect(ev.rejected[0]!.reason).toBe('protected')
    }
    tickUntil(sim, (s) => s.view().chunks.length === 3)
    expect(sim.view().chunks.every((c) => c.protected)).toBe(true)
    expect(sim.tick([{ kind: 'down', chunkId: 0 }]).rejected[0]!.reason).toBe('protected')
    tickUntil(sim, (s) => s.view().chunks.length === 4)
    expect(sim.view().chunks.map((c) => c.protected)).toEqual([false, true, true, true])
    expect(sim.tick([{ kind: 'down', chunkId: 0 }]).accepted).toHaveLength(1)
  })
})

describe('greedyClearable adversarial cases', () => {
  const mk = (id: number, glyph: string, tier: Tier, expandedCost = 4): DirectorChunk => ({
    id,
    glyph,
    tier,
    transferTo: null,
    transferArrive: -1,
    spawnTick: 0,
    pinned: false,
    protected: false,
    expandedCost,
    linesNow: tier === 0 ? 0 : tier === 1 ? 1 : expandedCost,
  })
  const CFG: SimConfig = { ...DEFAULTS, B: 1, actionBudget: 2, L_c2s: 40, L_warm: 14 }
  const world: DirectorWorld = {
    now: 100,
    chunks: [mk(0, 'A', 0), mk(1, 'B', 0)],
    busArrivals: [],
    activeWaves: [],
  }
  const dA: ActiveDemand = { landTick: 160, glyphs: ['A'], needCount: 1 }
  const dB: ActiveDemand = { landTick: 170, glyphs: ['B'], needCount: 1 }

  test('individually feasible, jointly infeasible on a single bus slot', () => {
    expect(greedyClearable(CFG, world, [dA])).toBe(true)
    expect(greedyClearable(CFG, world, [dB])).toBe(true)
    // chain = 40+1+14 = 55 each; B=1 serializes: second chain ends ~t212 > 170
    expect(greedyClearable(CFG, world, [dA, dB])).toBe(false)
  })

  test('demanded glyph with no chunk anywhere is unclearable', () => {
    expect(greedyClearable(CFG, world, [{ landTick: 500, glyphs: ['Z'], needCount: 1 }])).toBe(false)
  })

  test('foreign in-flight transfer blocks the slot to the exact tick', () => {
    // slot frees after tick 104: chain starts t105 → c2s t145 → warm t146..160
    const free104: DirectorWorld = { ...world, busArrivals: [104] }
    expect(greedyClearable(CFG, free104, [dA])).toBe(true) // arrives exactly at land
    const free105: DirectorWorld = { ...world, busArrivals: [105] }
    expect(greedyClearable(CFG, free105, [dA])).toBe(false) // one tick late
  })
})

describe('spawn suppression of demanded glyphs', () => {
  test('no spawn ever carries a glyph demanded by a pre-committed pending wave', () => {
    const cfg: SimConfig = { ...DEFAULTS, roundTicks: 2200, viewportLines: 60, actionBudget: 2, missCost: 0 }
    for (const seed of [3, 11]) {
      const sim = createSim(cfg, seed)
      const drv = edfExecutor(cfg)
      let spawnsChecked = 0
      while (!sim.done) {
        const pre = sim.oracleView()
        const now = pre.tick + 1 // the tick about to be processed
        const pendingGlyphs = new Set<string>()
        for (const w of pre.allWaves) {
          if (w.landTick > now) for (const g of w.glyphs) pendingGlyphs.add(g)
        }
        const ev = sim.tick(drv(pre))
        for (const id of ev.spawned) {
          expect(pendingGlyphs.has(sim.chunkSpec(id).glyph)).toBe(false)
          spawnsChecked++
        }
      }
      expect(spawnsChecked).toBeGreaterThan(20)
    }
  })

  test('zero-fetch play can never clear a standard wave (credit stays at chip)', () => {
    const cfg: SimConfig = {
      ...DEFAULTS,
      roundTicks: 2400,
      viewportLines: 60,
      missCost: 0,
      calibrationLength: 4000,
    }
    for (const seed of [5, 17]) {
      const sim = createSim(cfg, seed)
      let std = 0
      run(sim, evictor(), (ev) => {
        for (const r of ev.resolved) {
          if (r.archetype !== 'standard') continue
          std++
          // all G chunks were chip at commit; with no fetches and no respawn
          // of demanded glyphs there is no expanded source — chip credit only
          expect(r.cleared).toBe(false)
          expect(r.credit).toBeCloseTo(cfg.creditChip, 10)
        }
      })
      expect(std).toBeGreaterThan(5)
    }
  })
})

describe('cross-wave line contention (feasibility law under DEFAULTS)', () => {
  // Regression: waves used to be committed individually-fit but JOINTLY
  // line-infeasible when a boss and a standard window overlapped (their
  // expansions must be resident simultaneously). Seeds 7/19/20 reproduced
  // exactly that with the candidate-only headroom check.
  for (const seed of [7, 19, 20]) {
    test(`seed ${seed}: EDF executor clears every wave at default difficulty`, () => {
      const sim = createSim(DEFAULTS, seed)
      const failures: string[] = []
      let resolved = 0
      run(sim, edfExecutor(DEFAULTS), (ev) => {
        for (const r of ev.resolved) {
          resolved++
          if (!r.cleared) failures.push(`wave#${r.waveId} ${r.archetype} credit=${r.credit.toFixed(2)}`)
        }
      })
      expect(failures).toEqual([])
      expect(resolved).toBeGreaterThanOrEqual(8)
    })
  }
})

describe('needCount (fp-robust sufficiency threshold)', () => {
  test('matches waveCredit’s ≥-with-epsilon semantics', () => {
    expect(needCount(0.6, 5)).toBe(3)
    expect(needCount(3 / 5, 5)).toBe(3)
    expect(needCount(0.5, 4)).toBe(2)
    expect(needCount(0.61, 5)).toBe(4)
    expect(needCount(1, 2)).toBe(2)
    expect(needCount(0, 3)).toBe(1) // floor at 1
    // the classic fp trap: 0.1+0.2 = 0.30000000000000004; raw ceil would say 4
    expect(needCount(0.1 + 0.2, 10)).toBe(3)
  })
})
