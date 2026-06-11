/**
 * Distractor fairness (§4.4): heat is real but distractor glyphs NEVER
 * appear in any telegraph; spawn share grows with absolute history and
 * stays under the cap.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'
import { edfExecutor, run } from './helpers'

const CFG: SimConfig = {
  ...DEFAULTS,
  roundTicks: 2400,
  viewportLines: 60,
  actionBudget: 2,
  missCost: 0, // never collapse — we want the full 2.4k ticks of telegraphs
  distractorFrac: 0.2,
  distractorLeakPerChunk: 0.01,
  distractorFracCap: 0.4,
  calibrationLength: 4000,
}

describe('distractors', () => {
  test('distractor glyphs are never telegraphed across a 2.4k-tick round', () => {
    for (const seed of [3, 17]) {
      const sim = createSim(CFG, seed)
      const telegraphedGlyphs = new Set<string>()
      run(sim, edfExecutor(CFG), (ev, s) => {
        if (ev.telegraphed.length === 0) return
        const o = s.oracleView()
        for (const id of ev.telegraphed) {
          const w = o.allWaves.find((x) => x.id === id)
          for (const g of w?.glyphs ?? []) telegraphedGlyphs.add(g)
        }
      })
      const o = sim.oracleView()
      expect(o.distractorIds.size).toBeGreaterThanOrEqual(3) // they exist
      const distractorGlyphs = new Set(
        o.chunks.filter((c) => o.distractorIds.has(c.id)).map((c) => c.glyph),
      )
      expect(telegraphedGlyphs.size).toBeGreaterThan(0)
      for (const g of telegraphedGlyphs) expect(distractorGlyphs.has(g)).toBe(false)
      // distractors never demanded → nextDemand stays Infinity
      for (const id of o.distractorIds) expect(o.nextDemandByChunk.get(id)).toBe(Infinity)
    }
  })

  test('spawn share grows with history and respects the cap', () => {
    const sim = createSim({ ...CFG, roundTicks: 4000, calibrationLength: 10_000 }, 5)
    run(sim, edfExecutor(CFG))
    const o = sim.oracleView()
    const n = o.chunks.length
    expect(n).toBeGreaterThan(30)
    const half = Math.floor(n / 2)
    const early = o.chunks.slice(0, half).filter((c) => o.distractorIds.has(c.id)).length / half
    const late = o.chunks.slice(half).filter((c) => o.distractorIds.has(c.id)).length / (n - half)
    expect(late).toBeGreaterThan(early) // leakage: absolute inflation with history
    expect(late).toBeLessThanOrEqual(CFG.distractorFracCap + 0.15) // cap (binomial slack)
  })
})
