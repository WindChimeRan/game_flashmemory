/**
 * Summary-tier decay (summaryTTL; PLAYTEST.md 2026-06-10 gate-2(b) mechanic):
 *  - a summary unused for > summaryTTL ticks drops to chip at the START of
 *    a tick (before actions), emitting a `decayed` event;
 *  - relevance resets on arrival-at-summary, a LANDING wave demanding the
 *    glyph, and accepted up/down actions targeting the chunk;
 *  - pin does NOT reset the counter and pinned summaries still decay;
 *  - rejected actions do not reset;
 *  - mid-transfer chunks never decay (in-flight is committed);
 *  - summaryTTL = Infinity reproduces frozen v1.1 behavior exactly;
 *  - the decay counter is part of stateHash (determinism law).
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type Action, type ChunkView, type Sim, type SimConfig } from '../../src/sim'
import { scriptedActions, tickUntil } from './helpers'

const TTL = 30 // > telegraphStd 28, > L_warm + 2 = 16

/** Quiet lab (no waves: stdMinAge unreachable), 3-line chunks, roomy. */
const LAB: SimConfig = {
  ...DEFAULTS,
  viewportLines: 100,
  protectedChunks: 1,
  chunkTokensMin: 33,
  chunkTokensMax: 33,
  spawnGapMin: 10,
  spawnGapMax: 10,
  stdMinAge: 1_000_000,
  bossCount: 0,
  zenCount: 0,
  roundTicks: 100_000,
  summaryTTL: TTL,
}

function lab(cfg: SimConfig = LAB): Sim {
  const sim = createSim(cfg, 5)
  tickUntil(sim, (s) => s.view().chunks.length === 4 && s.view().chunks[3]!.tokensShown === 33)
  return sim
}

const c0 = (sim: Sim): ChunkView => sim.view().chunks[0]!

describe('decay timing and the decayed event', () => {
  test('down-parked summary survives exactly TTL ticks, then decays at the start of the next tick', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }]) // expanded → summary, reset at D
    const D = sim.tickNow
    expect(c0(sim).tier).toBe(1)
    expect(c0(sim).summaryAgeTicks).toBe(0)

    for (let t = D + 1; t <= D + TTL; t++) {
      const ev = sim.tick([])
      expect(ev.decayed).toEqual([]) // alive through age == TTL
    }
    expect(c0(sim).tier).toBe(1)
    expect(c0(sim).summaryAgeTicks).toBe(TTL)

    const ev = sim.tick([]) // start of D + TTL + 1: age TTL+1 > TTL
    expect(ev.decayed).toEqual([{ chunkId: 0 }])
    expect(c0(sim).tier).toBe(0)
    expect(c0(sim).summaryAgeTicks).toBe(0)
    expect(c0(sim).linesNow).toBe(0) // chip frees the line
  })

  test('summaryAgeTicks is 0 at non-summary tiers', () => {
    const sim = lab()
    expect(c0(sim).tier).toBe(2)
    expect(c0(sim).summaryAgeTicks).toBe(0)
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'down', chunkId: 0 }]) // chip
    expect(c0(sim).tier).toBe(0)
    expect(c0(sim).summaryAgeTicks).toBe(0)
  })

  test('arrival at summary resets the counter: decay fires TTL+1 after ARRIVAL, not after the up', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'down', chunkId: 0 }]) // chip
    sim.tick([{ kind: 'up', chunkId: 0 }])
    const U = sim.tickNow
    const A = U + LAB.L_c2s
    expect(c0(sim).transfer).toEqual({ toTier: 1, startTick: U, arriveTick: A })

    let arrived = false
    while (sim.tickNow < A) {
      const ev = sim.tick([])
      expect(ev.decayed).toEqual([])
      if (sim.tickNow === A) {
        expect(ev.arrivals).toEqual([{ chunkId: 0, tier: 1 }])
        arrived = true
      }
    }
    expect(arrived).toBe(true)
    // Without the arrival reset, age at A would be A − U = L_c2s > TTL and
    // the summary would decay at A + 1. With it, decay lands at A + TTL + 1.
    for (let t = A + 1; t <= A + TTL; t++) expect(sim.tick([]).decayed).toEqual([])
    expect(c0(sim).tier).toBe(1)
    expect(sim.tick([]).decayed).toEqual([{ chunkId: 0 }])
    expect(c0(sim).tier).toBe(0)
  })
})

describe('pin and decay', () => {
  test('pin action does NOT reset the counter, and pinned summaries still decay on schedule', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    const D = sim.tickNow
    const ev1 = sim.tick([{ kind: 'pin', chunkId: 0 }]) // accepted at D+1
    expect(ev1.accepted).toHaveLength(1)
    expect(c0(sim).pinned).toBe(true)

    // If the pin had reset relevance, decay would fire at D + 1 + TTL + 1.
    while (sim.tickNow < D + TTL) expect(sim.tick([]).decayed).toEqual([])
    const ev = sim.tick([]) // D + TTL + 1
    expect(ev.decayed).toEqual([{ chunkId: 0 }])
    expect(c0(sim).tier).toBe(0) // decayed THROUGH the pin
    expect(c0(sim).pinned).toBe(true) // pin state itself is untouched
  })
})

