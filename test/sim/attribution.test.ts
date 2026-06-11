/**
 * Collapse attribution (gate #5): legibility has TWO sufficient conditions
 * (formulation fix, see PLAYTEST.md 2026-06-10):
 *  (1) heat warning — every unserved demanded glyph showed heat ≥ 0.5 at
 *      least a full cold chain (L_c2s + 1 + L_warm) before landing, within
 *      the heat horizon (an attentive player could have started the chain);
 *  (2) telegraph-time viability — a viable response existed when the
 *      telegraph fired (the original condition).
 * With heatNoise 0 the ramp is exact: heat ≥ 0.5 iff distance-to-landing
 * ≤ 0.5625·heatHorizon, so horizon 90 warns for 50 ticks (< 55 chain ⇒
 * condition 1 unsatisfiable) and horizon 130 warns for 73 (≥ 55 ⇒ fires).
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type Sim, type SimConfig } from '../../src/sim'
import {
  HEAT_WARN_LEVEL,
  coldChainLatency,
  collapseDeath,
  heatWarnLegibility,
  type HeatWarnChunk,
} from '../../src/sim/attribution'

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

/** Pure evictor: chip everything; demanded chunks end stone cold. */
function runEvictor(cfg: SimConfig, seed: number): Sim {
  const sim = createSim(cfg, seed)
  while (!sim.done) {
    const o = sim.oracleView()
    const e = o.chunks.find((k) => k.tier > 0 && !k.protected && !k.pinned && !k.transfer)
    sim.tick(e ? [{ kind: 'down', chunkId: e.id }] : [])
  }
  return sim
}

describe('collapse death attribution', () => {
  test('legible when a warm chunk could have expanded in time (telegraph condition)', () => {
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
    // Telegraph viability takes precedence in the summary when it holds.
    expect(death.summary).toContain('viable response existed')
    expect(death.summary).toMatch(/wave #\d+/)
  })

  test('illegible when stone cold at telegraph AND heat warned shorter than the cold chain', () => {
    // heatNoise 0 ⇒ deterministic: horizon 90 warns ≥0.5 for exactly 50
    // ticks before landing; cold chain is 40+1+14 = 55 > 50, so neither
    // sufficient condition can hold for a first-demand glyph.
    expect(coldChainLatency(CFG)).toBe(55)
    const sim = runEvictor({ ...CFG, heatNoise: 0 }, 31)
    const death = sim.result().death!
    expect(death.cause).toBe('collapse')
    expect(death.legible).toBe(false)
    expect(death.summary).toContain('no viable response')
    expect(death.summary).toContain('heat warned for only 50 ticks')
  })

  test('legible from HEAT-WARNING time when the horizon warns a full cold chain ahead', () => {
    // Same pure evictor (stone cold at telegraph — old rule said illegible),
    // but heatHorizon 130 warns ≥0.5 for floor(0.5625·130) = 73 ≥ 55 ticks:
    // an attentive player could have started the cold chain pre-telegraph.
    const sim = runEvictor({ ...CFG, heatNoise: 0, heatHorizon: 130 }, 31)
    const death = sim.result().death!
    expect(death.cause).toBe('collapse')
    expect(death.legible).toBe(true)
    expect(death.summary).toContain('heat warned for 73 ticks')
    expect(death.summary).toContain('could have started the cold chain')
  })
})

// ── heatWarnLegibility unit surface ──────────────────────────────────────

const HCFG = { L_c2s: 40, L_warm: 14, heatHorizon: 90 } // chain 55, window 90
const chunk = (glyph: string, tier: 0 | 1 | 2, warnLog: number[]): HeatWarnChunk => ({ glyph, tier, warnLog })

describe('heatWarnLegibility', () => {
  const land = 1000

  test('boundary: warned exactly chain ticks before landing is viable; one tick later is not', () => {
    expect(heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [land - 55])]).viable).toBe(true)
    expect(heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [land - 54])]).viable).toBe(false)
  })

  test('window: warnings older than heatHorizon (or at/after landing) are ignored', () => {
    // land−91 is outside the 90-tick window; land−90 is inside.
    expect(heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [land - 91])]).viable).toBe(false)
    expect(heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [land - 90])]).viable).toBe(true)
    expect(heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [land, land + 5])]).viable).toBe(false)
  })

  test('warnings union across chunks of the same glyph (any chunk warming counts)', () => {
    const cs = [chunk('A', 0, [land - 20]), chunk('A', 0, [land - 60])]
    const v = heatWarnLegibility(HCFG, land, ['A'], cs)
    expect(v.viable).toBe(true)
    expect(v.note).toContain('heat warned for 60 ticks')
  })

  test('glyphs served expanded at landing are exempt; unserved glyphs all must warn', () => {
    const served = chunk('A', 2, [])
    const warned = chunk('B', 0, [land - 70])
    const silent = chunk('C', 1, [land - 10])
    expect(heatWarnLegibility(HCFG, land, ['A', 'B'], [served, warned]).viable).toBe(true)
    const v = heatWarnLegibility(HCFG, land, ['A', 'B', 'C'], [served, warned, silent])
    expect(v.viable).toBe(false)
    expect(v.note).toContain('[C]')
    expect(v.note).toContain('only 10 ticks')
  })

  test('no warning at all → span 0; all glyphs served → not viable (vacuous)', () => {
    const v = heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 0, [])])
    expect(v.viable).toBe(false)
    expect(v.note).toContain('only 0 ticks')
    const all = heatWarnLegibility(HCFG, land, ['A'], [chunk('A', 2, [])])
    expect(all.viable).toBe(false)
    expect(all.note).toContain('served expanded')
  })

  test('coldChainLatency and HEAT_WARN_LEVEL pin the contract', () => {
    expect(coldChainLatency({ L_c2s: 40, L_warm: 14 })).toBe(55)
    expect(coldChainLatency({ L_c2s: 10, L_warm: 5 })).toBe(16)
    expect(HEAT_WARN_LEVEL).toBe(0.5)
  })
})

