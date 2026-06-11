/**
 * RandomKBot (§7) — the paper's Random-10% control. A seeded hash of the
 * chunk id picks a stable ~k% member set; members are tiered up toward
 * expanded, non-members tiered down toward chip. Respects the bus cap and
 * viewport headroom; panic-evicts when the stream is about to OOM.
 */

import type { Action, ChunkView, OracleView, SimView } from '../sim'
import { mix32 } from '../sim'
import { busFree, canDown, canUp, down, headroom, pressure, up, upFits, type OomBot } from './common'

const SALT = 0x5eedca11

export class RandomKBot implements OomBot {
  readonly name = 'random-k'
  private readonly frac: number
  private seed = 0

  constructor(opts?: { frac?: number }) {
    this.frac = opts?.frac ?? 0.1
  }

  reset(seed: number): void {
    this.seed = seed >>> 0
  }

  /** Stable membership: seeded hash of chunk id (order-independent). */
  private member(id: number): boolean {
    return mix32(mix32(this.seed, SALT), id >>> 0) / 4294967296 < this.frac
  }

  act(view: SimView, _oracle: OracleView | null): Action[] {
    const downables: ChunkView[] = []
    const memberUps: ChunkView[] = []
    for (const c of view.chunks) {
      if (canDown(c) && !this.member(c.id)) downables.push(c)
      if (canUp(c) && this.member(c.id)) memberUps.push(c)
    }

    // Panic: the stream adds ≤ 1 line/tick — evict the biggest thing we can,
    // member or not (survival outranks the policy).
    if (headroom(view) <= 2) {
      let victim: ChunkView | null = null
      for (const c of view.chunks) {
        if (!canDown(c)) continue
        if (
          victim === null ||
          c.linesNow > victim.linesNow ||
          (c.linesNow === victim.linesNow && c.id < victim.id)
        )
          victim = c
      }
      if (victim) return [down(victim)]
    }

    // Oldest-first downs; continue in-progress chains first for ups.
    downables.sort((a, b) => a.id - b.id)
    memberUps.sort((a, b) => b.tier - a.tier || a.id - b.id)

    const tryUp = (): Action | null => {
      if (busFree(view) <= 0) return null
      for (const c of memberUps) if (upFits(view, c, 2)) return up(c)
      return null
    }
    const tryDown = (): Action | null => (downables.length > 0 ? down(downables[0]!) : null)

    // Under pressure, prefer shedding lines; otherwise warm members first.
    const order = pressure(view) > 0.8 ? [tryDown, tryUp] : [tryUp, tryDown]
    for (const f of order) {
      const a = f()
      if (a) return [a]
    }
    return []
  }
}
