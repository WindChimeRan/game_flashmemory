/**
 * Deterministic game core (OOM_DESIGN.md §4, §5.3; contract src/sim/types.ts).
 *
 * Tick order (fixed):
 *   0. accept ≤ actionBudget actions in order (validate → accept/reject)
 *   1. advance transfers, fire arrivals at arriveTick
 *   2. stream: newest chunk +1 token; finished → schedule next spawn
 *   3. admission check: counted lines > viewportLines → death 'oom'
 *   4. waves: director commits → telegraphs fire → landings resolve
 *   5. heat / pips update (per-chunk forked rng streams)
 *   6. zen scoring accrual
 *   7. meters, residency running mean, evictability bookkeeping
 *
 * Line accounting: chip 0, summary 1, expanded max(1, ceil(tokens/perLine));
 * a transferring chunk counts max(current, target) from transfer START
 * (§4.3 reservation). Eviction is instant; in-flight is committed.
 */

import type { SimConfig } from './config'
import { validateConfig } from './config'
import type {
  Action, Archetype, ChunkSpec, ChunkView, DeathInfo, Meters, OracleView,
  RejectReason, RoundResult, Rng, Sim, SimView, TickEvents, Tier,
  TransferState, WaveResolution, WaveView,
} from './types'
import { hashStr, makeRng } from './rng'
import { FNV_INIT, fnvFloat, fnvInt } from './hash'
import { needCount } from './util'
import {
  Director, type DirectorChunk, type DirectorWorld, type ActiveDemand,
} from './director'
import { updateChunkHeat, nextPhantomGap, HEAT_IDLE } from './heat'
import {
  HEAT_WARN_LEVEL, collapseDeath, heatWarnLegibility, oomDeath, snapshotViability,
  type EvictableMark, type WaveViability,
} from './attribution'

interface ChunkInt {
  readonly id: number
  readonly glyph: string
  readonly theme: string
  readonly seed: number
  readonly spawnTick: number
  readonly distractor: boolean
  readonly tokensTotal: number
  readonly heatRng: Rng
  readonly twoPip: boolean
  tier: Tier
  pinned: boolean
  transfer: TransferState | null
  tokensShown: number
  heat: number
  pips: number
  phantomTick: number
  /** Ticks at which heat was ≥ HEAT_WARN_LEVEL — death attribution only
   *  (gate #5 heat-warning legibility, see attribution.ts); not hashed
   *  (fully derived from the hashed heat stream). */
  readonly warnLog: number[]
}

interface WaveInt {
  readonly id: number
  readonly archetype: Archetype
  readonly glyphs: readonly string[]
  readonly telegraphTick: number
  readonly landTick: number
  readonly sufficientExpandedFrac: number
  resolved: boolean
  lastHelpfulArrival: number | null
  viability: WaveViability | null
}

/**
 * Pure credit math (§4.4): per-glyph weights expanded=1 / creditSummary /
 * creditChip / 0(absent); wave credit = mean, overridden to 1 when the
 * expanded fraction reaches sufficientExpandedFrac (boss sufficiency; ≡1
 * for standard waves, where it is a no-op on top of the mean).
 */
export function waveCredit(
  perGlyphBest: readonly (Tier | -1)[],
  sufficientExpandedFrac: number,
  cfg: Pick<SimConfig, 'creditSummary' | 'creditChip'>,
): number {
  if (perGlyphBest.length === 0) return 1
  let sum = 0
  let expanded = 0
  for (const t of perGlyphBest) {
    if (t === 2) {
      sum += 1
      expanded++
    } else if (t === 1) sum += cfg.creditSummary
    else if (t === 0) sum += cfg.creditChip
  }
  const frac = expanded / perGlyphBest.length
  if (frac >= sufficientExpandedFrac - 1e-9) return 1
  return sum / perGlyphBest.length
}

