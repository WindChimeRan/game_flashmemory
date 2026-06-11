/**
 * Death attribution (gate #5, OOM_DESIGN.md §7):
 * - 'oom'      → legible iff an evictable chunk (tier > 0, not protected /
 *                pinned / transferring) existed within attributionWindow
 *                ticks before death; the summary names it.
 * - 'collapse' → legible iff, for the killing wave, a viable response
 *                existed at telegraph time: a warm (summary) chunk could
 *                expand in time, or a bus slot freed early enough for the
 *                needed fetch chain. Snapshot taken when the telegraph fires.
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

export function collapseDeath(
  now: number,
  wave: { id: number; glyphs: readonly string[]; telegraphTick: number },
  viability: WaveViability | null,
): DeathInfo {
  const legible = viability?.viable ?? false
  const glyphs = wave.glyphs.join('')
  const summary = legible
    ? `Coherence collapse at tick ${now}: wave #${wave.id} [${glyphs}] missed; a viable response existed ` +
      `at telegraph (t${wave.telegraphTick}): ${viability!.note}.`
    : `Coherence collapse at tick ${now}: wave #${wave.id} [${glyphs}] missed; no viable response remained ` +
      `at telegraph (t${wave.telegraphTick}): ${viability?.note ?? 'no viability snapshot'}.`
  return { cause: 'collapse', tick: now, legible, summary }
}
