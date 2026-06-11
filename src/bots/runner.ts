/**
 * Headless runner (§7): drives a BotPolicy against a fresh sim, one act()
 * per tick, until the round ends. runRoundDetailed additionally records the
 * telegraph/land window of every committed wave (gate #4 needs windows for
 * resolved waves; RoundResult alone does not carry them).
 */

import { createSim } from '../sim'
import type { Archetype, BotPolicy, RoundResult, SimConfig } from '../sim'
import type { OomBot } from './common'

export interface WaveWindow {
  telegraphTick: number
  landTick: number
  archetype: Archetype
}

export interface RoundDetail {
  result: RoundResult
  /** Final sim stateHash — determinism checks. */
  finalHash: number
  /** waveId → window; null unless trackWaves was requested. */
  waveWindows: Map<number, WaveWindow> | null
}

export interface RunRoundOpts {
  trackWaves?: boolean
}

export function runRoundDetailed(
  config: SimConfig,
  seed: number,
  bot: BotPolicy,
  opts?: RunRoundOpts,
): RoundDetail {
  const b = bot as OomBot
  b.configure?.(config)
  bot.reset(seed)
  const sim = createSim(config, seed)
  const wantsOracle = b.wantsOracle === true
  const track = opts?.trackWaves === true
  const windows = track ? new Map<number, WaveWindow>() : null
  const maxIter = config.roundTicks + 16 // sim ends at roundTicks; guard anyway

  for (let i = 0; i < maxIter && !sim.done; i++) {
    const oracle = wantsOracle || track ? sim.oracleView() : null
    // Non-oracle bots get a plain SimView even when trackWaves builds an
    // OracleView for window recording — handing them the OracleView object
    // would let a buggy/cheating policy probe allWaves/nextDemandByChunk.
    // For OracleBot the OracleView doubles as the view (it extends SimView).
    const view = wantsOracle && oracle !== null ? oracle : sim.view()
    if (windows && oracle) {
      for (const w of oracle.allWaves) {
        if (!windows.has(w.id))
          windows.set(w.id, { telegraphTick: w.telegraphTick, landTick: w.landTick, archetype: w.archetype })
      }
    }
    sim.tick(bot.act(view, wantsOracle ? oracle : null))
  }
  return { result: sim.result(), finalHash: sim.stateHash(), waveWindows: windows }
}

export function runRound(config: SimConfig, seed: number, bot: BotPolicy): RoundResult {
  return runRoundDetailed(config, seed, bot).result
}

export interface BotSummary {
  bot: string
  rounds: number
  meanSurvivalFrac: number
  medianSurvivalFrac: number
  meanTicksSurvived: number
  medianTicksSurvived: number
  meanCredit: number
  meanResidency: number
  meanPareto: number
  meanScore: number
  meanActionsPerSec: number
  deaths: number
  oomDeaths: number
  collapseDeaths: number
  legibleDeaths: number
  /** legibleDeaths / deaths; 1 when there were no deaths (vacuous). */
  deathLegibilityRate: number
}

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function summarize(bot: string, results: readonly RoundResult[]): BotSummary {
  const survFrac = results.map((r) => Math.min(1, r.ticksSurvived / r.roundTicks))
  const deaths = results.filter((r) => r.death !== null)
  const legible = deaths.filter((r) => r.death!.legible)
  return {
    bot,
    rounds: results.length,
    meanSurvivalFrac: mean(survFrac),
    medianSurvivalFrac: median(survFrac),
    meanTicksSurvived: mean(results.map((r) => r.ticksSurvived)),
    medianTicksSurvived: median(results.map((r) => r.ticksSurvived)),
    meanCredit: mean(results.map((r) => r.meanCredit)),
    meanResidency: mean(results.map((r) => r.residencyMean)),
    meanPareto: mean(results.map((r) => r.pareto)),
    meanScore: mean(results.map((r) => r.score)),
    meanActionsPerSec: mean(results.map((r) => r.actionsPerSec)),
    deaths: deaths.length,
    oomDeaths: deaths.filter((r) => r.death!.cause === 'oom').length,
    collapseDeaths: deaths.filter((r) => r.death!.cause === 'collapse').length,
    legibleDeaths: legible.length,
    deathLegibilityRate: deaths.length === 0 ? 1 : legible.length / deaths.length,
  }
}

export interface RunManyOutput {
  results: RoundResult[]
  summary: BotSummary
}

export function runMany(config: SimConfig, seeds: readonly number[], bot: BotPolicy): RunManyOutput {
  const results = seeds.map((s) => runRound(config, s, bot))
  return { results, summary: summarize(bot.name, results) }
}