// Shared frozen no-op events (returned after done). The arrays are frozen
// too — this object is reused, so a caller mutating one would otherwise
// corrupt every later consumer.
const EMPTY_EVENTS: TickEvents = Object.freeze({
  accepted: Object.freeze([]),
  rejected: Object.freeze([]),
  arrivals: Object.freeze([]),
  resolved: Object.freeze([]),
  spawned: Object.freeze([]),
  telegraphed: Object.freeze([]),
  death: null,
})

class SimImpl implements Sim {
  readonly config: SimConfig
  private readonly seed: number
  private readonly director: Director
  private readonly heatRoot: Rng

  private t = 0
  private readonly chunks: ChunkInt[] = []
  private readonly waves: WaveInt[] = []
  private readonly resolutions: WaveResolution[] = []
  private coherence: number
  private score = 0
  private streak = 0
  private death: DeathInfo | null = null
  private doneFlag = false

  private streamingId: number | null = null
  private nextSpawnTick = 1

  private residencySum = 0
  private residencyTicks = 0
  private acceptedCount = 0
  private rejectedCount = 0
  private readonly acceptedTickLog: number[] = []
  private lastEvictable: EvictableMark | null = null
  private waveSeq = 0

  constructor(config: SimConfig, seed: number) {
    this.config = Object.freeze({ ...config })
    this.seed = seed
    const root = makeRng(seed)
    this.director = new Director(this.config, root, seed)
    this.heatRoot = root.fork('heat')
    this.coherence = this.config.coherenceMax
  }

  get done(): boolean {
    return this.doneFlag
  }

  get tickNow(): number {
    return this.t
  }

  /** Director adjustment log (feasibility pushes/shrinks/rerolls) — debug aid. */
  get directorLog(): readonly string[] {
    return this.director.log
  }

  // ── line accounting ──────────────────────────────────────────────────

  private expandedCost(c: ChunkInt): number {
    return Math.max(1, Math.ceil(c.tokensShown / this.config.tokensPerLine))
  }

  private costAt(c: ChunkInt, tier: Tier): number {
    return tier === 0 ? 0 : tier === 1 ? 1 : this.expandedCost(c)
  }

  private linesNow(c: ChunkInt): number {
    const base = this.costAt(c, c.tier)
    return c.transfer ? Math.max(base, this.costAt(c, c.transfer.toTier)) : base
  }

  private totalLines(): number {
    let s = 0
    for (const c of this.chunks) s += this.linesNow(c)
    return s
  }

  private isProtected(c: ChunkInt): boolean {
    return c.id >= this.chunks.length - this.config.protectedChunks
  }

  private busInFlight(): number {
    let n = 0
    for (const c of this.chunks) if (c.transfer) n++
    return n
  }

  private glyphBestTier(glyph: string): Tier | -1 {
    let best: Tier | -1 = -1
    for (const c of this.chunks) if (c.glyph === glyph && c.tier > best) best = c.tier
    return best
  }

  // ── tick ─────────────────────────────────────────────────────────────

