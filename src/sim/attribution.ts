/**
 * Death attribution (gate #5, OOM_DESIGN.md §7):
 * - 'oom'      → legible iff an evictable chunk (tier > 0, not protected /
 *                pinned / transferring) existed within attributionWindow
 *                ticks before death; the summary names it.
 * - 'collapse' → legible iff EITHER of two sufficient conditions holds
 *                (formulation fix, see PLAYTEST.md 2026-06-10 — viability
 *                was previously judged from telegraph time only, where a
 *                cold demanded chunk is unservable BY CONSTRUCTION because
 *                L_cold > telegraphStd, so those deaths read as illegible
 *                even though the heat channel had warned long before):
 *                (1) heat warning — every demanded glyph not served
 *                    expanded at landing showed heat ≥ HEAT_WARN_LEVEL at
 *                    least a full cold chain before the wave landed
 *                    (within heatHorizon), i.e. an attentive player could
 *                    have started the cold chain in time; or
 *                (2) telegraph viability — a viable response existed when
 *                    the telegraph fired: a warm (summary) chunk could
 *                    expand in time, or a bus slot freed early enough for
 *                    the needed fetch chain. Snapshot taken at telegraph.
 */

import type { SimConfig } from './config'
import type { DeathInfo, Tier } from './types'
import { needCount } from './util'

export interface EvictableMark {
  tick: number
  chunkId: number
  glyph: string
  tier: Tier
  lines: number
}

export function oomDeath(
  now: number,
  cfg: SimConfig,
  mark: EvictableMark | null,
): DeathInfo {
  const legible = mark !== null && now - mark.tick <= cfg.attributionWindow
  const summary = legible && mark
    ? `OOM at tick ${now}: next streamed line over budget; chunk #${mark.chunkId} [${mark.glyph}] ` +
      `(tier ${mark.tier}, ${mark.lines} line${mark.lines === 1 ? '' : 's'}) was evictable ` +
      `${now - mark.tick === 0 ? 'this tick' : `${now - mark.tick} ticks ago`} — a tier-down would have freed space.`
    : `OOM at tick ${now}: next streamed line over budget with no evictable chunk in the last ` +
      `${cfg.attributionWindow} ticks (everything protected, pinned, or mid-transfer) — pressure was unavoidable.`
  return { cause: 'oom', tick: now, legible, summary }
}

export interface WaveViability {
  viable: boolean
  note: string
}

export interface ViabilityChunk {
  readonly id: number
  readonly glyph: string
  readonly tier: Tier
  readonly transfer: { readonly toTier: Tier; readonly arriveTick: number } | null
}

/**
 * Snapshot at telegraph time: could the player still have served the wave?
 * Models B slots (seeded with current in-flight arrivals), serial chain
 * latencies, and the rule that a new leg starts the tick after an arrival.
 * Optimistic about the action budget (attribution heuristic, not feasibility).
 */
export function snapshotViability(
  cfg: SimConfig,
  now: number,
  wave: { glyphs: readonly string[]; landTick: number; sufficientExpandedFrac: number },
  chunks: readonly ViabilityChunk[],
  busArrivals: readonly number[],
): WaveViability {
  // Slot free-times: each in-flight transfer holds one slot until arrive+1.
  const slots: number[] = [...busArrivals].sort((a, b) => a - b).map((a) => a + 1)
  while (slots.length < cfg.B) slots.push(now + 1)
  while (slots.length > cfg.B) slots.shift() // defensive; cap holds in sim

  const need = needCount(wave.sufficientExpandedFrac, wave.glyphs.length)
  let served = 0
  const todo: { glyph: string; lat: number; gate: number; via: string; chunkId: number }[] = []

  for (const g of wave.glyphs) {
    const mine = chunks.filter((c) => c.glyph === g)
    if (mine.some((c) => c.tier === 2)) { served++; continue }
    if (mine.some((c) => c.transfer?.toTier === 2 && c.transfer.arriveTick <= wave.landTick)) {
      served++ // already arriving in time
      continue
    }
    // Best reachable plan per chunk: (gate = earliest start tick, lat = busy span once started)
    let best: { lat: number; gate: number; via: string; chunkId: number } | null = null
    for (const c of mine) {
      let cand: { lat: number; gate: number; via: string; chunkId: number } | null = null
      if (c.transfer) {
        if (c.transfer.toTier === 1) {
          cand = { lat: cfg.L_warm, gate: c.transfer.arriveTick + 1, via: `chunk #${c.id} arriving warm`, chunkId: c.id }
        }
      } else if (c.tier === 1) {
        cand = { lat: cfg.L_warm, gate: now + 1, via: `warm chunk #${c.id}`, chunkId: c.id }
      } else if (c.tier === 0) {
        cand = { lat: cfg.L_c2s + 1 + cfg.L_warm, gate: now + 1, via: `cold chunk #${c.id}`, chunkId: c.id }
      }
      if (cand && (!best || cand.lat + cand.gate < best.lat + best.gate)) best = cand
    }
    if (best) todo.push({ glyph: g, ...best })
  }

  // Greedily schedule the cheapest plans onto the slot timeline.
  todo.sort((a, b) => a.gate + a.lat - (b.gate + b.lat) || a.chunkId - b.chunkId)
  const notes: string[] = []
  for (const t of todo) {
    if (served >= need) break
    slots.sort((a, b) => a - b)
    const s = Math.max(slots[0] ?? now + 1, t.gate)
    const done = s + t.lat
    if (done <= wave.landTick) {
      served++
      slots[0] = done + 1
      notes.push(`${t.via} [${t.glyph}] could land t${done} ≤ t${wave.landTick}`)
    } else {
      notes.push(`${t.via} [${t.glyph}] lands t${done} > t${wave.landTick}`)
    }
  }

  const viable = served >= need
  const note = viable
    ? notes.length > 0
      ? notes[0]!
      : 'required glyphs already expanded or arriving'
    : todo.length === 0
      ? 'no fetchable chunk for the missing glyphs'
      : `only ${served}/${need} needed glyphs servable (${notes[notes.length - 1] ?? 'bus saturated'})`
  return { viable, note }
}

