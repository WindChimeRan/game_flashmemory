/**
 * Heat honesty (§4.4–4.5): soon-demanded chunks run visibly hotter than
 * never-demanded honest chunks pre-cliff; distractors run hot-looking heat;
 * pips follow the corroboration rules; the 2× cliff degrades σ irreversibly.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, heatSigma, type SimConfig } from '../../src/sim'
import { edfExecutor, run } from './helpers'

const CFG: SimConfig = {
  ...DEFAULTS,
  roundTicks: 1600,
  viewportLines: 60,
  actionBudget: 2,
  missCost: 0, // keep the round alive for stable sampling
  calibrationLength: 4000, // pre-cliff throughout
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}

describe('heat channel', () => {
  test('soon-demanded > never-demanded honest; distractors look hot', () => {
    const sim = createSim(CFG, 12)
    const soon: number[] = []
    const never: number[] = []
    const distractor: number[] = []
    run(sim, edfExecutor(CFG), (_ev, s) => {
      if (s.tickNow < 200) return
      const o = s.oracleView()
      for (const c of o.chunks) {
        if (o.distractorIds.has(c.id)) {
          distractor.push(c.heat)
          continue
        }
        const d = o.nextDemandByChunk.get(c.id)!
        if (d !== Infinity && d - o.tick <= CFG.heatHorizon) soon.push(c.heat)
        else if (d === Infinity && c.ageTicks > 30) never.push(c.heat)
      }
    })
    expect(soon.length).toBeGreaterThan(100)
    expect(never.length).toBeGreaterThan(100)
    expect(distractor.length).toBeGreaterThan(100)
    expect(mean(soon)).toBeGreaterThan(mean(never) + 0.15) // honesty gap
    expect(mean(distractor)).toBeGreaterThan(mean(never) + 0.1) // the trap looks real
    for (const h of [...soon, ...never, ...distractor]) {
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(1)
    }
  })

  test('pips: honest demanded 2–3 (3 within horizon); distractors 1–2; idle honest 1', () => {
    const sim = createSim(CFG, 12)
    run(sim, edfExecutor(CFG), (_ev, s) => {
      if (s.tickNow < 200) return
      const o = s.oracleView()
      for (const c of o.chunks) {
        if (o.distractorIds.has(c.id)) {
          expect(c.pips === 1 || c.pips === 2).toBe(true)
          continue
        }
        const d = o.nextDemandByChunk.get(c.id)!
        if (d === Infinity) expect(c.pips).toBe(1)
        else if (d - o.tick <= CFG.heatHorizon) expect(c.pips).toBe(3)
        else expect(c.pips).toBe(2)
      }
    })
  })

  test('2× cliff: σ ramps irreversibly past 2×calibrationLength; flag flips', () => {
    expect(heatSigma(DEFAULTS, 2 * DEFAULTS.calibrationLength)).toBe(DEFAULTS.heatNoise)
    const mid = heatSigma(DEFAULTS, 2 * DEFAULTS.calibrationLength + Math.floor(DEFAULTS.calibrationLength / 2))
    const late = heatSigma(DEFAULTS, 4 * DEFAULTS.calibrationLength)
    expect(mid).toBeGreaterThan(DEFAULTS.heatNoise)
    expect(late).toBeGreaterThan(mid - 1e-12)
    expect(late).toBeCloseTo(DEFAULTS.heatNoiseCliff, 10)

    const cfg: SimConfig = { ...CFG, calibrationLength: 300, roundTicks: 900 }
    const sim = createSim(cfg, 4)
    let flipped = -1
    run(sim, () => [], (_ev, s) => {
      if (flipped < 0 && s.view().cliffActive) flipped = s.tickNow
    })
    if (!sim.done || sim.result().death === null) {
      expect(flipped).toBe(2 * cfg.calibrationLength + 1)
    }
  })
})
