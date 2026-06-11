/**
 * Adversarial probes with FABRICATED views — single-tick decision checks the
 * full-round runs can't isolate:
 *  - OracleBot: degraded-only jobs must still release (banked partial credit);
 *    under bus contention the tightest-slack job starts first, not the
 *    earliest-landing one; maxResidency cap evicts instead of expanding.
 *  - ReactiveBot: bus-full means retry-not-stall; a headroom-blocked react
 *    evicts a NON-telegraphed chunk; hedging respects the cap, prefers
 *    corroborated (3-pip) glyphs over hotter 1-pip distractors, and the
 *    eviction threshold keeps pressure below the hedge cap (no dead zone).
 *  - All roster bots: only legal actions against hostile views (everything
 *    protected / pinned / transferring), even at zero headroom.
 *  - Runner: trackWaves must not leak OracleView fields to non-oracle bots.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULTS,
  type Action,
  type BotPolicy,
  type ChunkView,
  type OracleView,
  type SimView,
  type Tier,
  type TransferState,
  type WaveView,
} from '../../src/sim'
import { OracleBot, ReactiveBot, makeRoster, runRoundDetailed } from '../../src/bots'

// ── fixture builders ─────────────────────────────────────────────────────

interface ChunkLite {
  glyph: string
  tier?: Tier
  heat?: number
  pips?: number
  pinned?: boolean
  protected?: boolean
  transfer?: TransferState | null
  expandedLines?: number
}

function makeChunks(specs: readonly ChunkLite[]): ChunkView[] {
  return specs.map((s, id) => {
    const exp = s.expandedLines ?? 5
    const tier = s.tier ?? 0
    const byTier: readonly [number, number, number] = [0, 1, exp]
    const transfer = s.transfer ?? null
    const base = byTier[tier]
    const linesNow = transfer ? Math.max(base, byTier[transfer.toTier]) : base
    return {
      id,
      glyph: s.glyph,
      tier,
      heat: s.heat ?? 0.1,
      pips: s.pips ?? 1,
      pinned: s.pinned ?? false,
      protected: s.protected ?? false,
      transfer,
      linesByTier: byTier,
      linesNow,
      ageTicks: 500,
      tokensShown: exp * DEFAULTS.tokensPerLine,
      tokensTotal: exp * DEFAULTS.tokensPerLine,
    }
  })
}

function mkWave(
  id: number,
  glyphs: readonly string[],
  telegraphTick: number,
  landTick: number,
  suff = 1,
  archetype: 'standard' | 'boss' = 'standard',
): WaveView {
  return { id, archetype, glyphs, telegraphTick, landTick, sufficientExpandedFrac: suff }
}

function makeView(tick: number, chunks: readonly ChunkView[], allWaves: readonly WaveView[] = []): SimView {
  const used = chunks.reduce((s, c) => s + c.linesNow, 0)
  const busInFlight = chunks.filter((c) => c.transfer !== null).length
  return {
    tick,
    chunks,
    waves: allWaves.filter((w) => w.telegraphTick <= tick),
    meters: {
      viewportUsed: used,
      viewportBudget: DEFAULTS.viewportLines,
      coherence: 100,
      score: 0,
      streak: 0,
      busInFlight,
      busCap: DEFAULTS.B,
      residencyMean: used / DEFAULTS.viewportLines,
    },
    zenActive: false,
    cliffActive: false,
    done: false,
  }
}

function makeOracleView(
  view: SimView,
  allWaves: readonly WaveView[],
  distractors: readonly number[] = [],
): OracleView {
  const distractorIds = new Set(distractors)
  const nextDemandByChunk = new Map<number, number>()
  for (const c of view.chunks) {
    let d = Infinity
    if (!distractorIds.has(c.id)) {
      for (const w of allWaves) {
        if (w.landTick > view.tick && w.glyphs.includes(c.glyph) && w.landTick < d) d = w.landTick
      }
    }
    nextDemandByChunk.set(c.id, d)
  }
  return { ...view, allWaves, nextDemandByChunk, distractorIds }
}

function freshOracle(opts?: ConstructorParameters<typeof OracleBot>[0]): OracleBot {
  const bot = new OracleBot(opts)
  bot.configure(DEFAULTS)
  bot.reset(1)
  return bot
}

function freshReactive(): ReactiveBot {
  const bot = new ReactiveBot()
  bot.configure(DEFAULTS)
  bot.reset(1)
  return bot
}

// ── OracleBot probes ─────────────────────────────────────────────────────

describe('OracleBot adversarial probes', () => {
  test('degraded-only job still releases: banks summary credit when the full chain cannot land', () => {
    // land 145, cold chunk at t100: full chain arrives t156 (too late), but
    // chip→summary arrives t141 ≤ 145 — worth 0.45 credit instead of 0.15.
    const chunks = makeChunks([
      { glyph: 'A', tier: 0, heat: 0.9, pips: 3 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ])
    const wave = mkWave(0, ['A'], 109, 145)
    const view = makeView(100, chunks, [wave])
    const actions = freshOracle().act(view, makeOracleView(view, [wave]))
    expect(actions).toEqual([{ kind: 'up', chunkId: 0 }])
  })

  test('bus contention: releases the tightest-slack chain first, not the earliest-landing warm job', () => {
    // Warm job for w0 (land 130): finish t115, slack 15 — comfortably JIT-deferrable.
    // Cold chain for w1 (land 158): finish t156, slack 2 — must start NOW.
    const chunks = makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3 },
      { glyph: 'B', tier: 0, heat: 0.6, pips: 3 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ])
    const waves = [mkWave(0, ['A'], 94, 130), mkWave(1, ['B'], 122, 158)]
    const view = makeView(100, chunks, waves)
    const actions = freshOracle().act(view, makeOracleView(view, waves))
    expect(actions).toEqual([{ kind: 'up', chunkId: 1 }])
  })

  test('maxResidency cap: evicts a never-demanded chunk instead of expanding over the cap', () => {
    // Budget 34 @ cap 0.25 → 8.5 lines. Used 8; the due fetch (+1) would breach
    // the cap, so the bot must clear room (the §4.4 calibration sweep mode).
    const chunks = makeChunks([
      { glyph: 'A', tier: 0, heat: 0.9, pips: 3 },
      { glyph: 'C', tier: 1, heat: 0.1, pips: 1 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 7 },
    ])
    const wave = mkWave(0, ['A'], 124, 160)
    const view = makeView(100, chunks, [wave])
    const bot = freshOracle({ maxResidency: 0.25 })
    expect(bot.name).toBe('oracle@0.25')
    const actions = bot.act(view, makeOracleView(view, [wave]))
    expect(actions).toEqual([{ kind: 'down', chunkId: 1 }])
  })
})

// ── ReactiveBot probes ───────────────────────────────────────────────────

describe('ReactiveBot adversarial probes', () => {
  test('bus-full: no action this tick, retries the telegraphed expand once a slot frees', () => {
    const wave = mkWave(0, ['A'], 94, 130)
    const mkTransfer = (arriveTick: number): TransferState => ({ toTier: 1, startTick: 95, arriveTick })
    const full = makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3 },
      { glyph: 'D', tier: 0, transfer: mkTransfer(135) },
      { glyph: 'E', tier: 0, transfer: mkTransfer(140) },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ])
    const bot = freshReactive()
    expect(bot.act(makeView(100, full, [wave]), null)).toEqual([])

    const oneFree = makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3 },
      { glyph: 'D', tier: 0, transfer: mkTransfer(135) },
      { glyph: 'E', tier: 0 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ])
    expect(bot.act(makeView(100, oneFree, [wave]), null)).toEqual([{ kind: 'up', chunkId: 0 }])
  })

  test('headroom-blocked react: evicts a non-telegraphed chunk, never the demanded glyph', () => {
    const wave = mkWave(0, ['A'], 94, 130)
    const chunks = makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3, expandedLines: 5 }, // wants +4 lines, blocked
      { glyph: 'C', tier: 2, heat: 0.05, pips: 1, expandedLines: 6 }, // the right victim
      { glyph: 'A', tier: 0, heat: 0.9, pips: 3 }, // demanded glyph: untouchable
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 24 },
    ])
    const view = makeView(100, chunks, [wave]) // used 31/34: headroom 3, upFits fails
    const actions = freshReactive().act(view, null)
    expect(actions).toEqual([{ kind: 'down', chunkId: 1 }])
  })

  test('hedge: prefers the 3-pip glyph over a hotter 1-pip (likely distractor)', () => {
    const chunks = makeChunks([
      { glyph: 'A', tier: 0, heat: 0.5, pips: 3 },
      { glyph: 'B', tier: 0, heat: 0.9, pips: 1 },
      { glyph: 'D', tier: 1, heat: 0.05, pips: 1 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 10 },
    ])
    const actions = freshReactive().act(makeView(100, chunks), null)
    expect(actions).toEqual([{ kind: 'up', chunkId: 0 }])
  })

  test('no dead zone: above the hedge cap the bot sheds lines instead of idling', () => {
    // Pressure 22/34 ≈ 0.65 — hedging is capped out; with evictAt < hedgeCap
    // the bot must evict the cold summary so hedging can resume. (The old
    // evictAt 0.75 default idled here: no hedge, no evict, 16/100 collapses.)
    const chunks = makeChunks([
      { glyph: 'A', tier: 0, heat: 0.5, pips: 3 },
      { glyph: 'B', tier: 0, heat: 0.9, pips: 1 },
      { glyph: 'D', tier: 1, heat: 0.05, pips: 1 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 21 },
    ])
    const actions = freshReactive().act(makeView(100, chunks), null)
    expect(actions).toEqual([{ kind: 'down', chunkId: 2 }])
  })
})

// ── legality under hostile views ─────────────────────────────────────────

describe('roster legality on hostile views', () => {
  const legal = (a: Action, chunks: readonly ChunkView[]): boolean => {
    const c = chunks[a.chunkId]
    if (!c) return false
    if (a.kind === 'up') return c.tier < 2 && !c.protected && c.transfer === null
    if (a.kind === 'down') return c.tier > 0 && !c.protected && !c.pinned && c.transfer === null
    return !c.protected // pin
  }

  test('everything protected/pinned/transferring (even at zero headroom) ⇒ only legal actions', () => {
    const wave = mkWave(0, ['C'], 94, 140)
    const hostile = makeChunks([
      { glyph: 'A', tier: 2, protected: true, expandedLines: 12, heat: 0.9, pips: 3 },
      { glyph: 'B', tier: 1, pinned: true, heat: 0.8, pips: 3 },
      { glyph: 'C', tier: 0, transfer: { toTier: 1, startTick: 90, arriveTick: 120 }, heat: 0.95, pips: 3 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 21 },
    ])
    // used = 12 + 1 + 1 + 21 = 35 > budget − panic margin: panic paths engage.
    const view = makeView(100, hostile, [wave])
    const oview = makeOracleView(view, [wave])
    for (const bot of makeRoster()) {
      bot.configure?.(DEFAULTS)
      bot.reset(7)
      const actions = bot.act(view, bot.wantsOracle ? oview : null)
      expect(actions.length).toBeLessThanOrEqual(DEFAULTS.actionBudget)
      for (const a of actions) {
        if (!legal(a, hostile)) {
          throw new Error(`${bot.name} emitted illegal action ${JSON.stringify(a)}`)
        }
      }
    }
  })
})

// ── runner information hygiene ───────────────────────────────────────────

describe('runner trackWaves hygiene', () => {
  class SpyBot implements BotPolicy {
    readonly name = 'spy'
    sawOracleFields = false
    act(view: SimView): Action[] {
      const v = view as object
      if ('allWaves' in v || 'nextDemandByChunk' in v || 'distractorIds' in v) this.sawOracleFields = true
      // Play recency-style so glyphs actually go cold and waves commit
      // (a do-nothing bot keeps everything expanded ⇒ zero waves, no windows).
      let oldest: number | null = null
      for (const c of view.chunks) {
        if (c.tier > 0 && !c.protected && !c.pinned && !c.transfer && (oldest === null || c.id < oldest))
          oldest = c.id
      }
      return oldest !== null ? [{ kind: 'down', chunkId: oldest }] : []
    }
    reset(_seed: number): void {}
  }

  test('trackWaves never hands OracleView fields to a non-oracle bot', () => {
    const spy = new SpyBot()
    const det = runRoundDetailed(DEFAULTS, 3, spy, { trackWaves: true })
    expect(spy.sawOracleFields).toBe(false)
    expect(det.waveWindows).not.toBeNull()
    expect(det.waveWindows!.size).toBeGreaterThan(0)
  })
})
