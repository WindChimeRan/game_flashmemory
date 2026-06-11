/**
 * RoundResult contract: pareto composition, mid-80% actionsPerSec, chunk
 * size seeding, boss placement past the midpoint.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'
import { edfExecutor, run, tickUntil } from './helpers'

describe('result()', () => {
  test('actionsPerSec counts accepted actions over the middle 80%', () => {
    const cfg: SimConfig = {
      ...DEFAULTS,
      roundTicks: 600,
      viewportLines: 100,
      protectedChunks: 1,
      chunkTokensMin: 33,
      chunkTokensMax: 33,
      spawnGapMin: 10,
      spawnGapMax: 10,
      stdMinAge: 1_000_000,
      bossCount: 0,
      zenCount: 0,
    }
    const sim = createSim(cfg, 5)
    tickUntil(sim, (s) => s.view().chunks.length >= 2) // c0 leaves the strip
    // pin-toggle c0 every tick: always accepted, state-neutral over pairs
    while (!sim.done) sim.tick([{ kind: 'pin', chunkId: 0 }])
    const res = sim.result()
    expect(res.survived).toBe(true)
    expect(res.ticksSurvived).toBe(600)
    // window (60, 540]: pins started at t44 → all 480 mid ticks accepted
    expect(res.actionsPerSec).toBeCloseTo(cfg.ticksPerSec, 10)
    expect(res.meanCredit).toBe(1) // no waves resolved
    expect(res.pareto).toBeCloseTo(1 * 1 * (1 - res.residencyMean), 10)
    expect(res.residencyMean).toBeGreaterThan(0)
    expect(res.residencyMean).toBeLessThan(1)
  })

  test('pareto composes survivalFrac × meanCredit × (1 − residencyMean)', () => {
    const sim = createSim(DEFAULTS, 77)
    run(sim, edfExecutor(DEFAULTS))
    const res = sim.result()
    const survivalFrac = Math.min(1, res.ticksSurvived / res.roundTicks)
    expect(res.pareto).toBeCloseTo(survivalFrac * res.meanCredit * (1 - res.residencyMean), 10)
    expect(res.waves.length).toBeGreaterThan(0)
    const meanCredit = res.waves.reduce((s, w) => s + w.credit, 0) / res.waves.length
    expect(res.meanCredit).toBeCloseTo(meanCredit, 10)
  })

  test('chunk sizes are seeded within [chunkTokensMin, chunkTokensMax]', () => {
    const sim = createSim(DEFAULTS, 9)
    run(sim, edfExecutor(DEFAULTS), undefined, 1200)
    const v = sim.view()
    expect(v.chunks.length).toBeGreaterThan(5)
    for (const c of v.chunks) {
      expect(c.tokensTotal).toBeGreaterThanOrEqual(DEFAULTS.chunkTokensMin)
      expect(c.tokensTotal).toBeLessThanOrEqual(DEFAULTS.chunkTokensMax)
      expect(sim.chunkSpec(c.id).targetTokens).toBe(c.tokensTotal)
    }
  })

  test('bosses land past the round midpoint', () => {
    const cfg: SimConfig = { ...DEFAULTS, missCost: 0, viewportLines: 60, actionBudget: 2, bossCount: 2 }
    const sim = createSim(cfg, 14)
    const bossLands: number[] = []
    run(sim, edfExecutor(cfg), (_ev, s) => {
      for (const w of s.oracleView().allWaves) {
        if (w.archetype === 'boss' && !bossLands.includes(w.landTick)) bossLands.push(w.landTick)
      }
    })
    expect(bossLands.length).toBeGreaterThanOrEqual(1)
    for (const land of bossLands) expect(land).toBeGreaterThan(cfg.roundTicks / 2)
  })
})