describe('rejected actions do not reset', () => {
  test('bus-full rejected up on a summary leaves its decay schedule unchanged', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }]) // watch summary, reset at D
    const D = sim.tickNow
    // Saturate the bus (B = 2) with two cold fetches on other chunks.
    sim.tick([{ kind: 'down', chunkId: 1 }])
    sim.tick([{ kind: 'down', chunkId: 1 }])
    expect(sim.tick([{ kind: 'up', chunkId: 1 }]).accepted).toHaveLength(1)
    sim.tick([{ kind: 'down', chunkId: 2 }])
    sim.tick([{ kind: 'down', chunkId: 2 }])
    expect(sim.tick([{ kind: 'up', chunkId: 2 }]).accepted).toHaveLength(1)
    expect(sim.view().meters.busInFlight).toBe(2)

    const evRej = sim.tick([{ kind: 'up', chunkId: 0 }]) // D+7
    expect(evRej.rejected).toEqual([{ action: { kind: 'up', chunkId: 0 }, reason: 'bus-full' }])

    // Bus transfers arrive at D+3+40 / D+6+40, both after D+TTL+1 = D+31.
    while (sim.tickNow < D + TTL) {
      expect(sim.tick([]).decayed).toEqual([])
      expect(c0(sim).tier).toBe(1)
    }
    expect(sim.tick([]).decayed).toEqual([{ chunkId: 0 }]) // unchanged schedule
  })
})

describe('mid-transfer immunity (both directions of the edge)', () => {
  test('an up accepted at age == TTL beats decay; the transfer then crosses the decay tick unharmed', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    const D = sim.tickNow
    for (let i = 0; i < TTL - 1; i++) sim.tick([]) // tickNow = D + TTL − 1
    const ev = sim.tick([{ kind: 'up', chunkId: 0 }]) // processes at D + TTL: age == TTL, still summary
    expect(ev.decayed).toEqual([])
    expect(ev.accepted).toHaveLength(1)
    expect(c0(sim).transfer!.toTier).toBe(2) // warm leg from the surviving summary
    const arrive = c0(sim).transfer!.arriveTick
    expect(arrive).toBe(D + TTL + LAB.L_warm)
    while (sim.tickNow < arrive) expect(sim.tick([]).decayed).toEqual([]) // immune in flight
    expect(c0(sim).tier).toBe(2)
  })

  test('one tick later the decay wins: the same up lands on the freshly-decayed chip (L_c2s leg)', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    const D = sim.tickNow
    for (let i = 0; i < TTL; i++) sim.tick([]) // tickNow = D + TTL
    const ev = sim.tick([{ kind: 'up', chunkId: 0 }]) // processes at D + TTL + 1: decay first
    expect(ev.decayed).toEqual([{ chunkId: 0 }])
    expect(ev.accepted).toHaveLength(1)
    expect(c0(sim).transfer!.toTier).toBe(1) // chip → summary, not summary → expanded
    expect(c0(sim).transfer!.arriveTick).toBe(D + TTL + 1 + LAB.L_c2s)
  })
})

