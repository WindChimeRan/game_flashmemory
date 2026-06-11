/**
 * Runner: round determinism, wave-window tracking, runMany summary stats
 * (verified exactly on synthetic results), and runMany end-to-end determinism.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, type RoundResult } from '../../src/sim'
import { GreedyHeatBot, OracleBot, runMany, runRound, runRoundDetailed, summarize } from '../../src/bots'

describe('runRound / runRoundDetailed', () => {
  test('deterministic: two runs, identical result + hash', () => {
    const bot = new GreedyHeatBot()
    const a = runRoundDetailed(DEFAULTS, 5, bot)
    const b = runRoundDetailed(DEFAULTS, 5, bot)
    expect(a.finalHash).toBe(b.finalHash)
    expect(a.result).toEqual(b.result)
    expect(runRound(DEFAULTS, 5, bot)).toEqual(a.result)
  })

  test('trackWaves records a window for every resolved wave', () => {
    const det = runRoundDetailed(DEFAULTS, 7, new OracleBot(), { trackWaves: true })
    expect(det.waveWindows).not.toBeNull()
    expect(det.result.waves.length).toBeGreaterThan(0)
    for (const r of det.result.waves) {
      const w = det.waveWindows!.get(r.waveId)
      expect(w).toBeDefined()
      expect(w!.landTick).toBeGreaterThan(w!.telegraphTick)
      if (r.lastHelpfulArrival !== null) {
        expect(r.lastHelpfulArrival).toBeGreaterThanOrEqual(w!.telegraphTick)
        expect(r.lastHelpfulArrival).toBeLessThanOrEqual(w!.landTick)
      }
    }
  })

  test('windows are null when tracking is off', () => {
    expect(runRoundDetailed(DEFAULTS, 5, new GreedyHeatBot()).waveWindows).toBeNull()
  })
})

describe('summarize', () => {
  const fake = (over: Partial<RoundResult>): RoundResult => ({
    seed: 1,
    ticksSurvived: 1800,
    roundTicks: 1800,
    survived: true,
    death: null,
    waves: [],
    meanCredit: 1,
    residencyMean: 0.5,
    score: 100,
    pareto: 0.5,
    actionsAccepted: 10,
    actionsRejected: 0,
    actionsPerSec: 0.5,
    ...over,
  })

  test('mean/median/legibility math is exact', () => {
    const death = { cause: 'oom' as const, tick: 600, legible: true, summary: 'x' }
    const s = summarize('t', [
      fake({ ticksSurvived: 1800, meanCredit: 1.0, pareto: 0.6, actionsPerSec: 0.4 }),
      fake({ ticksSurvived: 900, survived: false, death, meanCredit: 0.5, pareto: 0.2, actionsPerSec: 0.8 }),
      fake({
        ticksSurvived: 600,
        survived: false,
        death: { ...death, legible: false, cause: 'collapse' },
        meanCredit: 0.3,
        pareto: 0.1,
        actionsPerSec: 0.6,
      }),
    ])
    expect(s.rounds).toBe(3)
    expect(s.meanSurvivalFrac).toBeCloseTo((1 + 0.5 + 600 / 1800) / 3, 12)
    expect(s.medianSurvivalFrac).toBeCloseTo(0.5, 12)
    expect(s.meanTicksSurvived).toBeCloseTo(1100, 12)
    expect(s.medianTicksSurvived).toBe(900)
    expect(s.meanCredit).toBeCloseTo(0.6, 12)
    expect(s.meanPareto).toBeCloseTo(0.3, 12)
    expect(s.meanActionsPerSec).toBeCloseTo(0.6, 12)
    expect(s.deaths).toBe(2)
    expect(s.oomDeaths).toBe(1)
    expect(s.collapseDeaths).toBe(1)
    expect(s.legibleDeaths).toBe(1)
    expect(s.deathLegibilityRate).toBeCloseTo(0.5, 12)
  })

  test('no deaths ⇒ legibility rate 1 (vacuous); even count ⇒ median averages', () => {
    const s = summarize('t', [fake({ ticksSurvived: 1000 }), fake({ ticksSurvived: 2000 })])
    expect(s.deathLegibilityRate).toBe(1)
    expect(s.medianTicksSurvived).toBe(1500)
  })

  test('empty input is safe', () => {
    const s = summarize('t', [])
    expect(s.rounds).toBe(0)
    expect(s.meanSurvivalFrac).toBe(0)
    expect(s.deathLegibilityRate).toBe(1)
  })
})

describe('runMany', () => {
  test('per-seed results + deterministic summary', () => {
    const seeds = [1, 2, 3, 4, 5]
    const a = runMany(DEFAULTS, seeds, new GreedyHeatBot())
    const b = runMany(DEFAULTS, seeds, new GreedyHeatBot())
    expect(a.results.length).toBe(5)
    expect(a.results.map((r) => r.seed)).toEqual(seeds)
    expect(a.summary).toEqual(b.summary)
    expect(a.results).toEqual(b.results)
    expect(a.summary.bot).toBe('greedy-heat')
    expect(a.summary.meanSurvivalFrac).toBeGreaterThan(0)
    expect(a.summary.meanSurvivalFrac).toBeLessThanOrEqual(1)
    expect(a.summary.meanResidency).toBeGreaterThan(0)
    expect(a.summary.meanResidency).toBeLessThan(1)
  }, 30000)
})
