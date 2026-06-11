/**
 * Gates arithmetic, attacked directly (scripts/gates.ts exports its pure
 * helpers; main() is entrypoint-guarded so importing is side-effect free):
 *  - nearMissStats: final-quartile boundary is inclusive, null arrivals and
 *    missing windows count toward the denominator only, zero waves ⇒ frac 0
 *    (no NaN).
 *  - evaluateGates: threshold boundaries for all six gates, including the
 *    survival-fraction ratios (gate 1/2), strict reactive<greedy, vacuous
 *    legibility on zero deaths, and gate 6 measured in SECONDS (§7 says
 *    2–4 minutes — ticks alone are the wrong unit).
 *  - saturation fallback (formulation fix, see PLAYTEST.md): gates 1/2
 *    compare on pareto iff BOTH bots of a comparison have survival ≥ 0.95,
 *    with the §7 thresholds unchanged; below saturation survival ratios
 *    are untouched.
 *  - parseArgs: defaults, full flags, and hard rejection of bad input.
 */

import { describe, expect, test } from 'bun:test'
import type { RoundResult, WaveResolution } from '../../src/sim'
import type { BotSummary, RoundDetail } from '../../src/bots'
import {
  SURVIVAL_SATURATION,
  evaluateGates,
  nearMissStats,
  pairMetric,
  parseArgs,
  type NearMiss,
} from '../../scripts/gates'

// ── fabrication helpers ──────────────────────────────────────────────────

const res = (over: Partial<RoundResult>): RoundResult => ({
  seed: 1,
  ticksSurvived: 1800,
  roundTicks: 1800,
  survived: true,
  death: null,
  waves: [],
  meanCredit: 1,
  residencyMean: 0.4,
  score: 100,
  pareto: 0.5,
  actionsAccepted: 10,
  actionsRejected: 0,
  actionsPerSec: 0.5,
  ...over,
})

const wave = (waveId: number, lastHelpfulArrival: number | null): WaveResolution => ({
  waveId,
  archetype: 'standard',
  credit: 1,
  cleared: true,
  coherenceDelta: 0,
  lastHelpfulArrival,
})

const detail = (
  waves: WaveResolution[],
  windows: [number, { telegraphTick: number; landTick: number; archetype: 'standard' }][],
): RoundDetail => ({
  result: res({ waves }),
  finalHash: 0,
  waveWindows: new Map(windows),
})

const summary = (bot: string, over: Partial<BotSummary>): BotSummary => ({
  bot,
  rounds: 10,
  meanSurvivalFrac: 1,
  medianSurvivalFrac: 1,
  meanTicksSurvived: 1800,
  medianTicksSurvived: 1800,
  meanCredit: 1,
  meanResidency: 0.4,
  meanPareto: 0.5,
  meanScore: 100,
  meanActionsPerSec: 0.5,
  deaths: 0,
  oomDeaths: 0,
  collapseDeaths: 0,
  legibleDeaths: 0,
  deathLegibilityRate: 1,
  ...over,
})

interface Knobs {
  oracle?: number
  greedy?: number
  recency?: number
  random?: number
  reactive?: number
  oracleP?: number
  greedyP?: number
  recencyP?: number
  randomP?: number
  reactiveP?: number
  aps?: number
  frac?: number
  greedyMedianTicks?: number
  deaths?: { legible: boolean }[]
}

function gates(k: Knobs = {}) {
  const s: Record<string, BotSummary> = {
    oracle: summary('oracle', {
      meanSurvivalFrac: k.oracle ?? 0.92,
      meanPareto: k.oracleP ?? 0.5,
      meanActionsPerSec: k.aps ?? 0.5,
    }),
    'greedy-heat': summary('greedy-heat', {
      meanSurvivalFrac: k.greedy ?? 0.8,
      meanPareto: k.greedyP ?? 0.5,
      medianTicksSurvived: k.greedyMedianTicks ?? 1800,
    }),
    recency: summary('recency', { meanSurvivalFrac: k.recency ?? 0.4, meanPareto: k.recencyP ?? 0.5 }),
    'random-k': summary('random-k', { meanSurvivalFrac: k.random ?? 0.45, meanPareto: k.randomP ?? 0.5 }),
    reactive: summary('reactive', { meanSurvivalFrac: k.reactive ?? 0.63, meanPareto: k.reactiveP ?? 0.5 }),
  }
  const nearMiss: NearMiss = { late: 0, resolved: 10, frac: k.frac ?? 0.3 }
  const deaths = (k.deaths ?? []).map((d, i) =>
    res({ seed: i, survived: false, death: { cause: 'collapse', tick: 500, legible: d.legible, summary: 'x' } }),
  )
  return evaluateGates(s, nearMiss, deaths, [], { roundTicks: 1800, ticksPerSec: 10 })
}

const byId = (gs: ReturnType<typeof gates>, id: number) => {
  const g = gs.find((x) => x.id === id)
  if (!g) throw new Error(`gate ${id} missing`)
  return g
}

