/**
 * Transfer law (§4.3): latencies honored exactly, B cap, immediate
 * reservation, in-flight committed (no evict / no re-up), headroom guard,
 * tier bounds, action budget, pin semantics.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'
import { tickUntil } from './helpers'

/** Quiet lab: no waves (stdMinAge unreachable), roomy viewport, 3-line chunks. */
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
}

function lab(): ReturnType<typeof createSim> {
  const sim = createSim(LAB, 5)
  // chunks 0..3 exist; only c3 (newest) protected; streaming idle until t169
  tickUntil(sim, (s) => s.view().chunks.length === 4 && s.view().chunks[3]!.tokensShown === 33)
  return sim
}

describe('transfers (§4.3 commitment structure)', () => {
  test('down is instant one step; at-bottom rejected', () => {
    const sim = lab()
    let ev = sim.tick([{ kind: 'down', chunkId: 0 }])
    expect(ev.accepted).toHaveLength(1)
    expect(sim.view().chunks[0]!.tier).toBe(1)
    expect(sim.view().chunks[0]!.linesNow).toBe(1)
    ev = sim.tick([{ kind: 'down', chunkId: 0 }])
    expect(sim.view().chunks[0]!.tier).toBe(0)
    expect(sim.view().chunks[0]!.linesNow).toBe(0)
    ev = sim.tick([{ kind: 'down', chunkId: 0 }])
    expect(ev.rejected[0]!.reason).toBe('at-bottom')
  })

  test('chip→summary takes exactly L_c2s; reservation counts from start', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'down', chunkId: 0 }]) // c0 at chip, 0 lines
    const usedBefore = sim.view().meters.viewportUsed
    const ev = sim.tick([{ kind: 'up', chunkId: 0 }])
    expect(ev.accepted).toHaveLength(1)
    const start = sim.tickNow
    const c0 = sim.view().chunks[0]!
    expect(c0.transfer).toEqual({ toTier: 1, startTick: start, arriveTick: start + LAB.L_c2s })
    // reservation: counts max(chip, summary) = 1 line immediately
    expect(c0.linesNow).toBe(1)
    expect(sim.view().meters.viewportUsed).toBe(usedBefore + 1)
    expect(sim.view().meters.busInFlight).toBe(1)

    // tier does NOT change until arriveTick, then flips exactly there
    tickUntil(sim, (s) => s.tickNow === start + LAB.L_c2s - 1)
    expect(sim.view().chunks[0]!.tier).toBe(0)
    expect(sim.view().chunks[0]!.transfer).not.toBeNull()
    const arriveEv = sim.tick([])
    expect(sim.tickNow).toBe(start + LAB.L_c2s)
    expect(arriveEv.arrivals).toEqual([{ chunkId: 0, tier: 1 }])
    expect(sim.view().chunks[0]!.tier).toBe(1)
    expect(sim.view().chunks[0]!.transfer).toBeNull()
    expect(sim.view().meters.busInFlight).toBe(0)
  })

  test('summary→expanded takes exactly L_warm and reserves expanded cost', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }]) // summary, 1 line
    const usedBefore = sim.view().meters.viewportUsed
    sim.tick([{ kind: 'up', chunkId: 0 }])
    const start = sim.tickNow
    const c0 = sim.view().chunks[0]!
    expect(c0.transfer!.arriveTick).toBe(start + LAB.L_warm)
    expect(c0.linesNow).toBe(3) // ceil(33/11) reserved immediately
    expect(sim.view().meters.viewportUsed).toBe(usedBefore + 2)
    const ev = (() => {
      tickUntil(sim, (s) => s.tickNow === start + LAB.L_warm - 1)
      return sim.tick([])
    })()
    expect(ev.arrivals).toEqual([{ chunkId: 0, tier: 2 }])
    expect(sim.view().chunks[0]!.tier).toBe(2)
  })

  test('in-flight is committed: no evict, no second up, no pin-block bypass', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'up', chunkId: 0 }])
    expect(sim.tick([{ kind: 'down', chunkId: 0 }]).rejected[0]!.reason).toBe('transferring')
    expect(sim.tick([{ kind: 'up', chunkId: 0 }]).rejected[0]!.reason).toBe('transferring')
  })

  test('bus cap: B=2 in flight → third up rejected bus-full', () => {
    const sim = lab()
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'down', chunkId: 1 }])
    sim.tick([{ kind: 'down', chunkId: 2 }])
    expect(sim.tick([{ kind: 'up', chunkId: 0 }]).accepted).toHaveLength(1)
    expect(sim.tick([{ kind: 'up', chunkId: 1 }]).accepted).toHaveLength(1)
    expect(sim.view().meters.busInFlight).toBe(2)
    const ev = sim.tick([{ kind: 'up', chunkId: 2 }])
    expect(ev.rejected[0]!.reason).toBe('bus-full')
    // a slot frees on arrival → up accepted again
    tickUntil(sim, (s) => s.view().meters.busInFlight === 0)
    expect(sim.tick([{ kind: 'up', chunkId: 2 }]).accepted).toHaveLength(1)
  })

  test('at-top: up on expanded rejected', () => {
    const sim = lab()
    expect(sim.tick([{ kind: 'up', chunkId: 0 }]).rejected[0]!.reason).toBe('at-top')
  })

  test('no-headroom: up rejected when reservation would not fit', () => {
    const cfg: SimConfig = {
      ...LAB,
      viewportLines: 28,
      chunkTokensMin: 77,
      chunkTokensMax: 77, // 7-line chunks
    }
    const sim = createSim(cfg, 3)
    // park c0 at chip early, then wait until the viewport is exactly full
    tickUntil(sim, (s) => s.view().chunks.length >= 2)
    sim.tick([{ kind: 'down', chunkId: 0 }])
    sim.tick([{ kind: 'down', chunkId: 0 }])
    expect(sim.view().chunks[0]!.tier).toBe(0)
    tickUntil(sim, (s) => s.view().meters.viewportUsed === cfg.viewportLines)
    const ev = sim.tick([{ kind: 'up', chunkId: 0 }]) // +1 line would overflow
    expect(ev.rejected[0]!.reason).toBe('no-headroom')
  })

  test('action budget: ≤ actionBudget accepted; rejects do not consume it', () => {
    const sim = lab()
    const ev = sim.tick([
      { kind: 'down', chunkId: 99 }, // no-such-chunk — must not consume budget
      { kind: 'down', chunkId: 0 },
      { kind: 'down', chunkId: 1 }, // over budget (=1)
    ])
    expect(ev.rejected.map((r) => r.reason)).toEqual(['no-such-chunk', 'action-budget'])
    expect(ev.accepted).toEqual([{ kind: 'down', chunkId: 0 }])
  })

  test('pin toggles and blocks down; unpin re-allows', () => {
    const sim = lab()
    expect(sim.tick([{ kind: 'pin', chunkId: 0 }]).accepted).toHaveLength(1)
    expect(sim.view().chunks[0]!.pinned).toBe(true)
    expect(sim.tick([{ kind: 'down', chunkId: 0 }]).rejected[0]!.reason).toBe('pinned')
    expect(sim.tick([{ kind: 'pin', chunkId: 0 }]).accepted).toHaveLength(1)
    expect(sim.view().chunks[0]!.pinned).toBe(false)
    expect(sim.tick([{ kind: 'down', chunkId: 0 }]).accepted).toHaveLength(1)
  })
})
