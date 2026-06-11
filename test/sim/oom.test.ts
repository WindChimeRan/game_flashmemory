/**
 * OOM admission (§4.1): death fires exactly when counted lines first exceed
 * viewportLines — never before — and is attributed per gate #5.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type SimConfig } from '../../src/sim'

const BASE: SimConfig = {
  ...DEFAULTS,
  viewportLines: 8,
  protectedChunks: 1,
  chunkTokensMin: 33,
  chunkTokensMax: 33,
  spawnGapMin: 5,
  spawnGapMax: 5,
  stdMinAge: 1_000_000, // no waves
  bossCount: 0,
  zenCount: 0,
  roundTicks: 100_000,
}

describe('OOM admission failure', () => {
  test('triggers exactly when the budget is exceeded and never before', () => {
    const sim = createSim(BASE, 11)
    let prevUsed = 0
    let death = null
    for (let i = 0; i < 5000 && !sim.done; i++) {
      const used = sim.view().meters.viewportUsed
      expect(used).toBeLessThanOrEqual(BASE.viewportLines) // never before
      prevUsed = used
      const ev = sim.tick([])
      if (ev.death) death = ev.death
    }
    expect(death).not.toBeNull()
    expect(death!.cause).toBe('oom')
    // at death: over budget by exactly the newly streamed line
    const usedAtDeath = sim.view().meters.viewportUsed
    expect(usedAtDeath).toBe(BASE.viewportLines + 1)
    expect(prevUsed).toBeLessThanOrEqual(BASE.viewportLines)
    expect(sim.done).toBe(true)
    expect(death!.tick).toBe(sim.tickNow)

    const res = sim.result()
    expect(res.survived).toBe(false)
    expect(res.death?.cause).toBe('oom')
    expect(res.ticksSurvived).toBe(death!.tick)
  })

  test('legible when an evictable chunk existed (summary names it)', () => {
    const sim = createSim(BASE, 11)
    while (!sim.done) sim.tick([])
    const death = sim.result().death!
    expect(death.legible).toBe(true)
    expect(death.summary).toMatch(/chunk #\d+ \[[A-Z]\]/)
    expect(death.summary).toContain('evictable')
  })

  test('illegible when nothing was ever evictable (all protected)', () => {
    const sim = createSim({ ...BASE, protectedChunks: 99 }, 11)
    while (!sim.done) sim.tick([])
    const death = sim.result().death!
    expect(death.cause).toBe('oom')
    expect(death.legible).toBe(false)
    expect(death.summary).toContain('no evictable chunk')
  })

  test('player evictions stave off the death', () => {
    const sim = createSim(BASE, 11)
    let downs = 0
    while (!sim.done && sim.tickNow < 3000) {
      const v = sim.view()
      const target = v.chunks.find((c) => c.tier > 0 && !c.protected && !c.pinned && !c.transfer)
      if (v.meters.viewportUsed >= BASE.viewportLines - 1 && target) {
        const ev = sim.tick([{ kind: 'down', chunkId: target.id }])
        downs += ev.accepted.length
      } else {
        sim.tick([])
      }
    }
    expect(downs).toBeGreaterThan(10)
    expect(sim.tickNow).toBe(3000) // alive well past the no-action death tick
    expect(sim.done).toBe(false)
  })

  test('tick() after done is a no-op', () => {
    const sim = createSim(BASE, 11)
    while (!sim.done) sim.tick([])
    const t = sim.tickNow
    const h = sim.stateHash()
    const ev = sim.tick([{ kind: 'down', chunkId: 0 }])
    expect(ev.accepted).toHaveLength(0)
    expect(ev.death).toBeNull()
    expect(sim.tickNow).toBe(t)
    expect(sim.stateHash()).toBe(h)
  })
})
