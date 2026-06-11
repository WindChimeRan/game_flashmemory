/**
 * Zen stretches (§4.4): wave-free windows; score accrues zenPointsPerTick
 * per tick while residency < zenResidency, and only then.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'
import { edfExecutor, run } from './helpers'

const CFG: SimConfig = {
  ...DEFAULTS,
  roundTicks: 1800,
  viewportLines: 60,
  actionBudget: 2,
  missCost: 0, // survive regardless; we are measuring zen here
  zenCount: 2,
  zenLenMin: 120,
  zenLenMax: 160,
}

describe('zen scoring', () => {
  test('accrues exactly zenPointsPerTick on low-residency zen ticks', () => {
    const cfg: SimConfig = { ...CFG, zenResidency: 0.99 } // executor stays under this
    const sim = createSim(cfg, 6)
    let zenTicks = 0
    let expected = 0
    let prevScore = 0
    run(sim, edfExecutor(cfg), (ev, s) => {
      const v = s.view()
      const wavePoints = ev.resolved.length > 0
      if (v.zenActive && !s.done) {
        zenTicks++
        expect(ev.resolved).toHaveLength(0) // wave-free: nothing lands inside zen
        const frac = v.meters.viewportUsed / cfg.viewportLines
        if (frac < cfg.zenResidency) {
          expect(v.meters.score - prevScore).toBeCloseTo(cfg.zenPointsPerTick, 8)
          expected += cfg.zenPointsPerTick
        }
      } else if (!wavePoints) {
        expect(v.meters.score - prevScore).toBeCloseTo(0, 8) // no silent accrual outside zen
      }
      prevScore = v.meters.score
    })
    expect(zenTicks).toBeGreaterThan(200) // both stretches actually happened
    expect(expected).toBeGreaterThan(0)
  })

  test('no accrual when residency is above the zen bar', () => {
    const cfg: SimConfig = { ...CFG, zenResidency: 0.0001 } // unreachable bar
    const sim = createSim(cfg, 6)
    let zenTicks = 0
    let prevScore = 0
    run(sim, edfExecutor(cfg), (ev, s) => {
      const v = s.view()
      if (v.zenActive && ev.resolved.length === 0) {
        zenTicks++
        expect(v.meters.score - prevScore).toBeCloseTo(0, 8)
      }
      prevScore = v.meters.score
    })
    expect(zenTicks).toBeGreaterThan(200)
  })

  test('zenActive flag matches wave-free windows; off when zenCount=0', () => {
    const off = createSim({ ...CFG, zenCount: 0 }, 6)
    run(off, edfExecutor(CFG), (_ev, s) => {
      expect(s.view().zenActive).toBe(false)
    })
  })
})
