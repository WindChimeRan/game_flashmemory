/**
 * Director (§5.3): owns all scheduling truth — chunk plans (glyph / theme /
 * size / distractor), zen windows, boss plans, and online wave commitment
 * under the FEASIBILITY INVARIANT: every committed wave is Oracle-clearable
 * under (L_c2s, L_warm, B, actionBudget, current tiers incl. in-flight,
 * viewport headroom) at commit time. Adjustment ladder when infeasible:
 * push landTick in steps → shrink G → reroll glyph set; all adjustments
 * are logged. Waves are never spawned unclearable.
 *
 * Distractor fairness (§4.4): the glyph alphabet is partitioned — wave
 * glyphs come only from the honest pool, so distractor glyphs can never be
 * telegraphed. Distractor spawn share = min(cap, frac + leak·spawnedCount).
 */

import type { SimConfig } from './config'
import type { Rng, Tier } from './types'
import { hashStr, mix32 } from './rng'
import { needCount } from './util'

// I/O dropped (confusable with 1/0); 24 usable badge letters.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const THEMES = [
  'archive', 'harbor', 'signal', 'orchard', 'engine',
  'letters', 'frontier', 'relic', 'market', 'storm',
] as const

const DEFER_STEP = 12
const PUSH_STEP = 10
const PUSH_MAX = 10
const REROLLS = 5

export interface DirectorChunk {
  readonly id: number
  readonly glyph: string
  readonly tier: Tier
  readonly transferTo: Tier | null
  readonly transferArrive: number
  readonly spawnTick: number
  readonly pinned: boolean
  readonly protected: boolean
  readonly expandedCost: number
  readonly linesNow: number
}

export interface ActiveDemand {
  readonly landTick: number
  readonly glyphs: readonly string[]
  readonly needCount: number
}

export interface DirectorWorld {
  readonly now: number
  readonly chunks: readonly DirectorChunk[]
  /** arriveTicks of all in-flight transfers (bus occupancy). */
  readonly busArrivals: readonly number[]
  readonly activeWaves: readonly ActiveDemand[]
}

export interface CommitWave {
  readonly archetype: 'standard' | 'boss'
  readonly glyphs: readonly string[]
  readonly telegraphTick: number
  readonly landTick: number
  readonly sufficientExpandedFrac: number
}

export interface ChunkPlan {
  readonly glyph: string
  readonly theme: string
  readonly targetTokens: number
  readonly distractor: boolean
  readonly seed: number
}

interface BossPlan {
  land: number
  done: boolean
}

