/**
 * Protected strip (§4.1): the newest protectedChunks chunks are expanded and
 * untouchable; chunks aging out of the strip become player-managed.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'
import { tickUntil } from './helpers'

const CFG: SimConfig = {
  ...DEFAULTS,
  viewportLines: 100,
  protectedChunks: 2,
  chunkTokensMin: 33,
  chunkTokensMax: 33,
  spawnGapMin: 10,
  spawnGapMax: 10,
  stdMinAge: 1_000_000,
  bossCount: 0,
  zenCount: 0,
  roundTicks: 100_000,
}

describe('protected strip', () => {
  test('newest N flagged; up/down/pin all rejected with protected', () => {
    const sim = createSim(CFG, 8)
    tickUntil(sim, (s) => s.view().chunks.length === 4)
    const v = sim.view()
    expect(v.chunks.map((c) => c.protected)).toEqual([false, false, true, true])
    // protected chunks are expanded (spawned expanded, never tiered down)
    expect(v.chunks[2]!.tier).toBe(2)
    expect(v.chunks[3]!.tier).toBe(2)
    for (const kind of ['up', 'down', 'pin'] as const) {
      const ev = sim.tick([{ kind, chunkId: 3 }])
      expect(ev.rejected[0]!.reason).toBe('protected')
      expect(ev.accepted).toHaveLength(0)
    }
    // unprotected neighbor is actionable
    expect(sim.tick([{ kind: 'down', chunkId: 1 }]).accepted).toHaveLength(1)
  })

  test('a chunk leaving the strip becomes actionable', () => {
    const sim = createSim(CFG, 8)
    tickUntil(sim, (s) => s.view().chunks.length === 4)
    expect(sim.tick([{ kind: 'down', chunkId: 2 }]).rejected[0]!.reason).toBe('protected')
    tickUntil(sim, (s) => s.view().chunks.length === 5) // c4 spawns → strip = {3,4}
    const v = sim.view()
    expect(v.chunks[2]!.protected).toBe(false)
    expect(v.chunks[3]!.protected).toBe(true)
    expect(v.chunks[4]!.protected).toBe(true)
    expect(sim.tick([{ kind: 'down', chunkId: 2 }]).accepted).toHaveLength(1)
  })
})