describe('a landing wave demanding the glyph resets the counter', () => {
  const WAVECFG: SimConfig = {
    ...DEFAULTS,
    viewportLines: 60,
    missCost: 0, // misses must not end the round under a do-little driver
    bossCount: 0,
    zenCount: 0,
    roundTicks: 4000,
    summaryTTL: 50,
  }

  /** Pressure-relief driver that never touches `avoidGlyph` or `watchId`. */
  const relieve = (sim: Sim, avoidGlyph: string | null, watchId: number | null): Action[] => {
    const v = sim.view()
    if (v.meters.viewportBudget - v.meters.viewportUsed > 4) return []
    let pick: ChunkView | null = null
    for (const c of v.chunks) {
      if (c.tier === 0 || c.protected || c.pinned || c.transfer || c.id === watchId) continue
      if (avoidGlyph !== null && c.glyph === avoidGlyph) continue
      if (!pick || c.linesNow > pick.linesNow || (c.linesNow === pick.linesNow && c.id < pick.id)) pick = c
    }
    return pick ? [{ kind: 'down', chunkId: pick.id }] : []
  }

  test('summary serving a landing wave decays TTL+1 after the LANDING, not after its arrival', () => {
    const sim = createSim(WAVECFG, 11)
    const ttl = WAVECFG.summaryTTL

    // Phase 1: wait for a committed standard wave whose landing sits in
    // [45, 88] ticks ahead (an L_c2s hedge can arrive before it lands, and
    // arrival age at landing stays ≤ TTL). Waves only demand all-chip
    // glyphs, so a chip of the demanded glyph is guaranteed to exist.
    let glyph: string | null = null
    let land = -1
    let watchId = -1
    for (let i = 0; i < 2500 && glyph === null; i++) {
      sim.tick(relieve(sim, null, null))
      expect(sim.done).toBe(false)
      const now = sim.tickNow
      for (const w of sim.oracleView().allWaves) {
        if (w.landTick - now >= 45 && w.landTick - now <= 88) {
          glyph = w.glyphs[0]!
          land = w.landTick
          break
        }
      }
    }
    expect(glyph).not.toBeNull()
    const chip = sim
      .view()
      .chunks.find((c) => c.glyph === glyph && c.tier === 0 && !c.transfer && !c.protected)!
    expect(chip).toBeDefined()
    watchId = chip.id

    // Phase 2: hedge it (chip → summary) and let the wave land on it.
    const evUp = sim.tick([{ kind: 'up', chunkId: watchId }])
    expect(evUp.accepted).toHaveLength(1)
    const arrive = sim.tickNow + WAVECFG.L_c2s
    expect(arrive).toBeLessThan(land)

    const decaysOfWatch: number[] = []
    const track = (ev: ReturnType<Sim['tick']>): void => {
      for (const d of ev.decayed) if (d.chunkId === watchId) decaysOfWatch.push(sim.tickNow)
    }
    let resolvedAtLand = false
    while (sim.tickNow < land) {
      const ev = sim.tick(relieve(sim, glyph, watchId))
      track(ev)
      expect(sim.done).toBe(false)
      if (sim.tickNow === land) resolvedAtLand = ev.resolved.some((r) => r.waveId >= 0)
    }
    expect(resolvedAtLand).toBe(true)
    expect(decaysOfWatch).toEqual([]) // survived to the landing
    const atLand = sim.view().chunks[watchId]!
    expect(atLand.tier).toBe(1)
    expect(atLand.summaryAgeTicks).toBe(0) // the landing demand reset it

    // Phase 3: untouched afterwards, it decays exactly at land + TTL + 1.
    // Without the landing reset it would have decayed at arrive + TTL + 1 ≤
    // land + TTL, inside the asserted-quiet window.
    while (sim.tickNow < land + ttl) {
      track(sim.tick(relieve(sim, glyph, watchId)))
      expect(sim.done).toBe(false)
    }
    expect(decaysOfWatch).toEqual([])
    const evDecay = sim.tick(relieve(sim, glyph, watchId))
    expect(evDecay.decayed.some((d) => d.chunkId === watchId)).toBe(true)
    expect(sim.tickNow).toBe(land + ttl + 1)
  }, 30000)
})

describe('determinism and the frozen-behavior control', () => {
  test('finite TTL: two sims, same seed + script ⇒ identical hashes and identical decay streams', () => {
    const cfg: SimConfig = { ...DEFAULTS, summaryTTL: 45 }
    const script = scriptedActions(0xdecaf, 1200)
    const a = createSim(cfg, 42)
    const b = createSim(cfg, 42)
    const decA: string[] = []
    const decB: string[] = []
    for (let t = 0; t < 1200; t++) {
      const ea = a.tick(script[t]!)
      const eb = b.tick(script[t]!)
      for (const d of ea.decayed) decA.push(`${a.tickNow}:${d.chunkId}`)
      for (const d of eb.decayed) decB.push(`${b.tickNow}:${d.chunkId}`)
      if ((t + 1) % 50 === 0) expect(a.stateHash()).toBe(b.stateHash())
    }
    expect(decA).toEqual(decB)
    expect(decA.length).toBeGreaterThan(0) // the script actually exercised decay
    expect(a.stateHash()).toBe(b.stateHash())
  })

  test('summaryTTL large enough to never fire ≡ Infinity (knob generalization)', () => {
    const script = scriptedActions(0xfade, 800)
    const fin = createSim({ ...DEFAULTS, summaryTTL: 100_000 }, 7)
    const inf = createSim({ ...DEFAULTS, summaryTTL: Infinity }, 7)
    for (let t = 0; t < 800; t++) {
      expect(fin.tick(script[t]!).decayed).toEqual([])
      inf.tick(script[t]!)
      if ((t + 1) % 100 === 0) expect(fin.stateHash()).toBe(inf.stateHash())
    }
    expect(fin.stateHash()).toBe(inf.stateHash())
  })

  test('Infinity: a parked summary never decays and its age grows unbounded', () => {
    const sim = lab({ ...LAB, summaryTTL: Infinity })
    sim.tick([{ kind: 'down', chunkId: 0 }])
    for (let i = 0; i < 500; i++) expect(sim.tick([]).decayed).toEqual([])
    expect(c0(sim).tier).toBe(1)
    expect(c0(sim).summaryAgeTicks).toBe(500)
  })

  test('stateHash covers the decay counter (determinism law)', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([])
    const h1 = sim.stateHash()
    // White-box: perturb ONLY the counter origin; everything else is equal.
    const guts = sim as unknown as { chunks: { lastRelevant: number }[] }
    guts.chunks[0]!.lastRelevant -= 1
    expect(sim.stateHash()).not.toBe(h1)
    guts.chunks[0]!.lastRelevant += 1
    expect(sim.stateHash()).toBe(h1)
  })
})