// ── heat-warning legibility (gate #5 formulation fix, see PLAYTEST.md) ──

/** Heat level the attribution treats as a player-visible warning (the
 *  telegraph-independent channel; §4.4 heat is honest pre-cliff). */
export const HEAT_WARN_LEVEL = 0.5

/** Full cold-chain latency — chip→summary (L_c2s), the one-tick handoff,
 *  then summary→expanded (L_warm). Matches the cold plan in
 *  snapshotViability. */
export function coldChainLatency(cfg: Pick<SimConfig, 'L_c2s' | 'L_warm'>): number {
  return cfg.L_c2s + 1 + cfg.L_warm
}

export interface HeatWarnChunk {
  readonly glyph: string
  /** Tier at death (== tier at landing; death fires on the land tick). */
  readonly tier: Tier
  /** Ticks at which this chunk's heat was ≥ HEAT_WARN_LEVEL. */
  readonly warnLog: readonly number[]
}

export interface HeatWarnVerdict {
  viable: boolean
  note: string
}

/**
 * Sufficient condition (1) for collapse legibility — formulation fix, see
 * PLAYTEST.md: judge from HEAT-WARNING time, not telegraph time. For each
 * demanded glyph that was NOT served expanded at landing, find the first
 * tick within the heat horizon of the landing at which ANY chunk of that
 * glyph showed heat ≥ HEAT_WARN_LEVEL (the horizon bound keeps warnings
 * from long-resolved earlier demands of the same glyph from counting). If
 * every such glyph warned at least a full cold chain before landing, an
 * attentive player could have started the cold chain in time: legible.
 */
export function heatWarnLegibility(
  cfg: Pick<SimConfig, 'L_c2s' | 'L_warm' | 'heatHorizon'>,
  landTick: number,
  glyphs: readonly string[],
  chunks: readonly HeatWarnChunk[],
): HeatWarnVerdict {
  const chain = coldChainLatency(cfg)
  const windowStart = landTick - cfg.heatHorizon
  // Weakest warning among the glyphs whose absence caused the miss.
  let worst: { glyph: string; span: number } | null = null
  for (const g of glyphs) {
    let served = false
    let first = Infinity
    for (const c of chunks) {
      if (c.glyph !== g) continue
      if (c.tier === 2) {
        served = true
        break
      }
      for (const t of c.warnLog) {
        if (t >= windowStart && t < landTick && t < first) first = t
      }
    }
    if (served) continue // expanded at landing — not part of the failure
    const span = first === Infinity ? 0 : landTick - first
    if (worst === null || span < worst.span) worst = { glyph: g, span }
  }
  if (worst === null)
    return { viable: false, note: 'every demanded glyph was served expanded (miss not caused by absence)' }
  if (worst.span >= chain)
    return {
      viable: true,
      note: `heat warned for ${worst.span} ticks before landing on every unserved glyph (cold chain needs ${chain})`,
    }
  return {
    viable: false,
    note: `heat warned for only ${worst.span} ticks on [${worst.glyph}] (cold chain needs ${chain})`,
  }
}

export function collapseDeath(
  now: number,
  wave: { id: number; glyphs: readonly string[]; telegraphTick: number },
  viability: WaveViability | null,
  heatWarn: HeatWarnVerdict | null = null,
): DeathInfo {
  const teleViable = viability?.viable ?? false
  const heatWarned = heatWarn?.viable ?? false
  const legible = heatWarned || teleViable
  const glyphs = wave.glyphs.join('')
  const head = `Coherence collapse at tick ${now}: wave #${wave.id} [${glyphs}] missed; `
  let summary: string
  if (teleViable) {
    // Telegraph viability first when both hold: it is the LATER of the two
    // player-visible signals — the most recent moment the loss was still
    // avoidable — which is the more damning thing to show on the death
    // screen.
    summary = head + `a viable response existed at telegraph (t${wave.telegraphTick}): ${viability!.note}.`
  } else if (heatWarned) {
    summary =
      head +
      `${heatWarn!.note} — an attentive player could have started the cold chain ` +
      `before the telegraph (t${wave.telegraphTick}).`
  } else {
    summary =
      head +
      `no viable response remained at telegraph (t${wave.telegraphTick}): ` +
      `${viability?.note ?? 'no viability snapshot'}` +
      `${heatWarn ? `; ${heatWarn.note}` : ''}.`
  }
  return { cause: 'collapse', tick: now, legible, summary }
}