/** Greedy oracle transfer simulation — shared by commit-time feasibility. */
export function greedyClearable(
  cfg: SimConfig,
  world: DirectorWorld,
  demands: readonly ActiveDemand[],
): boolean {
  if (demands.length === 0) return true
  const maxLand = Math.max(...demands.map((d) => d.landTick))

  // One candidate chunk per (glyph) — shared across waves demanding it.
  const byGlyph = new Map<string, { tier: number; busyTo: number; toTier: number; nextOk: number }>()
  const want = new Set<string>()
  for (const d of demands) for (const g of d.glyphs) want.add(g)
  for (const g of want) {
    let best: DirectorChunk | null = null
    for (const c of world.chunks) {
      if (c.glyph !== g) continue
      const eff = c.transferTo !== null ? c.transferTo : c.tier
      const bestEff = best ? (best.transferTo !== null ? best.transferTo : best.tier) : -1
      if (
        best === null ||
        eff > bestEff ||
        (eff === bestEff && (c.expandedCost < best.expandedCost ||
          (c.expandedCost === best.expandedCost && c.id < best.id)))
      ) best = c
    }
    if (!best) return false // demanded glyph with no chunk: unclearable
    byGlyph.set(g, {
      tier: best.tier,
      busyTo: best.transferTo !== null ? best.transferArrive : -1,
      toTier: best.transferTo !== null ? best.transferTo : best.tier,
      nextOk: world.now + 1,
    })
  }

  // Foreign bus occupancy: in-flight transfers NOT belonging to candidates.
  const candidateArrives = new Set<number>()
  for (const st of byGlyph.values()) if (st.busyTo >= 0) candidateArrives.add(st.busyTo)
  const foreign: number[] = []
  {
    const pool = [...candidateArrives]
    for (const a of world.busArrivals) {
      const i = pool.indexOf(a)
      if (i >= 0) pool.splice(i, 1)
      else foreign.push(a)
    }
  }

  const edf = [...demands].sort((a, b) => a.landTick - b.landTick)
  const glyphOrder = (d: ActiveDemand): string[] =>
    [...d.glyphs].sort((a, b) => (byGlyph.get(b)?.tier ?? -1) - (byGlyph.get(a)?.tier ?? -1) || (a < b ? -1 : 1))

  for (let t = world.now + 1; t <= maxLand; t++) {
    // step 0 analog: starts (a chunk arriving this tick is still busy here)
    let budget = cfg.actionBudget
    const occupied = (): number => {
      let n = 0
      for (const a of foreign) if (a >= t) n++
      for (const st of byGlyph.values()) if (st.busyTo >= t) n++
      return n
    }
    for (const d of edf) {
      if (budget <= 0) break
      if (d.landTick < t) continue
      let servedNow = 0
      for (const g of d.glyphs) {
        const st = byGlyph.get(g)!
        if (st.tier === 2 || (st.busyTo >= 0 && st.toTier === 2 && st.busyTo <= d.landTick)) servedNow++
      }
      if (servedNow >= d.needCount) continue
      for (const g of glyphOrder(d)) {
        if (budget <= 0) break
        const st = byGlyph.get(g)!
        if (st.tier === 2 || st.busyTo >= t || st.nextOk > t) continue
        if (st.busyTo >= 0 && st.toTier === 2) continue // already heading to top
        if (occupied() >= cfg.B) break
        const L = st.tier === 0 ? cfg.L_c2s : cfg.L_warm
        st.toTier = st.tier + 1
        st.busyTo = t + L
        budget--
        servedNow++
        if (servedNow >= d.needCount) break
      }
    }
    // step 1 analog: arrivals
    for (const st of byGlyph.values()) {
      if (st.busyTo === t) {
        st.tier = st.toTier
        st.busyTo = -1
        st.nextOk = t + 1
      }
    }
    // land checks (resolution happens after arrivals on the land tick)
    for (const d of edf) {
      if (d.landTick !== t) continue
      let served = 0
      for (const g of d.glyphs) if (byGlyph.get(g)!.tier === 2) served++
      if (served < d.needCount) return false
    }
  }
  return true
}

export class Director {
  readonly honestGlyphs: readonly string[]
  readonly distractorGlyphs: readonly string[]
  readonly zenWindows: readonly { start: number; end: number }[]
  readonly log: string[] = []

  private readonly cfg: SimConfig
  private readonly waveRng: Rng
  private readonly spawnRng: Rng
  private readonly bossPlans: BossPlan[]
  private nextStdLand: number
  private spawnedCount = 0
  private readonly lastSpawnByGlyph = new Map<string, number>()
  private readonly contentSeedBase: number
  /** Glyphs demanded by committed, not-yet-landed waves (spawn suppression). */
  private pendingDemands: { glyph: string; landTick: number }[] = []

  constructor(cfg: SimConfig, root: Rng, seed: number) {
    this.cfg = cfg
    this.waveRng = root.fork('director:waves')
    this.spawnRng = root.fork('director:spawn')
    const setup = root.fork('director:setup')
    this.contentSeedBase = mix32(seed >>> 0, hashStr('content'))

    // Seeded alphabet: shuffle, take glyphCount, carve a distractor pool.
    const letters = LETTERS.split('')
    for (let i = letters.length - 1; i > 0; i--) {
      const j = setup.int(0, i)
      const tmp = letters[i]!
      letters[i] = letters[j]!
      letters[j] = tmp
    }
    const n = Math.max(2, Math.min(cfg.glyphCount, letters.length))
    const chosen = letters.slice(0, n)
    const dCount = Math.min(n - 1, Math.max(1, Math.floor(n / 4)))
    this.honestGlyphs = chosen.slice(0, n - dCount)
    this.distractorGlyphs = chosen.slice(n - dCount)

    // Zen windows (§4.4): wave-free stretches, placed in the round's middle.
    const R = cfg.roundTicks
    const zen: { start: number; end: number }[] = []
    if (cfg.zenCount > 0) {
      const lo = Math.floor(R * 0.18)
      const hi = Math.floor(R * 0.85)
      const span = Math.max(1, Math.floor((hi - lo) / cfg.zenCount))
      for (let i = 0; i < cfg.zenCount; i++) {
        const len = setup.int(cfg.zenLenMin, cfg.zenLenMax)
        const slotLo = lo + i * span
        const start = setup.int(slotLo, Math.max(slotLo, slotLo + span - len - 40))
        const end = Math.min(start + len, R - 60)
        if (end > start) zen.push({ start, end })
      }
    }
    this.zenWindows = zen

    // Boss plans: past the midpoint, outside zen.
    const bosses: BossPlan[] = []
    if (cfg.bossCount > 0) {
      const lo = Math.floor(R * 0.55)
      const hi = Math.floor(R * 0.92)
      const span = Math.max(1, Math.floor((hi - lo) / cfg.bossCount))
      for (let i = 0; i < cfg.bossCount; i++) {
        let land = setup.int(
          lo + i * span + Math.floor(span * 0.15),
          lo + i * span + Math.floor(span * 0.75),
        )
        land = this.pushOutOfZen(land, 30)
        bosses.push({ land, done: false })
      }
    }
    this.bossPlans = bosses
    this.nextStdLand = setup.int(cfg.waveGapMin, cfg.waveGapMax)
  }