// ── nearMissStats ────────────────────────────────────────────────────────

describe('nearMissStats quartile arithmetic', () => {
  const win = { telegraphTick: 100, landTick: 136, archetype: 'standard' as const } // span 36, cutoff 127

  test('boundary inclusive at land − 0.25·span; one tick earlier is not late', () => {
    const d = detail([wave(0, 127), wave(1, 126), wave(2, 136)], [[0, win], [1, win], [2, win]])
    expect(nearMissStats([d])).toEqual({ late: 2, resolved: 3, frac: 2 / 3 })
  })

  test('null arrivals and missing windows count only toward the denominator', () => {
    const d = detail([wave(0, null), wave(1, 135)], [[0, win]]) // wave 1 has no window
    expect(nearMissStats([d])).toEqual({ late: 0, resolved: 2, frac: 0 })
  })

  test('zero-length window (telegraph == land) is never "late"; zero waves ⇒ frac 0, not NaN', () => {
    const z = { telegraphTick: 50, landTick: 50, archetype: 'standard' as const }
    expect(nearMissStats([detail([wave(0, 50)], [[0, z]])])).toEqual({ late: 0, resolved: 1, frac: 0 })
    expect(nearMissStats([])).toEqual({ late: 0, resolved: 0, frac: 0 })
    expect(nearMissStats([detail([], [])])).toEqual({ late: 0, resolved: 0, frac: 0 })
  })
})

// ── evaluateGates thresholds ─────────────────────────────────────────────

