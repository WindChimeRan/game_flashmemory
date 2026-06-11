/**
 * bots — §7 control policies, the headless runner, and roster factory.
 * Imports sim only (ARCHITECTURE.md D2).
 *
 * Roster doctrine (2026-06-11, pending human review): ReactiveBot is the
 * strongest HEAT-BLIND reactive (gate #2 adversary); ParBot is the
 * heat+telegraph hybrid — the mechanical par for human play, expected to
 * sit between greedy-heat and oracle (gate #4 probe, not a gate-2 bot).
 */

export { RecencyBot } from './recency'
export { RandomKBot } from './randomk'
export { GreedyHeatBot, type GreedyHeatOptions } from './greedyheat'
export { ReactiveBot, type ReactiveOptions, type BlindWallPolicy } from './reactive'
export { ParBot, type ParOptions } from './par'
export { OracleBot, type OracleOptions } from './oracle'
export {
  runRound,
  runRoundDetailed,
  runMany,
  summarize,
  type BotSummary,
  type RoundDetail,
  type RunManyOutput,
  type RunRoundOpts,
  type WaveWindow,
} from './runner'
export type { OomBot } from './common'

import { GreedyHeatBot } from './greedyheat'
import { OracleBot } from './oracle'
import { ParBot } from './par'
import { RandomKBot } from './randomk'
import { ReactiveBot } from './reactive'
import { RecencyBot } from './recency'
import type { OomBot } from './common'

/** Fresh instances of the six §7 bots, weakest→strongest expected order. */
export function makeRoster(): OomBot[] {
  return [
    new RecencyBot(),
    new RandomKBot(),
    new GreedyHeatBot(),
    new ReactiveBot(),
    new ParBot(),
    new OracleBot(),
  ]
}

/** Build one bot by CLI name ('oom sim --bot recency' etc.). */
export function makeBot(name: string): OomBot {
  switch (name) {
    case 'recency':
      return new RecencyBot()
    case 'random':
    case 'random-k':
      return new RandomKBot()
    case 'greedy':
    case 'greedy-heat':
      return new GreedyHeatBot()
    case 'reactive':
      return new ReactiveBot()
    case 'par':
      return new ParBot()
    case 'oracle':
      return new OracleBot()
    default:
      throw new Error(`unknown bot '${name}' (recency | random-k | greedy-heat | reactive | par | oracle)`)
  }
}
