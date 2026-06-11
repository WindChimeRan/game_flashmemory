/**
 * createSim must run validateConfig and throw listing every violation.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, preset } from '../../src/sim'

describe('config validation', () => {
  test('valid presets construct', () => {
    expect(() => createSim(preset('chill'), 1)).not.toThrow()
    expect(() => createSim(preset('default'), 1)).not.toThrow()
    expect(() => createSim(preset('inferno'), 1)).not.toThrow()
  })

  test('L_warm ≥ telegraphStd rejected', () => {
    expect(() => createSim({ ...DEFAULTS, L_warm: 40 }, 1)).toThrow(/L_warm/)
  })

  test('L_cold ≤ telegraphStd rejected', () => {
    expect(() => createSim({ ...DEFAULTS, L_c2s: 10, L_warm: 5 }, 1)).toThrow(/L_cold/)
  })

  test('summaryTTL laws: > telegraphStd, > L_warm + 2; Infinity and in-band finite values valid', () => {
    // A reaction-hedge made at telegraph must survive to the landing.
    expect(() => createSim({ ...DEFAULTS, summaryTTL: DEFAULTS.telegraphStd }, 1)).toThrow(/summaryTTL/)
    // Isolate the L_warm + 2 law (telegraph law satisfied: 29 > 28).
    expect(() => createSim({ ...DEFAULTS, L_warm: 27, summaryTTL: 29 }, 1)).toThrow(/summaryTTL/)
    expect(() => createSim({ ...DEFAULTS, summaryTTL: NaN }, 1)).toThrow(/summaryTTL/)
    expect(() => createSim({ ...DEFAULTS, summaryTTL: Infinity }, 1)).not.toThrow()
    expect(() => createSim({ ...DEFAULTS, summaryTTL: 29 }, 1)).not.toThrow()
  })

  test('protectedChunks < 1 and B < 1 rejected, both listed', () => {
    let msg = ''
    try {
      createSim({ ...DEFAULTS, protectedChunks: 0, B: 0 }, 1)
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain('protectedChunks')
    expect(msg).toContain('B ≥ 1')
  })

  test('config is frozen on the sim (no external mutation)', () => {
    const cfg = { ...DEFAULTS }
    const sim = createSim(cfg, 1)
    cfg.viewportLines = 1 // mutating the caller's object must not affect the sim
    expect(sim.config.viewportLines).toBe(DEFAULTS.viewportLines)
    expect(() => {
      ;(sim.config as { viewportLines: number }).viewportLines = 5
    }).toThrow()
  })
})