  inZen(t: number): boolean {
    for (const w of this.zenWindows) if (t >= w.start && t < w.end) return true
    return false
  }

  private pushOutOfZen(land: number, margin: number): number {
    let out = land
    for (let pass = 0; pass < this.zenWindows.length + 1; pass++) {
      let moved = false
      for (const w of this.zenWindows) {
        if (out >= w.start - margin && out < w.end + margin) {
          out = w.end + margin
          moved = true
        }
      }
      if (!moved) break
    }
    return out
  }

  /** Spawn-time plan for chunk `chunkId` (round-robin-ish glyphs, seeded sizes). */
  planChunk(now: number, chunkId: number): ChunkPlan {
    const cfg = this.cfg
    const share = Math.min(
      cfg.distractorFracCap,
      cfg.distractorFrac + cfg.distractorLeakPerChunk * this.spawnedCount,
    )
    const distractor = this.distractorGlyphs.length > 0 && this.spawnRng.next() < share
    const basePool = distractor ? this.distractorGlyphs : this.honestGlyphs
    // §4.4 "cold at telegraph time": never respawn a glyph that a committed,
    // unresolved wave demands — a fresh spawn lands expanded AND protected,
    // which would serve the wave for free with no possible counterplay.
    this.pendingDemands = this.pendingDemands.filter((d) => d.landTick > now)
    const demanded = new Set(this.pendingDemands.map((d) => d.glyph))
    const filtered = basePool.filter((g) => !demanded.has(g))
    const pool = filtered.length > 0 ? filtered : basePool
    // least-recently-spawned-first with jitter among the top 3
    const last = (g: string): number => this.lastSpawnByGlyph.get(g) ?? -1e9
    const ranked = [...pool].sort((a, b) => last(a) - last(b) || pool.indexOf(a) - pool.indexOf(b))
    const glyph = this.spawnRng.pick(ranked.slice(0, Math.min(3, ranked.length)))
    const targetTokens = this.spawnRng.int(cfg.chunkTokensMin, cfg.chunkTokensMax)
    const theme = THEMES[chunkId % THEMES.length]!
    this.lastSpawnByGlyph.set(glyph, now)
    this.spawnedCount++
    return { glyph, theme, targetTokens, distractor, seed: mix32(this.contentSeedBase, chunkId) }
  }

  /** Gap after a chunk finishes streaming, before the next spawn. */
  spawnGap(): number {
    return this.spawnRng.int(this.cfg.spawnGapMin, this.cfg.spawnGapMax)
  }

  /** Called once per tick (sim step 4): returns newly committed waves. */
  maybeCommit(world: DirectorWorld): CommitWave[] {
    const out: CommitWave[] = []
    // Demands committed earlier in THIS call: later feasibility checks must
    // see them, or two same-tick commits could jointly oversubscribe the bus.
    const extra: ActiveDemand[] = []
    const taken = (g: string): boolean =>
      world.activeWaves.some((w) => w.glyphs.includes(g)) ||
      out.some((w) => w.glyphs.includes(g))
    const commit = (w: CommitWave): void => {
      out.push(w)
      extra.push({
        landTick: w.landTick,
        glyphs: w.glyphs,
        needCount: needCount(w.sufficientExpandedFrac, w.glyphs.length),
      })
      for (const g of w.glyphs) this.pendingDemands.push({ glyph: g, landTick: w.landTick })
    }

    for (const p of this.bossPlans) {
      if (p.done || world.now < p.land - this.cfg.telegraphBoss) continue
      const w = this.tryBoss(world, p, taken, extra)
      if (w) {
        p.done = true
        commit(w)
      }
    }
    if (world.now >= this.nextStdLand - this.cfg.heatHorizon) {
      const w = this.tryStandard(world, taken, extra)
      if (w) commit(w)
    }
    return out
  }