describe('evaluateGates thresholds', () => {
  test('baseline configuration passes all six gates', () => {
    for (const g of gates()) expect(`${g.id}:${g.pass}`).toBe(`${g.id}:true`)
  })

  test('gate 1: each of the four sub-conditions flips it', () => {
    expect(byId(gates({ recency: 0.6 }), 1).pass).toBe(false) // recency/oracle 0.65 > 0.6
    expect(byId(gates({ greedy: 0.85 }), 1).pass).toBe(false) // oracle < 1.15×greedy
    expect(byId(gates({ recency: 0.75, random: 0.75 }), 1).pass).toBe(false) // greedy < 1.15×recency
    expect(byId(gates({ random: 0.1 }), 1).pass).toBe(false) // |recency−random| 0.30 > 0.10
    // "≈" tolerance is max(0.10, 0.15·max): 0.49 vs 0.40 stays within 0.10.
    expect(byId(gates({ recency: 0.4, random: 0.49 }), 1).pass).toBe(true)
  })

  test('gate 2: ratio ≤ 0.70 inclusive; reactive < greedy strict', () => {
    expect(byId(gates({ oracle: 1.0, reactive: 0.7 }), 2).pass).toBe(true) // exactly 0.70
    expect(byId(gates({ oracle: 1.0, reactive: 0.701 }), 2).pass).toBe(false)
    expect(byId(gates({ reactive: 0.8, greedy: 0.8 }), 2).pass).toBe(false) // == greedy ⇒ fail
  })

  // ── saturation fallback (formulation fix, see PLAYTEST.md) ────────────

  test('pairMetric: pareto iff BOTH survivals ≥ 0.95 (inclusive); survival otherwise', () => {
    const mk = (surv: number, pareto: number) => summary('x', { meanSurvivalFrac: surv, meanPareto: pareto })
    expect(SURVIVAL_SATURATION).toBe(0.95)
    expect(pairMetric(mk(0.95, 0.3), mk(1.0, 0.6))).toEqual({ a: 0.3, b: 0.6, metric: 'pareto' })
    expect(pairMetric(mk(0.949, 0.3), mk(1.0, 0.6))).toEqual({ a: 0.949, b: 1.0, metric: 'surv' })
    expect(pairMetric(mk(1.0, 0.3), mk(0.4, 0.6))).toEqual({ a: 1.0, b: 0.4, metric: 'surv' })
  })

  test('gate 2 fallback: both saturated ⇒ pareto with UNCHANGED thresholds', () => {
    // reactive/oracle on pareto: 0.35/0.50 = 0.70 ≤ 0.70 ok; 0.351 fails.
    const sat = { oracle: 1.0, reactive: 0.99, greedy: 0.97 }
    const g = byId(gates({ ...sat, oracleP: 0.5, reactiveP: 0.35, greedyP: 0.4 }), 2)
    expect(g.pass).toBe(true)
    expect(g.measured['reactiveOverOracleMetric']).toBe('pareto')
    expect(g.measured['reactiveVsGreedyMetric']).toBe('pareto')
    expect(byId(gates({ ...sat, oracleP: 0.5, reactiveP: 0.351, greedyP: 0.4 }), 2).pass).toBe(false)
    // reactive ≥ greedy on pareto fails sub-condition (b) even when (a) holds.
    expect(byId(gates({ ...sat, oracleP: 0.5, reactiveP: 0.35, greedyP: 0.3 }), 2).pass).toBe(false)
  })

  test('gate 2 below saturation keeps survival ratios even when pareto would disagree', () => {
    // reactive 0.63 < 0.95: survival path (0.63/0.92 ≤ 0.7, 0.63 < 0.8 ⇒ pass)
    // despite reactive pareto ABOVE both oracle's and greedy's.
    const g = byId(gates({ reactiveP: 0.9, oracleP: 0.2, greedyP: 0.2 }), 2)
    expect(g.pass).toBe(true)
    expect(g.measured['reactiveOverOracleMetric']).toBe('surv')
  })

  test('gate 1 fallback: saturated oracle/greedy pair compares pareto; sub-saturated pairs keep survival', () => {
    // oracle and greedy both ≥ 0.95 ⇒ (b) on pareto; recency/random stay survival.
    const k: Knobs = {
      oracle: 1.0, greedy: 0.97, recency: 0.4, random: 0.45,
      oracleP: 0.55, greedyP: 0.2,
    }
    const g = byId(gates(k), 1)
    expect(g.pass).toBe(true) // 0.55 ≥ 1.15·0.20; greedy/recency on survival 0.97 ≥ 1.15·0.4
    expect(g.measured['oracleOverGreedyMetric']).toBe('pareto')
    expect(g.measured['greedyOverRecencyMetric']).toBe('surv')
    expect(g.measured['recencyOverOracleMetric']).toBe('surv')
    // Same shape but oracle pareto below 1.15×greedy pareto ⇒ (b) fails.
    expect(byId(gates({ ...k, oracleP: 0.22 }), 1).pass).toBe(false)
  })

  test('gate 3: aps band [0.3, 1.0] inclusive', () => {
    expect(byId(gates({ aps: 0.3 }), 3).pass).toBe(true)
    expect(byId(gates({ aps: 1.0 }), 3).pass).toBe(true)
    expect(byId(gates({ aps: 0.29 }), 3).pass).toBe(false)
    expect(byId(gates({ aps: 1.01 }), 3).pass).toBe(false)
  })

  test('gate 4: near-miss band [0.2, 0.4] inclusive', () => {
    expect(byId(gates({ frac: 0.2 }), 4).pass).toBe(true)
    expect(byId(gates({ frac: 0.4 }), 4).pass).toBe(true)
    expect(byId(gates({ frac: 0.19 }), 4).pass).toBe(false)
    expect(byId(gates({ frac: 0.41 }), 4).pass).toBe(false)
  })

  test('gate 5: ≥ 0.9 of deaths legible; zero deaths is vacuously true', () => {
    expect(byId(gates({ deaths: [] }), 5).pass).toBe(true)
    const nine = Array.from({ length: 10 }, (_, i) => ({ legible: i < 9 }))
    expect(byId(gates({ deaths: nine }), 5).pass).toBe(true)
    const eight = Array.from({ length: 10 }, (_, i) => ({ legible: i < 8 }))
    expect(byId(gates({ deaths: eight }), 5).pass).toBe(false)
  })

  test('gate 6: measured in seconds (2–4 min), not tick fractions', () => {
    expect(byId(gates({ greedyMedianTicks: 1800 }), 6).pass).toBe(true) // 180 s
    expect(byId(gates({ greedyMedianTicks: 1200 }), 6).pass).toBe(true) // 120 s boundary
    expect(byId(gates({ greedyMedianTicks: 1190 }), 6).pass).toBe(false) // 119 s
    expect(byId(gates({ greedyMedianTicks: 2400 }), 6).pass).toBe(true) // 240 s boundary
    expect(byId(gates({ greedyMedianTicks: 2410 }), 6).pass).toBe(false) // 241 s
    // The old "≥ 50% of roundTicks" rule would have passed a 90 s median:
    expect(byId(gates({ greedyMedianTicks: 900 }), 6).pass).toBe(false)
  })

  test('all six gates always present, ordered, with measured numbers', () => {
    const gs = gates()
    expect(gs.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6])
    for (const g of gs) {
      expect(Object.keys(g.measured).length).toBeGreaterThan(0)
      expect(g.detail.length).toBeGreaterThan(0)
    }
  })
})

// ── parseArgs ────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('defaults and full flag set', () => {
    expect(parseArgs([])).toEqual({ rounds: 100, seed: 1000, preset: 'default', json: null })
    expect(parseArgs(['--rounds', '5', '--seed', '9', '--preset', 'inferno', '--json', 'o.json'])).toEqual({
      rounds: 5,
      seed: 9,
      preset: 'inferno',
      json: 'o.json',
    })
  })

  test('rounds are floored at 1; garbage numbers throw', () => {
    expect(parseArgs(['--rounds', '0']).rounds).toBe(1)
    expect(() => parseArgs(['--rounds', 'abc'])).toThrow()
    expect(() => parseArgs(['--seed', 'xyz'])).toThrow()
  })

  test('unknown flags, bad presets, and missing values throw', () => {
    expect(() => parseArgs(['--bogus'])).toThrow()
    expect(() => parseArgs(['--preset', 'nightmare'])).toThrow()
    expect(() => parseArgs(['--rounds'])).toThrow()
  })
})
