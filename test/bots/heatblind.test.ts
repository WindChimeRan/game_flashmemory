/**
 * Heat-blind doctrine enforcement (2026-06-11, see PLAYTEST.md): the gate-2
 * ReactiveBot must NEVER read the predictive channels chunk.heat /
 * chunk.pips. Enforcement is mechanical, not by code review: every ChunkView
 * handed to the bot is wrapped in a Proxy that THROWS on heat/pips access,
 * and the bot plays FULL rounds against it — all wall policies, plus a
 * finite-summaryTTL round (the decay-aware paths must be blind too).
 *
 * The probe itself is validated against heat-reading bots (GreedyHeatBot,
 * ParBot must trip it — otherwise the test is vacuous), and the proxied
 * round is checked hash-identical to a plain round (blindness is a property
 * of the bot, not an artifact of the wrapper).
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULTS, createSim, type ChunkView, type SimConfig, type SimView } from '../../src/sim'
import { GreedyHeatBot, ParBot, ReactiveBot, runRoundDetailed, type OomBot } from '../../src/bots'

class HeatReadError extends Error {}

function blindChunk(c: ChunkView, who: string): ChunkView {
  return new Proxy(c, {
    get(target, prop, receiver) {
      if (prop === 'heat' || prop === 'pips')
        throw new HeatReadError(`${who} read chunk.${String(prop)} — heat-blind doctrine violation`)
      return Reflect.get(target, prop, receiver)
    },
  })
}

function blindView(view: SimView, who: string): SimView {
  return { ...view, chunks: view.chunks.map((c) => blindChunk(c, who)) }
}

/** Full round where the bot only ever sees proxied views. */
function runBlindRound(cfg: SimConfig, seed: number, bot: OomBot): { finalHash: number; survivedTicks: number } {
  bot.configure?.(cfg)
  bot.reset(seed)
  const sim = createSim(cfg, seed)
  const maxIter = cfg.roundTicks + 16
  for (let i = 0; i < maxIter && !sim.done; i++) {
    sim.tick(bot.act(blindView(sim.view(), bot.name), null))
  }
  return { finalHash: sim.stateHash(), survivedTicks: sim.result().ticksSurvived }
}

describe('heat-blind enforcement (gate-2 ReactiveBot)', () => {
  test('probe is not vacuous: heat-reading bots trip it on tick 1', () => {
    for (const bot of [new GreedyHeatBot(), new ParBot()] as OomBot[]) {
      bot.configure?.(DEFAULTS)
      bot.reset(1)
      const sim = createSim(DEFAULTS, 1)
      expect(() => {
        for (let i = 0; i < DEFAULTS.roundTicks && !sim.done; i++) {
          sim.tick(bot.act(blindView(sim.view(), bot.name), null))
        }
      }).toThrow(HeatReadError)
    }
  })

  test('fielded ReactiveBot plays full proxied rounds on 3 seeds without touching heat/pips', () => {
    for (const seed of [11, 4000, 9001]) {
      const blind = runBlindRound(DEFAULTS, seed, new ReactiveBot())
      expect(blind.survivedTicks).toBeGreaterThan(0)
      // Blindness is real: the proxied round is the SAME round.
      const plain = runRoundDetailed(DEFAULTS, seed, new ReactiveBot())
      expect(blind.finalHash).toBe(plain.finalHash)
    }
  })

  test('every wall policy variant is heat-blind (the whole A/B family)', () => {
    for (const wall of ['none', 'uniform', 'recency', 'eligible'] as const) {
      const r = runBlindRound(DEFAULTS, 4001, new ReactiveBot({ wall }))
      expect(r.survivedTicks).toBeGreaterThan(0)
    }
  })

  test('decay-aware paths are blind too (finite summaryTTL full round)', () => {
    const cfg: SimConfig = { ...DEFAULTS, summaryTTL: 55 }
    const blind = runBlindRound(cfg, 4011, new ReactiveBot())
    const plain = runRoundDetailed(cfg, 4011, new ReactiveBot())
    expect(blind.finalHash).toBe(plain.finalHash)
  })
})
