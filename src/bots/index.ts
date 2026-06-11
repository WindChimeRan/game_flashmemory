/**
 * bots — §7 control policies, the headless runner, and roster factory.
 * Imports sim only (ARCHITECTURE.md D2).
 */

export { RecencyBot } from './recency'
export { RandomKBot } from './randomk'
export { GreedyHeatBot, type GreedyHeatOptions } from './greedyheat'
export { ReactiveBot, type ReactiveOptions } from './reactive'
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
import { RandomKBot } from './randomk'
import { ReactiveBot } from './reactive'
import { RecencyBot } from './recency'
import type { OomBot } from './common'

/** Fresh instances of the five §7 gate bots, weakest→strongest. */
export function makeRoster(): OomBot[] {
  return [new RecencyBot(), new RandomKBot(), new GreedyHeatBot(), new ReactiveBot(), new OracleBot()]
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
    case 'oracle':
      return new OracleBot()
    default:
      throw new Error(`unknown bot '${name}' (recency | random-k | greedy-heat | reactive | oracle)`)
  }
}
