/**
 * Feasibility invariant (§5.3, LAW): every committed wave is Oracle-clearable.
 * Checked END-TO-END against a hostile config (tiny B, long latencies): an
 * independent greedy EDF executor (not the director's internal greedy) must
 * clear every scheduled wave. Also: near-miss bookkeeping sanity (gate #4).
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig, type WaveResolution, type WaveView } from '../../src/sim'
import { edfExecutor, run } from './helpers'

const HOSTILE: SimConfig = {
  ...DEFAULTS,
  roundTicks: 2200,
  viewportLines: 60,
  actionBudget: 2,
  B: 1, // single bus slot
  L_c2s: 46,
  L_warm: 18, // chain = 64 (+1 leg gap) per cold chunk
  telegraphStd: 48, // 46+18 > 48 > 18 — structural law holds
  heatHorizon: 110,
  telegraphBoss: 150,
  bossGlyphs: 4,
  bossSufficiency: 0.5,
  bossCount: 2,
  stdMinAge: 120,
  spawnGapMin: 10,
  spawnGapMax: 18,
  chunkTokensMin: 33,
  chunkTokensMax: 55,
  glyphCount: 8,
  waveGapMin: 80,
  waveGapMax: 120,
  missCost: 8, // forgiving coherence so the round runs long regardless
  calibrationLength: 4000,
}

describe('feasibility invariant under a hostile config', () => {
  for (const seed of [1, 7, 1234]) {
    test(`seed ${seed}: greedy EDF oracle clears every scheduled wave`, () => {
      const sim = createSim(HOSTILE, seed)
      const resolutions: WaveResolution[] = []
      const seen = new Map<number, WaveView>()
      run(sim, edfExecutor(HOSTILE), (ev, s) => {
        for (const w of s.oracleView().allWaves) seen.set(w.id, w)
        resolutions.push(...ev.resolved)
      })
      // The run must be substantial and waves must actually flow.
      expect(sim.result().death?.cause ?? null).not.toBe('oom')
      expect(resolutions.length).toBeGreaterThanOrEqual(8)
      expect(resolutions.some((r) => r.archetype === 'boss')).toBe(true)

      const failures = resolutions
        .filter((r) => r.credit < HOSTILE.clearedAt - 1e-9)
        .map((r) => {
          const w = seen.get(r.waveId)!
          return `wave#${r.waveId} ${r.archetype} G=${w.glyphs.join('')} t${w.telegraphTick}→${w.landTick} credit=${r.credit.toFixed(2)}`
        })
      expect(failures).toEqual([])
      expect(resolutions.every((r) => r.cleared)).toBe(true)
    })
  }

  test('telegraph/land bookkeeping: helpful arrivals fall inside the window', () => {
    const sim = createSim(HOSTILE, 7)
    const byId = new Map<number, WaveView>()
    const resolutions: WaveResolution[] = []
    run(sim, edfExecutor(HOSTILE), (ev, s) => {
      for (const w of s.oracleView().allWaves) byId.set(w.id, w)
      resolutions.push(...ev.resolved)
    })
    let helpful = 0
    for (const r of resolutions) {
      const w = byId.get(r.waveId)!
      expect(w.landTick).toBeGreaterThan(w.telegraphTick)
      if (r.lastHelpfulArrival !== null) {
        helpful++
        expect(r.lastHelpfulArrival).toBeGreaterThanOrEqual(w.telegraphTick)
        expect(r.lastHelpfulArrival).toBeLessThanOrEqual(w.landTick)
      }
    }
    expect(helpful).toBeGreaterThan(0) // some transfers land inside windows
  })

  test('standard waves are cold-at-schedule: G chunks all chip at telegraph', () => {
    const sim = createSim(HOSTILE, 99)
    let checked = 0
    run(sim, edfExecutor(HOSTILE), (ev, s) => {
      if (ev.telegraphed.length === 0) return
      const o = s.oracleView()
      for (const id of ev.telegraphed) {
        const w = o.allWaves.find((x) => x.id === id)
        if (!w || w.archetype !== 'standard') continue
        // commit happens ≥ telegraph-time; the strongest player-visible claim
        // is min age — every demanded glyph existed well before the telegraph
        for (const g of w.glyphs) {
          const ages = o.chunks.filter((c) => c.glyph === g).map((c) => c.ageTicks)
          expect(Math.max(...ages)).toBeGreaterThanOrEqual(HOSTILE.stdMinAge)
        }
        checked++
      }
    })
    expect(checked).toBeGreaterThan(3)
  })
})
