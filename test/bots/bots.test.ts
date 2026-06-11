/**
 * Roster sanity: every §7 bot runs full rounds to completion on 5 seeds
 * without crashing, and is fully deterministic — same seed ⇒ identical
 * RoundResult and identical final sim stateHash, both when the SAME bot
 * instance is reset and when a FRESH instance is used.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS } from '../../src/sim'
import { makeRoster, runRoundDetailed } from '../../src/bots'

const SEEDS = [11, 22, 33, 44, 55]

describe('bot roster: completion + determinism', () => {
  const rosterA = makeRoster()
  const rosterB = makeRoster()
  expect(rosterA.map((b) => b.name)).toEqual(['recency', 'random-k', 'greedy-heat', 'reactive', 'oracle'])

  for (let i = 0; i < rosterA.length; i++) {
    const botA = rosterA[i]!
    const botB = rosterB[i]!
    test(`${botA.name}: 5 seeds run to completion, deterministic`, () => {
      for (const seed of SEEDS) {
        const d1 = runRoundDetailed(DEFAULTS, seed, botA)
        const d2 = runRoundDetailed(DEFAULTS, seed, botA) // same instance, after reset
        const d3 = runRoundDetailed(DEFAULTS, seed, botB) // fresh instance

        // Ran to completion: either survived the full round or died properly.
        expect(d1.result.ticksSurvived).toBeGreaterThan(0)
        expect(d1.result.survived || d1.result.death !== null).toBe(true)
        expect(d1.result.roundTicks).toBe(DEFAULTS.roundTicks)

        // Determinism: state hash and the full result object.
        expect(d2.finalHash).toBe(d1.finalHash)
        expect(d3.finalHash).toBe(d1.finalHash)
        expect(d2.result).toEqual(d1.result)
        expect(d3.result).toEqual(d1.result)
      }
    })
  }

  test('different seeds produce different rounds (sanity)', () => {
    const bot = makeRoster()[2]! // greedy-heat
    const a = runRoundDetailed(DEFAULTS, 101, bot)
    const b = runRoundDetailed(DEFAULTS, 202, bot)
    expect(a.finalHash).not.toBe(b.finalHash)
  })
})