  tick(actions: readonly Action[]): TickEvents {
    if (this.doneFlag) return EMPTY_EVENTS
    const cfg = this.config
    const now = ++this.t

    const accepted: Action[] = []
    const rejected: { action: Action; reason: RejectReason }[] = []
    const arrivals: { chunkId: number; tier: Tier }[] = []
    const resolvedEv: WaveResolution[] = []
    const spawned: number[] = []
    const telegraphed: number[] = []
    const mk = (): TickEvents => ({
      accepted, rejected, arrivals, resolved: resolvedEv,
      spawned, telegraphed, death: this.death,
    })

    // 0. actions — only accepted ones consume the budget.
    for (const a of actions) {
      if (accepted.length >= cfg.actionBudget) {
        rejected.push({ action: a, reason: 'action-budget' })
        this.rejectedCount++
        continue
      }
      const reason = this.applyAction(a, now)
      if (reason === null) {
        accepted.push(a)
        this.acceptedCount++
        this.acceptedTickLog.push(now)
      } else {
        rejected.push({ action: a, reason })
        this.rejectedCount++
      }
    }

    // 1. transfers → arrivals (and helpful-arrival tracking for gate #4).
    for (const c of this.chunks) {
      if (c.transfer && c.transfer.arriveTick === now) {
        const newTier = c.transfer.toTier
        const prevServing = this.glyphBestTier(c.glyph)
        c.tier = newTier
        c.transfer = null
        arrivals.push({ chunkId: c.id, tier: newTier })
        if (newTier > prevServing) {
          for (const w of this.waves) {
            if (!w.resolved && w.telegraphTick <= now && now <= w.landTick && w.glyphs.includes(c.glyph))
              w.lastHelpfulArrival = now
          }
        }
      }
    }

    // 2. stream (the newest chunk is the only streamer; spawn after gaps).
    if (this.streamingId !== null) {
      const c = this.chunks[this.streamingId]!
      c.tokensShown++
      if (c.tokensShown >= c.tokensTotal) {
        c.tokensShown = c.tokensTotal
        this.streamingId = null
        this.nextSpawnTick = now + this.director.spawnGap()
      }
    } else if (now >= this.nextSpawnTick) {
      const id = this.chunks.length
      const plan = this.director.planChunk(now, id)
      const c: ChunkInt = {
        id,
        glyph: plan.glyph,
        theme: plan.theme,
        seed: plan.seed,
        spawnTick: now,
        distractor: plan.distractor,
        tokensTotal: Math.max(1, plan.targetTokens),
        heatRng: this.heatRoot.fork(`c${id}`),
        twoPip: false,
        tier: 2,
        pinned: false,
        transfer: null,
        tokensShown: 1,
        heat: HEAT_IDLE,
        pips: 1,
        phantomTick: 0,
        warnLog: [],
      }
      if (plan.distractor) {
        c.phantomTick = now + nextPhantomGap(c.heatRng, cfg)
        ;(c as { twoPip: boolean }).twoPip = c.heatRng.next() < cfg.distractorTwoPipChance
      }
      this.chunks.push(c)
      spawned.push(id)
      if (c.tokensShown >= c.tokensTotal) {
        this.nextSpawnTick = now + this.director.spawnGap()
      } else {
        this.streamingId = id
      }
    }

    // 3. admission check (§4.1): the next streamed line must fit.
    const lines = this.totalLines()
    if (lines > cfg.viewportLines) {
      const current = this.findEvictable(now)
      this.death = oomDeath(now, cfg, current ?? this.lastEvictable)
      this.doneFlag = true
      return mk()
    }

    // 4. waves: commit → telegraph → resolve.
    const world = this.directorWorld(now)
    for (const cw of this.director.maybeCommit(world)) {
      this.waves.push({
        id: this.waveSeq++,
        archetype: cw.archetype,
        glyphs: cw.glyphs,
        telegraphTick: cw.telegraphTick,
        landTick: cw.landTick,
        sufficientExpandedFrac: cw.sufficientExpandedFrac,
        resolved: false,
        lastHelpfulArrival: null,
        viability: null,
      })
    }
    for (const w of this.waves) {
      if (!w.resolved && w.telegraphTick === now) {
        telegraphed.push(w.id)
        w.viability = snapshotViability(
          cfg, now, w,
          this.chunks.map((c) => ({ id: c.id, glyph: c.glyph, tier: c.tier, transfer: c.transfer })),
          this.busArrivals(),
        )
      }
    }
    for (const w of this.waves) {
      if (this.doneFlag) break
      if (!w.resolved && w.landTick === now) {
        const res = this.resolveWave(w)
        resolvedEv.push(res)
        this.resolutions.push(res)
        if (this.coherence <= 1e-9) {
          const heatWarn = heatWarnLegibility(
            this.config, w.landTick, w.glyphs,
            this.chunks.map((c) => ({ glyph: c.glyph, tier: c.tier, warnLog: c.warnLog })),
          )
          this.death = collapseDeath(now, w, w.viability, heatWarn)
          this.doneFlag = true
        }
      }
    }
    if (this.doneFlag) return mk()

    // 5. heat / pips.
    const demand = this.nextDemandByGlyph(now)
    for (const c of this.chunks) {
      updateChunkHeat(c, now, c.distractor ? Infinity : demand.get(c.glyph) ?? Infinity, cfg)
      if (c.heat >= HEAT_WARN_LEVEL) c.warnLog.push(now) // gate #5 attribution
    }

    // 6. zen accrual (§4.4): reward low residency inside zen stretches.
    if (this.director.inZen(now) && lines / cfg.viewportLines < cfg.zenResidency) {
      this.score += cfg.zenPointsPerTick
    }

    // 7. meters / bookkeeping.
    this.residencySum += lines / cfg.viewportLines
    this.residencyTicks++
    const ev = this.findEvictable(now)
    if (ev) this.lastEvictable = ev
    if (now >= cfg.roundTicks) this.doneFlag = true
    return mk()
  }

