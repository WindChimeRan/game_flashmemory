/**
 * Wave credit math (§4.4): per-glyph weights, mean, boss sufficiency edge,
 * coherence/score/streak deltas at resolution.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, waveCredit, type SimConfig, type Tier } from '../../src/sim'
import { edfExecutor, run } from './helpers'

const cfg = DEFAULTS

describe('waveCredit (pure)', () => {
  test('per-glyph weights and mean', () => {
    expect(waveCredit([2], 1, cfg)).toBe(1)
    expect(waveCredit([1], 1, cfg)).toBeCloseTo(cfg.creditSummary, 10)
    expect(waveCredit([0], 1, cfg)).toBeCloseTo(cfg.creditChip, 10)
    expect(waveCredit([-1], 1, cfg)).toBe(0)
    expect(waveCredit([2, 1], 1, cfg)).toBeCloseTo((1 + cfg.creditSummary) / 2, 10)
    expect(waveCredit([2, 2, 0], 1, cfg)).toBeCloseTo((2 + cfg.creditChip) / 3, 10)
    expect(waveCredit([], 1, cfg)).toBe(1)
  })

  test('standard: full credit only at full G expanded', () => {
    expect(waveCredit([2, 2], 1, cfg)).toBe(1)
    expect(waveCredit([2, 1], 1, cfg)).toBeLessThan(cfg.clearedAt) // 0.725 — not cleared
  })

  test('boss sufficiency edge: exactly at the fraction → full credit', () => {
    // 5 glyphs, sufficiency 0.6 → 3 expanded is exactly sufficient
    expect(waveCredit([2, 2, 2, 0, 0], 0.6, cfg)).toBe(1)
    // just below: 2/5 = 0.4 → mean credit instead
    expect(waveCredit([2, 2, 0, 0, 0], 0.6, cfg)).toBeCloseTo((2 + 3 * cfg.creditChip) / 5, 10)
    // floating-point boundary: 3/5 with sufficiency 0.6 must not lose to fp error
    expect(waveCredit([2, 2, 2, 1, 1], 3 / 5, cfg)).toBe(1)
  })
})

describe('resolution integration (coherence / score / streak)', () => {
  const C: SimConfig = {
    ...DEFAULTS,
    roundTicks: 1400,
    viewportLines: 60,
    actionBudget: 2,
    missCost: 30,
    bossCount: 0,
    zenCount: 0,
  }

  test('misses drain coherence by missCost·(1−credit); clears regen and streak', () => {
    const sim = createSim(C, 21)
    let coherence = C.coherenceMax
    let score = 0
    let streak = 0
    run(sim, edfExecutor(C), (ev) => {
      for (const r of ev.resolved) {
        const dmg = C.missCost * (1 - r.credit) * (r.archetype === 'boss' ? C.bossMissMul : 1)
        let expected = coherence - dmg + (r.cleared ? C.regenPerClear : 0)
        expected = Math.max(0, Math.min(C.coherenceMax, expected))
        expect(r.coherenceDelta).toBeCloseTo(expected - coherence, 8)
        coherence = expected
        const mul = Math.min(C.streakCap, 1 + C.streakStep * streak)
        score += C.wavePoints * r.credit * mul
        streak = r.cleared ? streak + 1 : 0
        expect(r.cleared).toBe(r.credit >= C.clearedAt - 1e-9)
      }
    })
    const res = sim.result()
    expect(res.waves.length).toBeGreaterThan(3)
    // executor should clear everything → streak grew, score matches the model
    // (score also accrues zen-free here: zenCount 0 → only wave points)
    expect(sim.view().meters.streak).toBe(streak)
    expect(sim.view().meters.coherence).toBeCloseTo(coherence, 6)
    expect(res.score).toBeCloseTo(score, 6)
  })

  test('serving tier = best ARRIVED tier; in-flight does not count', () => {
    // Reactive-only driver: waits for the telegraph, then fetches — with
    // default L_c2s+L_warm > telegraphStd the transfer cannot ARRIVE in time,
    // so credit stays at chip level even though a transfer is in flight.
    const C2: SimConfig = { ...C, missCost: 5, stdGlyphsMin: 1, stdGlyphsMax: 1 }
    const sim = createSim(C2, 33)
    const fetched = new Set<number>()
    let sawInFlightAtLand = false
    while (!sim.done) {
      const o = sim.oracleView()
      const acts: { kind: 'up' | 'down'; chunkId: number }[] = []
      const tele = o.waves[0] // telegraphed only — reactive play
      if (tele) {
        for (const g of tele.glyphs) {
          const c = o.chunks.find((k) => k.glyph === g && !k.transfer && k.tier < 2 && !k.protected)
          if (c && !fetched.has(c.id) && o.meters.busInFlight < C2.B) {
            acts.push({ kind: 'up', chunkId: c.id })
            fetched.add(c.id)
          }
        }
      }
      if (acts.length === 0) {
        // tidy: keep old chunks cold so waves keep scheduling
        const e = o.chunks.find(
          (k) => k.tier > 0 && !k.protected && !k.transfer && !o.waves.some((w) => w.glyphs.includes(k.glyph)),
        )
        if (e) acts.push({ kind: 'down', chunkId: e.id })
      }
      const ev = sim.tick(acts)
      for (const r of ev.resolved) {
        const wave = o.waves.find((w) => w.id === r.waveId) // wave known pre-tick
        if (!wave) continue
        // serving tier = best ARRIVED tier (transfer field ignored entirely)
        const post = sim.view().chunks
        const best = wave.glyphs.map((g) => {
          let b: Tier | -1 = -1
          for (const c of post) if (c.glyph === g && c.tier > b) b = c.tier
          return b
        })
        expect(r.credit).toBeCloseTo(waveCredit(best, wave.sufficientExpandedFrac, C2), 10)
        const inFlight = post.some((c) => wave.glyphs.includes(c.glyph) && c.transfer !== null)
        if (inFlight && best.some((b) => b < 2)) {
          sawInFlightAtLand = true
          expect(r.credit).toBeLessThan(1) // the in-flight fetch did NOT count
        }
      }
    }
    expect(sawInFlightAtLand).toBe(true) // the cold-react trap actually bit
  })
})