// ── collapseDeath combination of the two sufficient conditions ──────────

describe('collapseDeath condition combination', () => {
  const wave = { id: 7, glyphs: ['A', 'B'], telegraphTick: 900 }
  const tele = { viable: true, note: 'warm chunk #3 [A] could land t990 ≤ t1000' }
  const teleNo = { viable: false, note: 'no fetchable chunk for the missing glyphs' }
  const warm = { viable: true, note: 'heat warned for 60 ticks before landing on every unserved glyph (cold chain needs 55)' }
  const warmNo = { viable: false, note: 'heat warned for only 12 ticks on [B] (cold chain needs 55)' }

  test('either condition alone makes the death legible; neither leaves it illegible', () => {
    expect(collapseDeath(1000, wave, tele, warmNo).legible).toBe(true)
    expect(collapseDeath(1000, wave, teleNo, warm).legible).toBe(true)
    expect(collapseDeath(1000, wave, tele, warm).legible).toBe(true)
    expect(collapseDeath(1000, wave, teleNo, warmNo).legible).toBe(false)
    expect(collapseDeath(1000, wave, null, null).legible).toBe(false)
  })

  test('summaries: telegraph wins when both hold; heat branch names the warning; illegible carries both notes', () => {
    expect(collapseDeath(1000, wave, tele, warm).summary).toContain('viable response existed')
    const heatOnly = collapseDeath(1000, wave, teleNo, warm).summary
    expect(heatOnly).toContain('heat warned for 60 ticks')
    expect(heatOnly).toContain('could have started the cold chain')
    const neither = collapseDeath(1000, wave, teleNo, warmNo).summary
    expect(neither).toContain('no viable response')
    expect(neither).toContain('heat warned for only 12 ticks')
    // Back-compat: callers without heat info still get the old shape.
    expect(collapseDeath(1000, wave, teleNo).summary).toContain('no viable response')
  })
})