  // ── action validation ────────────────────────────────────────────────

  private applyAction(a: Action, now: number): RejectReason | null {
    const cfg = this.config
    const c =
      Number.isInteger(a.chunkId) && a.chunkId >= 0 && a.chunkId < this.chunks.length
        ? this.chunks[a.chunkId]!
        : null
    if (!c) return 'no-such-chunk'
    const prot = this.isProtected(c)
    switch (a.kind) {
      case 'up': {
        if (prot) return 'protected'
        if (c.transfer) return 'transferring'
        if (c.tier === 2) return 'at-top'
        if (this.busInFlight() >= cfg.B) return 'bus-full'
        const to = (c.tier + 1) as Tier
        const delta = this.costAt(c, to) - this.costAt(c, c.tier)
        if (this.totalLines() + delta > cfg.viewportLines) return 'no-headroom'
        const L = c.tier === 0 ? cfg.L_c2s : cfg.L_warm
        c.transfer = { toTier: to, startTick: now, arriveTick: now + L }
        return null
      }
      case 'down': {
        if (prot) return 'protected'
        if (c.pinned) return 'pinned'
        if (c.transfer) return 'transferring'
        if (c.tier === 0) return 'at-bottom'
        c.tier = (c.tier - 1) as Tier
        return null
      }
      case 'pin': {
        if (prot) return 'protected'
        c.pinned = !c.pinned
        return null
      }
    }
  }

  // ── wave resolution ──────────────────────────────────────────────────

