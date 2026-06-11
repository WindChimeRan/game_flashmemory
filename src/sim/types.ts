/**
 * sim — contracts for the deterministic game core (OOM_DESIGN.md §4, §5.3).
 *
 * OWNED BY THE INTEGRATOR — implementation work must not edit this file.
 *
 * LAWS this module enforces (from the design freeze):
 * - Determinism (D4): all randomness via the seeded Rng; no Date.now, no
 *   Math.random. Same seed + same action stream ⇒ identical stateHash()
 *   at every tick.
 * - Commitment structure (§4.3): tier-ups are transfers (L_c2s, L_warm
 *   ticks; chain = L_cold), at most B in flight, in-flight is committed
 *   (no cancel, no evict), eviction is instant. Target-tier line cost is
 *   RESERVED when the transfer starts (visible immediately in residency).
 * - Spatial model (§4.1, unfrozen default): no scrolling; the newest
 *   `protectedChunks` chunks are expanded and untouchable; chips cost 0
 *   lines (rail); OOM = admission failure (next streamed line over budget).
 * - Feasibility invariant (§5.3): every scheduled wave is Oracle-clearable
 *   at spawn time under (L_c2s, L_warm, B, telegraph, current tiers,
 *   in-flight transfers, viewport headroom). The director pushes the land
 *   tick / shrinks G / rerolls until feasible.
 * - Distractors (§4.4): heat is real, glyphs never telegraphed, count
 *   grows with absolute history while the fraction stays capped.
 * - 2× cliff (§4.5): past 2 × calibrationLength ticks, heat noise ramps
 *   irreversibly (endless mode; standard rounds end before the cliff).
 *
 * Time: 1 tick = 1 displayed token (ARCHITECTURE.md D3).
 */

import type { SimConfig } from './config'

/** Deterministic PRNG handle. fork() derives an independent stream. */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number
  pick<T>(arr: readonly T[]): T
  /** Independent child stream, stable for a given (state, label). */
  fork(label: string): Rng
}

export const TIER_CHIP = 0
export const TIER_SUMMARY = 1
export const TIER_EXPANDED = 2
export type Tier = 0 | 1 | 2

export type Archetype = 'standard' | 'boss' | 'zen' | 'filler'

/** Director → ContentProvider: what a chunk is about (sim never sees prose). */
export interface ChunkSpec {
  chunkId: number
  glyph: string
  theme: string
  targetTokens: number
  /** Content RNG seed (derived; keeps providers deterministic). */
  seed: number
}

export interface TransferState {
  readonly toTier: Tier
  readonly startTick: number
  readonly arriveTick: number
}

/** Player/bot-visible chunk state. */
export interface ChunkView {
  readonly id: number
  readonly glyph: string
  readonly tier: Tier
  /** 0..1 predicted-relevance signal (the heat channel; §4.4 honesty rules). */
  readonly heat: number
  /** Corroboration pips 0..3 (§4.6); distractors are mostly single-pip. */
  readonly pips: number
  readonly pinned: boolean
  /** In the protected strip (newest chunks; untouchable). */
  readonly protected: boolean
  readonly transfer: TransferState | null
  /** Line cost at each tier: [chip, summary, expanded]. chip = 0. */
  readonly linesByTier: readonly [number, number, number]
  /** Lines currently counted against the viewport (incl. reservation). */
  readonly linesNow: number
  readonly ageTicks: number
  /** Tokens streamed so far / total (UI; equals total once finished). */
  readonly tokensShown: number
  readonly tokensTotal: number
}

export interface WaveView {
  readonly id: number
  readonly archetype: Archetype
  /** Demanded glyphs (the golden set G). */
  readonly glyphs: readonly string[]
  readonly telegraphTick: number
  readonly landTick: number
  /** Fraction of G that must be served EXPANDED for full credit (§4.4). */
  readonly sufficientExpandedFrac: number
}

export interface Meters {
  readonly viewportUsed: number
  readonly viewportBudget: number
  readonly coherence: number // 0..100
  readonly score: number
  readonly streak: number
  readonly busInFlight: number
  readonly busCap: number
  /** Mean residency fraction so far (Pareto component). */
  readonly residencyMean: number
}

