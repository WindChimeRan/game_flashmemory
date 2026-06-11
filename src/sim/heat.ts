/**
 * Heat channel (§4.4–4.5): per-tick deterministic heat + pips per chunk.
 *
 * - Honest chunk with a scheduled future demand: heat ramps 0.15 → 0.95 as
 *   landTick approaches within cfg.heatHorizon; idles low (~0.1) outside it.
 * - Honest never-demanded: idles low (~0.1).
 * - Distractor: REAL heat from recurring phantom ramps (same ramp shape,
 *   seeded phantom demand times) — but its glyph never appears in any
 *   telegraph. Spawn share grows with absolute spawned-chunk count.
 * - Gaussian noise σ = heatNoise pre-cliff, ramping irreversibly to
 *   heatNoiseCliff past 2 × calibrationLength (the 2× cliff, §4.5).
 * - Pips (§4.6): distractors mostly 1 (twoPipChance → 2); honest demanded
 *   within horizon → 3, demanded beyond → 2; honest never-demanded → 1.
 *
 * All randomness comes from each chunk's own forked stream, advanced once
 * per tick in chunk-id order — consumption never depends on player actions.
 */

import type { SimConfig } from './config'
import type { Rng } from './types'
import { gaussian } from './rng'

export const HEAT_IDLE = 0.1
export const HEAT_RAMP_LO = 0.15
export const HEAT_RAMP_HI = 0.95

export interface HeatChunk {
  readonly heatRng: Rng
  readonly distractor: boolean
  readonly twoPip: boolean
  phantomTick: number
  heat: number
  pips: number
}

/** Noise σ at a given tick (irreversible ramp past the 2× cliff). */
export function heatSigma(cfg: SimConfig, now: number): number {
  const cliff = 2 * cfg.calibrationLength
  if (now <= cliff) return cfg.heatNoise
  const ramp = Math.min(1, (now - cliff) / Math.max(1, cfg.calibrationLength))
  return cfg.heatNoise + (cfg.heatNoiseCliff - cfg.heatNoise) * ramp
}

/** Base (noise-free) heat for a demand `distance` ticks away. */
export function rampHeat(distance: number, horizon: number): number {
  if (distance > horizon || horizon <= 0) return HEAT_IDLE
  const t = 1 - Math.max(0, distance) / horizon
  return HEAT_RAMP_LO + (HEAT_RAMP_HI - HEAT_RAMP_LO) * t
}

/** Next phantom demand gap for a distractor (drawn from its own stream). */
export function nextPhantomGap(rng: Rng, cfg: SimConfig): number {
  const lo = Math.max(20, Math.round(cfg.heatHorizon * 0.4))
  const hi = Math.max(lo + 1, Math.round(cfg.heatHorizon * 1.9))
  return rng.int(lo, hi)
}

/**
 * Update one chunk's heat + pips for tick `now`.
 * `nextDemandTick` = next landTick demanding this chunk's glyph (Infinity
 * if never; always Infinity for distractors — they are never telegraphed).
 */
export function updateChunkHeat(
  c: HeatChunk,
  now: number,
  nextDemandTick: number,
  cfg: SimConfig,
): void {
  let base: number
  if (c.distractor) {
    if (now >= c.phantomTick) c.phantomTick = now + nextPhantomGap(c.heatRng, cfg)
    base = rampHeat(c.phantomTick - now, cfg.heatHorizon)
  } else if (nextDemandTick === Infinity) {
    base = HEAT_IDLE
  } else {
    base = rampHeat(nextDemandTick - now, cfg.heatHorizon)
  }
  const noise = gaussian(c.heatRng) * heatSigma(cfg, now)
  c.heat = Math.min(1, Math.max(0, base + noise))

  if (c.distractor) c.pips = c.twoPip ? 2 : 1
  else if (nextDemandTick === Infinity) c.pips = 1
  else c.pips = nextDemandTick - now <= cfg.heatHorizon ? 3 : 2
}