  private resolveWave(w: WaveInt): WaveResolution {
    const cfg = this.config
    const best = w.glyphs.map((g) => this.glyphBestTier(g))
    const credit = waveCredit(best, w.sufficientExpandedFrac, cfg)
    const cleared = credit >= cfg.clearedAt - 1e-9
    const mul = w.archetype === 'boss' ? cfg.bossMissMul : 1
    const before = this.coherence
    let coh = before - cfg.missCost * (1 - credit) * mul
    if (cleared) coh += cfg.regenPerClear
    coh = Math.max(0, Math.min(cfg.coherenceMax, coh))
    this.coherence = coh
    const streakMul = Math.min(cfg.streakCap, 1 + cfg.streakStep * this.streak)
    this.score += cfg.wavePoints * credit * streakMul
    this.streak = cleared ? this.streak + 1 : 0
    w.resolved = true
    return {
      waveId: w.id,
      archetype: w.archetype,
      credit,
      cleared,
      coherenceDelta: coh - before,
      lastHelpfulArrival: w.lastHelpfulArrival,
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private busArrivals(): number[] {
    const out: number[] = []
    for (const c of this.chunks) if (c.transfer) out.push(c.transfer.arriveTick)
    return out
  }

  /** glyph → earliest future landTick among unresolved committed waves. */
  private nextDemandByGlyph(now: number): Map<string, number> {
    const m = new Map<string, number>()
    for (const w of this.waves) {
      if (w.resolved || w.landTick <= now) continue
      for (const g of w.glyphs) {
        const prev = m.get(g)
        if (prev === undefined || w.landTick < prev) m.set(g, w.landTick)
      }
    }
    return m
  }

  /** Most useful evictable chunk right now (most lines, oldest id wins). */
  private findEvictable(now: number): EvictableMark | null {
    let pick: ChunkInt | null = null
    let pickLines = -1
    for (const c of this.chunks) {
      if (c.tier === 0 || c.pinned || c.transfer || this.isProtected(c)) continue
      const l = this.linesNow(c)
      if (l > pickLines || (l === pickLines && pick !== null && c.id < pick.id)) {
        pick = c
        pickLines = l
      }
    }
    return pick
      ? { tick: now, chunkId: pick.id, glyph: pick.glyph, tier: pick.tier, lines: pickLines }
      : null
  }

  private directorWorld(now: number): DirectorWorld {
    const chunks: DirectorChunk[] = this.chunks.map((c) => ({
      id: c.id,
      glyph: c.glyph,
      tier: c.tier,
      transferTo: c.transfer ? c.transfer.toTier : null,
      transferArrive: c.transfer ? c.transfer.arriveTick : -1,
      spawnTick: c.spawnTick,
      pinned: c.pinned,
      protected: this.isProtected(c),
      expandedCost: this.expandedCost(c),
      linesNow: this.linesNow(c),
    }))
    const activeWaves: ActiveDemand[] = []
    for (const w of this.waves) {
      if (w.resolved || w.landTick <= now) continue
      activeWaves.push({
        landTick: w.landTick,
        glyphs: w.glyphs,
        needCount: needCount(w.sufficientExpandedFrac, w.glyphs.length),
      })
    }
    return { now, chunks, busArrivals: this.busArrivals(), activeWaves }
  }

  // ── views ────────────────────────────────────────────────────────────

  private chunkView(c: ChunkInt, now: number): ChunkView {
    const linesByTier: [number, number, number] = [0, 1, this.expandedCost(c)]
    return {
      id: c.id,
      glyph: c.glyph,
      tier: c.tier,
      heat: c.heat,
      pips: c.pips,
      pinned: c.pinned,
      protected: this.isProtected(c),
      transfer: c.transfer,
      linesByTier,
      linesNow: this.linesNow(c),
      ageTicks: now - c.spawnTick,
      tokensShown: c.tokensShown,
      tokensTotal: c.tokensTotal,
    }
  }

  private waveView(w: WaveInt): WaveView {
    return {
      id: w.id,
      archetype: w.archetype,
      glyphs: w.glyphs,
      telegraphTick: w.telegraphTick,
      landTick: w.landTick,
      sufficientExpandedFrac: w.sufficientExpandedFrac,
    }
  }

  private meters(): Meters {
    return {
      viewportUsed: this.totalLines(),
      viewportBudget: this.config.viewportLines,
      coherence: this.coherence,
      score: this.score,
      streak: this.streak,
      busInFlight: this.busInFlight(),
      busCap: this.config.B,
      residencyMean: this.residencyTicks > 0 ? this.residencySum / this.residencyTicks : 0,
    }
  }

  view(): SimView {
    const now = this.t
    return {
      tick: now,
      chunks: this.chunks.map((c) => this.chunkView(c, now)),
      waves: this.waves.filter((w) => !w.resolved && w.telegraphTick <= now).map((w) => this.waveView(w)),
      meters: this.meters(),
      zenActive: this.director.inZen(now),
      cliffActive: now > 2 * this.config.calibrationLength,
      done: this.doneFlag,
    }
  }

  oracleView(): OracleView {
    const base = this.view()
    const demand = this.nextDemandByGlyph(this.t)
    const nextDemandByChunk = new Map<number, number>()
    const distractorIds = new Set<number>()
    for (const c of this.chunks) {
      nextDemandByChunk.set(c.id, c.distractor ? Infinity : demand.get(c.glyph) ?? Infinity)
      if (c.distractor) distractorIds.add(c.id)
    }
    return {
      ...base,
      allWaves: this.waves.filter((w) => !w.resolved).map((w) => this.waveView(w)),
      nextDemandByChunk,
      distractorIds,
    }
  }

  // ── hash / result / specs ────────────────────────────────────────────

  stateHash(): number {
    let h = FNV_INIT
    h = fnvInt(h, this.t)
    h = fnvInt(h, this.doneFlag ? 1 : 0)
    h = fnvInt(h, this.streamingId === null ? 0xffffffff : this.streamingId)
    h = fnvInt(h, this.nextSpawnTick)
    for (const c of this.chunks) {
      h = fnvInt(h, c.id)
      h = fnvInt(h, hashStr(c.glyph))
      h = fnvInt(h, c.distractor ? 1 : 0)
      h = fnvInt(h, c.tier)
      h = fnvInt(h, c.pinned ? 1 : 0)
      if (c.transfer) {
        h = fnvInt(h, 1)
        h = fnvInt(h, c.transfer.toTier)
        h = fnvInt(h, c.transfer.startTick)
        h = fnvInt(h, c.transfer.arriveTick)
      } else {
        h = fnvInt(h, 0)
      }
      h = fnvInt(h, c.tokensShown)
      h = fnvInt(h, c.tokensTotal)
      h = fnvFloat(h, c.heat)
      h = fnvInt(h, c.pips)
      h = fnvInt(h, c.phantomTick)
    }
    h = fnvFloat(h, this.coherence)
    h = fnvFloat(h, this.score)
    h = fnvFloat(h, this.residencySum)
    h = fnvInt(h, this.residencyTicks)
    h = fnvInt(h, this.streak)
    h = fnvInt(h, this.busInFlight())
    h = fnvInt(h, this.resolutions.length)
    for (const w of this.waves) {
      if (w.resolved) continue
      h = fnvInt(h, w.id)
      h = fnvInt(h, w.archetype === 'boss' ? 1 : 0)
      h = fnvInt(h, w.telegraphTick)
      h = fnvInt(h, w.landTick)
      h = fnvInt(h, hashStr(w.glyphs.join('')))
      h = fnvFloat(h, w.sufficientExpandedFrac)
    }
    return h
  }

  result(): RoundResult {
    const cfg = this.config
    const ticksSurvived = this.death ? this.death.tick : this.t
    const survived = this.death === null && this.t >= cfg.roundTicks
    const meanCredit =
      this.resolutions.length > 0
        ? this.resolutions.reduce((s, r) => s + r.credit, 0) / this.resolutions.length
        : 1
    const residencyMean = this.residencyTicks > 0 ? this.residencySum / this.residencyTicks : 0
    const survivalFrac = Math.min(1, ticksSurvived / cfg.roundTicks)

    // Accepted actions per second over the middle 80% of the played span.
    const lo = Math.floor(ticksSurvived * 0.1)
    const hi = Math.ceil(ticksSurvived * 0.9)
    let mid = 0
    for (const t of this.acceptedTickLog) if (t > lo && t <= hi) mid++
    const span = hi - lo
    const actionsPerSec = span > 0 ? mid / (span / cfg.ticksPerSec) : 0

    return {
      seed: this.seed,
      ticksSurvived,
      roundTicks: cfg.roundTicks,
      survived,
      death: this.death,
      waves: [...this.resolutions],
      meanCredit,
      residencyMean,
      score: this.score,
      pareto: survivalFrac * meanCredit * (1 - residencyMean),
      actionsAccepted: this.acceptedCount,
      actionsRejected: this.rejectedCount,
      actionsPerSec,
    }
  }

  chunkSpec(chunkId: number): ChunkSpec {
    const c = this.chunks[chunkId]
    if (!c) throw new Error(`chunkSpec: chunk ${chunkId} not spawned yet`)
    return {
      chunkId: c.id,
      glyph: c.glyph,
      theme: c.theme,
      targetTokens: c.tokensTotal,
      seed: c.seed,
    }
  }
}

/** Build a sim. Throws (listing every violation) if the config is invalid. */
export function createSim(config: SimConfig, seed: number): Sim {
  const errs = validateConfig(config)
  if (errs.length > 0) throw new Error(`invalid SimConfig: ${errs.join('; ')}`)
  return new SimImpl(config, seed)
}
