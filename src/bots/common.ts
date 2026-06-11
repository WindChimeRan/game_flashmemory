/**
 * Shared bot plumbing (internal to src/bots).
 *
 * Bots are desire-based: act() recomputes intent from the current view every
 * tick, so sim rejections (bus-full, no-headroom) are retried automatically
 * on the next tick without explicit rejection feedback.
 */

import type { Action, BotPolicy, ChunkView, SimConfig, SimView } from '../sim'

/**
 * Extended bot surface understood by the runner:
 * - configure(cfg): rules knowledge (latencies, bus cap) — never future
 *   knowledge. Called before reset() each round when present.
 * - wantsOracle: true ONLY for OracleBot; the runner passes oracleView()
 *   solely to bots that declare it (contract: oracle non-null only there).
 */
export interface OomBot extends BotPolicy {
  configure?(config: SimConfig): void
  readonly wantsOracle?: boolean
}

/** Viewport fill fraction 0..1+. */
export const pressure = (view: SimView): number =>
  view.meters.viewportBudget > 0 ? view.meters.viewportUsed / view.meters.viewportBudget : 1

export const headroom = (view: SimView): number =>
  view.meters.viewportBudget - view.meters.viewportUsed

export const busFree = (view: SimView): number =>
  view.meters.busCap - view.meters.busInFlight

export const canDown = (c: ChunkView): boolean =>
  c.tier > 0 && !c.protected && !c.pinned && !c.transfer

export const canUp = (c: ChunkView): boolean =>
  c.tier < 2 && !c.protected && !c.transfer

/** Lines the sim will charge when tier-upping one step (target reservation). */
export const upDelta = (c: ChunkView): number =>
  c.linesByTier[(c.tier + 1) as 1 | 2] - c.linesByTier[c.tier]

/** Mirror of the sim's no-headroom acceptance, keeping `reserve` lines spare
 *  for the stream (it adds ≤ 1 line per tick). */
export const upFits = (view: SimView, c: ChunkView, reserve = 2): boolean =>
  view.meters.viewportUsed + upDelta(c) <= view.meters.viewportBudget - reserve

export const down = (c: ChunkView): Action => ({ kind: 'down', chunkId: c.id })
export const up = (c: ChunkView): Action => ({ kind: 'up', chunkId: c.id })

/** Smallest k with k/n ≥ frac, floored at 1 — mirrors sim/util.needCount
 *  (which the sim does not export); same 1e-9 slack as waveCredit. */
export const needOf = (frac: number, n: number): number =>
  Math.max(1, Math.ceil(frac * n - 1e-9))

/** Tier counting an in-flight transfer's destination. */
export const effTier = (c: ChunkView): number => (c.transfer ? c.transfer.toTier : c.tier)

/** Highest CURRENT tier among chunks of a glyph (-1 if none) — wave serving. */
export function glyphBestTier(view: SimView, glyph: string): number {
  let best = -1
  for (const c of view.chunks) if (c.glyph === glyph && c.tier > best) best = c.tier
  return best
}