  private tryStandard(
    world: DirectorWorld,
    taken: (g: string) => boolean,
    extra: readonly ActiveDemand[],
  ): CommitWave | null {
    const cfg = this.cfg
    const now = world.now
    if (this.nextStdLand === Infinity) return null
    const land = Math.max(
      this.pushOutOfZen(this.nextStdLand, cfg.telegraphStd),
      now + cfg.telegraphStd + 1,
    )
    if (land >= cfg.roundTicks) {
      this.nextStdLand = Infinity
      return null
    }

    // Cold-at-schedule + anti-recency (§4.4): every chunk of the glyph is
    // chip-tier, idle, and aged ≥ stdMinAge; glyph not already demanded.
    const eligible: string[] = []
    for (const g of this.honestGlyphs) {
      if (taken(g)) continue
      let any = false
      let ok = true
      for (const c of world.chunks) {
        if (c.glyph !== g) continue
        any = true
        if (c.tier !== 0 || c.transferTo !== null || now - c.spawnTick < cfg.stdMinAge) {
          ok = false
          break
        }
      }
      if (any && ok) eligible.push(g)
    }
    if (eligible.length === 0) {
      this.nextStdLand = land + DEFER_STEP
      this.log.push(`t${now} std defer→${this.nextStdLand}: no eligible cold glyphs`)
      return null
    }

    let gSize = Math.max(1, Math.min(this.waveRng.int(cfg.stdGlyphsMin, cfg.stdGlyphsMax), eligible.length))
    for (let attempt = 0; attempt < REROLLS; attempt++) {
      const G = this.sampleDistinct(eligible, gSize)
      for (let push = 0; push <= PUSH_MAX; push++) {
        const landTry = this.pushOutOfZen(land + push * PUSH_STEP, cfg.telegraphStd)
        if (landTry >= cfg.roundTicks) break
        const cand: ActiveDemand = { landTick: landTry, glyphs: G, needCount: G.length }
        const others = [...world.activeWaves, ...extra]
        if (
          greedyClearable(cfg, world, [...others, cand]) &&
          this.headroomOk(world, cand, others)
        ) {
          if (push > 0 || attempt > 0)
            this.log.push(`t${now} std adjusted: push=${push} reroll=${attempt} G=${G.join('')}`)
          this.nextStdLand = landTry + this.waveRng.int(cfg.waveGapMin, cfg.waveGapMax)
          return {
            archetype: 'standard',
            glyphs: G,
            telegraphTick: Math.max(now, landTry - cfg.telegraphStd),
            landTick: landTry,
            sufficientExpandedFrac: 1,
          }
        }
      }
      if (gSize > Math.max(1, cfg.stdGlyphsMin)) gSize--
    }
    this.nextStdLand = land + this.waveRng.int(cfg.waveGapMin, cfg.waveGapMax)
    this.log.push(`t${now} std slot skipped: infeasible after push/shrink/reroll`)
    return null
  }

  private tryBoss(
    world: DirectorWorld,
    p: BossPlan,
    taken: (g: string) => boolean,
    extra: readonly ActiveDemand[],
  ): CommitWave | null {
    const cfg = this.cfg
    const now = world.now
    if (p.land >= cfg.roundTicks - 10) {
      p.done = true
      this.log.push(`t${now} boss abandoned: ran past round end`)
      return null
    }

    // Old (aged) honest glyphs, scattered across spawn history; any tier.
    const oldest = new Map<string, number>()
    for (const c of world.chunks) {
      if (this.distractorGlyphs.includes(c.glyph)) continue
      const prev = oldest.get(c.glyph)
      if (prev === undefined || c.spawnTick < prev) oldest.set(c.glyph, c.spawnTick)
    }
    const eligible = [...oldest.entries()]
      .filter(([g, s]) => !taken(g) && now - s >= cfg.stdMinAge)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map(([g]) => g)
    if (eligible.length === 0) {
      p.land += 20
      this.log.push(`t${now} boss defer→${p.land}: no aged glyphs`)
      return null
    }

    let size = Math.min(cfg.bossGlyphs, eligible.length)
    const minSize = Math.max(2, Math.ceil(cfg.bossGlyphs / 2))
    for (let attempt = 0; attempt < REROLLS; attempt++) {
      const G = this.scatterPick(eligible, Math.max(1, size))
      const need = needCount(cfg.bossSufficiency, G.length)
      for (let push = 0; push <= PUSH_MAX; push++) {
        const landTry = this.pushOutOfZen(p.land + push * PUSH_STEP, 30)
        if (landTry >= cfg.roundTicks - 10) break
        const cand: ActiveDemand = { landTick: landTry, glyphs: G, needCount: need }
        const others = [...world.activeWaves, ...extra]
        if (
          greedyClearable(cfg, world, [...others, cand]) &&
          this.headroomOk(world, cand, others)
        ) {
          if (push > 0 || attempt > 0)
            this.log.push(`t${now} boss adjusted: push=${push} reroll=${attempt} G=${G.join('')}`)
          p.land = landTry
          return {
            archetype: 'boss',
            glyphs: G,
            telegraphTick: Math.max(now, landTry - cfg.telegraphBoss),
            landTick: landTry,
            sufficientExpandedFrac: cfg.bossSufficiency,
          }
        }
      }
      if (size > minSize) size--
    }
    p.land += 25
    this.log.push(`t${now} boss defer→${p.land}: infeasible after push/shrink/reroll`)
    return null
  }

