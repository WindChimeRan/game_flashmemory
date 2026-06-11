/**
 * Sanity ordering over 10 seeds: Oracle survival ≥ Recency survival is a
 * SOFT expectation — violations log a warning (they are tuning signals, not
 * bot bugs) — but the test DOES fail if the Oracle crashes, fails to play
 * (zero ticks), or scores 0 across the board.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, type RoundResult } from '../../src/sim'
import { OracleBot, RecencyBot, runRound } from '../../src/bots'

const SEEDS = [3, 17, 42, 99, 123, 256, 512, 777, 901, 1234]

describe('oracle vs recency ordering (10 seeds)', () => {
  test('oracle never crashes, always plays, scores > 0; ordering soft-checked', () => {
    const oracle = new OracleBot()
    const recency = new RecencyBot()
    const oracleResults: RoundResult[] = []
    const recencyResults: RoundResult[] = []

    for (const seed of SEEDS) {
      let r: RoundResult
      try {
        r = runRound(DEFAULTS, seed, oracle)
      } catch (e) {
        throw new Error(`OracleBot crashed on seed ${seed}: ${String(e)}`)
      }
      expect(r.ticksSurvived).toBeGreaterThan(0)
      oracleResults.push(r)
      recencyResults.push(runRound(DEFAULTS, seed, recency))
    }

    // Hard: the oracle must actually score (waves resolve with credit > 0).
    const totalScore = oracleResults.reduce((s, r) => s + r.score, 0)
    expect(totalScore).toBeGreaterThan(0)
    const meanSurv =
      oracleResults.reduce((s, r) => s + r.ticksSurvived / r.roundTicks, 0) / oracleResults.length
    expect(meanSurv).toBeGreaterThan(0)

    // Soft: oracle should outlive recency; warn (don't fail) on violations.
    let violations = 0
    for (let i = 0; i < SEEDS.length; i++) {
      const o = oracleResults[i]!
      const r = recencyResults[i]!
      if (o.ticksSurvived < r.ticksSurvived) {
        violations++
        console.warn(
          `[ordering warning] seed ${SEEDS[i]}: oracle survived ${o.ticksSurvived} < recency ${r.ticksSurvived}`,
        )
      }
    }
    if (violations > 0)
      console.warn(`[ordering warning] oracle < recency on ${violations}/${SEEDS.length} seeds — tuning signal`)
  }, 30000)
})
