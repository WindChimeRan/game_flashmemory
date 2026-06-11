/**
 * D4: same seed + same action stream ⇒ identical stateHash at every tick.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim } from '../../src/sim'
import { scriptedActions } from './helpers'

describe('determinism', () => {
  test('two sims, same seed + script: equal stateHash every 50 ticks for 1800', () => {
    const script = scriptedActions(0xc0ffee, 1800)
    const a = createSim(DEFAULTS, 42)
    const b = createSim(DEFAULTS, 42)
    for (let t = 0; t < 1800; t++) {
      const acts = script[t]!
      a.tick(acts)
      b.tick(acts)
      if ((t + 1) % 50 === 0) {
        expect(a.stateHash()).toBe(b.stateHash())
        expect(a.tickNow).toBe(b.tickNow)
      }
    }
    expect(a.stateHash()).toBe(b.stateHash())
    expect(a.done).toBe(b.done)

    const ra = a.result()
    const rb = b.result()
    expect(ra.ticksSurvived).toBe(rb.ticksSurvived)
    expect(ra.score).toBe(rb.score)
    expect(ra.residencyMean).toBe(rb.residencyMean)
    expect(ra.actionsAccepted).toBe(rb.actionsAccepted)
    expect(ra.death?.tick ?? null).toBe(rb.death?.tick ?? null)

    // Heat is excluded from the hash but must match too (derived stream state).
    const va = a.view()
    const vb = b.view()
    expect(va.chunks.map((c) => c.heat)).toEqual(vb.chunks.map((c) => c.heat))
    expect(va.chunks.map((c) => c.pips)).toEqual(vb.chunks.map((c) => c.pips))
  })

  test('different seeds diverge', () => {
    const script = scriptedActions(7, 400)
    const a = createSim(DEFAULTS, 1)
    const b = createSim(DEFAULTS, 2)
    for (let t = 0; t < 400; t++) {
      a.tick(script[t]!)
      b.tick(script[t]!)
    }
    expect(a.stateHash()).not.toBe(b.stateHash())
  })

  test('chunkSpec is deterministic across sims', () => {
    const a = createSim(DEFAULTS, 99)
    const b = createSim(DEFAULTS, 99)
    for (let t = 0; t < 300; t++) {
      a.tick([])
      b.tick([])
    }
    expect(a.chunkSpec(0)).toEqual(b.chunkSpec(0))
    expect(a.chunkSpec(1)).toEqual(b.chunkSpec(1))
    expect(() => a.chunkSpec(9999)).toThrow()
  })
})