  /** Headroom sanity: protected strip + pinned/in-flight floor + the needed
   *  expansions must fit the viewport (oracle may evict everything else).
   *  Expansions of OTHER active waves whose service windows overlap the
   *  candidate's count too: their reserved lines are resident at the same
   *  time, so ignoring them commits waves that are jointly line-infeasible
   *  even though each fits alone (the §5.3 law is about the whole chart). */
  private headroomOk(
    world: DirectorWorld,
    cand: ActiveDemand,
    others: readonly ActiveDemand[],
  ): boolean {
    const cfg = this.cfg
    const maxExp = Math.max(1, Math.ceil(cfg.chunkTokensMax / cfg.tokensPerLine))
    // A wave's expansions are resident from its latest-possible warm-leg
    // starts (staggered by B) until shortly after land (teardown ~1/tick).
    const span = (need: number): number =>
      cfg.L_warm * Math.ceil(need / Math.max(1, cfg.B)) + need + 2
    const concurrent = [
      cand,
      ...others.filter(
        (w) => Math.abs(w.landTick - cand.landTick) <= span(w.needCount) + span(cand.needCount),
      ),
    ]
    const demandedGlyphs = new Set<string>()
    for (const w of concurrent) for (const g of w.glyphs) demandedGlyphs.add(g)

    let fixed = cfg.protectedChunks * maxExp
    for (const c of world.chunks) {
      if (c.protected || demandedGlyphs.has(c.glyph)) continue
      if (c.pinned || c.transferTo !== null) fixed += c.linesNow
    }
    let demand = 0
    for (const w of concurrent) {
      const costs = w.glyphs.map((g) => this.candidateCost(world, g, maxExp))
      costs.sort((a, b) => a - b)
      for (let i = 0; i < Math.min(w.needCount, costs.length); i++) demand += costs[i]!
    }
    return fixed + demand + 2 <= cfg.viewportLines
  }

  /** Expanded line cost of the chunk greedyClearable would fetch for `g`
   *  (highest effective tier, then smallest cost, then smallest id). */
  private candidateCost(world: DirectorWorld, g: string, fallback: number): number {
    let best: DirectorChunk | null = null
    for (const c of world.chunks) {
      if (c.glyph !== g) continue
      const eff = c.transferTo !== null ? c.transferTo : c.tier
      const bestEff = best ? (best.transferTo !== null ? best.transferTo : best.tier) : -1
      if (
        best === null ||
        eff > bestEff ||
        (eff === bestEff &&
          (c.expandedCost < best.expandedCost ||
            (c.expandedCost === best.expandedCost && c.id < best.id)))
      )
        best = c
    }
    return best ? best.expandedCost : fallback
  }

  private sampleDistinct(pool: readonly string[], k: number): string[] {
    const copy = [...pool]
    const out: string[] = []
    while (out.length < k && copy.length > 0) {
      const i = this.waveRng.int(0, copy.length - 1)
      out.push(copy[i]!)
      copy.splice(i, 1)
    }
    return out
  }

  /** Evenly spaced picks across a spawn-ordered list, with seeded jitter. */
  private scatterPick(sorted: readonly string[], k: number): string[] {
    if (k >= sorted.length) return [...sorted]
    const step = sorted.length / k
    const used = new Set<number>()
    const out: string[] = []
    for (let i = 0; i < k; i++) {
      let idx = Math.min(sorted.length - 1, Math.floor(i * step + this.waveRng.next() * step))
      while (used.has(idx)) idx = (idx + 1) % sorted.length
      used.add(idx)
      out.push(sorted[idx]!)
    }
    return out
  }
}