export interface SimView {
  readonly tick: number
  readonly chunks: readonly ChunkView[]
  /** Telegraphed, unresolved waves (visible). */
  readonly waves: readonly WaveView[]
  readonly meters: Meters
  readonly zenActive: boolean
  /** Past the 2× cliff (heat channel degrading). */
  readonly cliffActive: boolean
  readonly done: boolean
}

/** Oracle-only extensions (OracleBot + director feasibility + gates). */
export interface OracleView extends SimView {
  /** ALL scheduled waves incl. not-yet-telegraphed. */
  readonly allWaves: readonly WaveView[]
  /** Chunk id → next tick its glyph is demanded (Infinity if never). */
  readonly nextDemandByChunk: ReadonlyMap<number, number>
  readonly distractorIds: ReadonlySet<number>
}

export type Action =
  | { kind: 'up'; chunkId: number } // start tier-up transfer (one step)
  | { kind: 'down'; chunkId: number } // instant tier-down (one step)
  | { kind: 'pin'; chunkId: number } // toggle pin (pin blocks 'down')

export type RejectReason =
  | 'no-such-chunk'
  | 'protected'
  | 'pinned'
  | 'transferring'
  | 'at-top'
  | 'at-bottom'
  | 'bus-full'
  | 'no-headroom'
  | 'action-budget'

export interface TickEvents {
  readonly accepted: readonly Action[]
  readonly rejected: readonly { action: Action; reason: RejectReason }[]
  /** Transfers that arrived this tick (chunkId, new tier). */
  readonly arrivals: readonly { chunkId: number; tier: Tier }[]
  /** Waves resolved this tick. */
  readonly resolved: readonly WaveResolution[]
  /** New chunk began streaming. */
  readonly spawned: readonly number[]
  /** Telegraphs that appeared this tick (wave ids). */
  readonly telegraphed: readonly number[]
  readonly death: DeathInfo | null
}

export interface WaveResolution {
  readonly waveId: number
  readonly archetype: Archetype
  /** Mean per-glyph credit (expanded=1, summary, chip, absent weights). */
  readonly credit: number // 0..1
  readonly cleared: boolean
  readonly coherenceDelta: number
  /**
   * For gate #4 (near-miss tension): latest arrival tick among transfers
   * that raised a demanded glyph's serving tier during the telegraph
   * window; null if no such transfer.
   */
  readonly lastHelpfulArrival: number | null
}

export type DeathCause = 'oom' | 'collapse' | null

export interface DeathInfo {
  readonly cause: Exclude<DeathCause, null>
  readonly tick: number
  /** Gate #5: was the loss attributable to a player-visible mistake
   *  within the attribution window? */
  readonly legible: boolean
  readonly summary: string
}

/** Per-round output consumed by the gates runner (§7). */
export interface RoundResult {
  readonly seed: number
  readonly ticksSurvived: number
  readonly roundTicks: number
  readonly survived: boolean
  readonly death: DeathInfo | null
  readonly waves: readonly WaveResolution[]
  readonly meanCredit: number // recall term
  readonly residencyMean: number
  readonly score: number
  /** survivalFrac × meanCredit × (1 − residencyMean). */
  readonly pareto: number
  readonly actionsAccepted: number
  readonly actionsRejected: number
  /** Accepted actions per second (ticksPerSec-normalized), mid-game. */
  readonly actionsPerSec: number
}

export interface Sim {
  readonly done: boolean
  readonly tickNow: number
  /** Advance one tick with the player's/bot's actions (≤ actionBudget). */
  tick(actions: readonly Action[]): TickEvents
  view(): SimView
  oracleView(): OracleView
  /** FNV-1a over the full logical state — determinism tests. */
  stateHash(): number
  /** Valid once done (or call early for a partial snapshot). */
  result(): RoundResult
  /** Specs for chunks spawned so far (content layer pulls prose). */
  chunkSpec(chunkId: number): ChunkSpec
  readonly config: SimConfig
}

/** Bot interface (src/bots). oracle is non-null ONLY for OracleBot. */
export interface BotPolicy {
  readonly name: string
  /** Called once per tick; return ≤ actionBudget actions. May keep state. */
  act(view: SimView, oracle: OracleView | null): Action[]
  /** Reset internal state for a new round. */
  reset(seed: number): void
}

export const SIM_CONTRACT_VERSION = 1
