/**
 * Collapse attribution (gate #5): when a missed wave kills, legibility
 * reflects whether a viable response existed at telegraph time.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'

const CFG: SimConfig = {
  ...DEFAULTS,
  roundTicks: 4000,
  viewportLines: 60,
  actionBudget: 2,
  missCost: 60, // a few misses end it
  stdGlyphsMin: 1,
  stdGlyphsMax: 1,
  bossCount: 0,
  zenCount: 0,
}

describe('collapse death attribution', () => {
  test('legible when a warm chunk could have expanded in time', () => {
    // Strategy: pre-warm every demanded glyph to summary (so a viable warm
    // response exists at telegraph), then never expand → waves miss → die.
    const sim = createSim(CFG, 31)
    while (!sim.done) {
      const o = sim.oracleView()
      const acts: { kind: 'up' | 'down'; chunkId: number }[] = []
      for (const w of o.allWaves) {
        const g = w.glyphs[0]!
        const chunks = o.chunks.filter((c) => c.glyph === g)
        const warmOrBetter = chunks.some((c) => c.tier >= 1 || (c.transfer && c.transfer.toTier >= 1))
        if (!warmOrBetter && o.meters.busInFlight < CFG.B) {
          const c = chunks.find((k) => k.tier === 0 && !k.transfer && !k.protected)
          if (c) acts.push({ kind: 'up', chunkId: c.id })
        }
      }
      if (acts.length < CFG.actionBudget) {
        const e = o.chunks.find(
          (k) =>
            k.tier > 0 && !k.protected && !k.pinned && !k.transfer &&
            !o.allWaves.some((w) => w.glyphs.includes(k.glyph)),
        )
        if (e) acts.push({ kind: 'down', chunkId: e.id })
      }
      sim.tick(acts)
    }
    const death = sim.result().death!
    expect(death.cause).toBe('collapse')
    expect(death.legible).toBe(true)
    expect(death.summary).toContain('viable response existed')
    expect(death.summary).toMatch(/wave #\d+/)
  })

  test('illegible when demanded chunks were stone cold at telegraph', () => {
    // Pure evictor: everything ends up at chip; with L_c2s+L_warm >
    // telegraphStd no response at telegraph time can land in time.
    const sim = createSim(CFG, 31)
    while (!sim.done) {
      const o = sim.oracleView()
      const e = o.chunks.find((k) => k.tier > 0 && !k.protected && !k.pinned && !k.transfer)
      sim.tick(e ? [{ kind: 'down', chunkId: e.id }] : [])
    }
    const death = sim.result().death!
    expect(death.cause).toBe('collapse')
    expect(death.legible).toBe(false)
    expect(death.summary).toContain('no viable response')
  })
})
