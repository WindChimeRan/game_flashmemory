/**
 * Bot behavior under summary-tier decay (summaryTTL):
 *  - ReactiveBot maintains its hedge wall: a dying hedge (remaining life <
 *    rehedgeLead) triggers a sibling chip's replacement leg BEFORE the gap
 *    opens; at summaryTTL = Infinity the same view produces no action.
 *  - ReactiveBot Phase-B futility is decay-correct: a telegraphed summary
 *    that decays before the action would process is treated as the chip it
 *    is about to become (no wasted up inside a standard telegraph window).
 *  - OracleBot chain staging is decay-safe: a slack-rich warm job releases
 *    when its decay deadline nears IF a post-decay cold restart cannot make
 *    the landing; when the cold restart fits comfortably it deliberately
 *    lets the summary decay (cheaper residency). Dead code at TTL=Infinity.
 *  - Runner-level replay equality at finite TTL.
 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULTS,
  type ChunkView,
  type OracleView,
  type SimConfig,
  type SimView,
  type Tier,
  type TransferState,
  type WaveView,
} from '../../src/sim'
import { OracleBot, ReactiveBot, runRoundDetailed } from '../../src/bots'

const TTL40: SimConfig = { ...DEFAULTS, summaryTTL: 40 }

// ── fixture builders (mirrors adversarial.test.ts) ───────────────────────

interface ChunkLite {
  glyph: string
  tier?: Tier
  heat?: number
  pips?: number
  protected?: boolean
  transfer?: TransferState | null
  expandedLines?: number
  summaryAgeTicks?: number
}

function makeChunks(specs: readonly ChunkLite[]): ChunkView[] {
  return specs.map((s, id) => {
    const exp = s.expandedLines ?? 5
    const tier = s.tier ?? 0
    const byTier: readonly [number, number, number] = [0, 1, exp]
    const transfer = s.transfer ?? null
    const base = byTier[tier]
    return {
      id,
      glyph: s.glyph,
      tier,
      heat: s.heat ?? 0.1,
      pips: s.pips ?? 1,
      pinned: false,
      protected: s.protected ?? false,
      transfer,
      summaryAgeTicks: tier === 1 ? s.summaryAgeTicks ?? 0 : 0,
      linesByTier: byTier,
      linesNow: transfer ? Math.max(base, byTier[transfer.toTier]) : base,
      ageTicks: 500,
      tokensShown: exp * DEFAULTS.tokensPerLine,
      tokensTotal: exp * DEFAULTS.tokensPerLine,
    }
  })
}

function makeView(tick: number, chunks: readonly ChunkView[], allWaves: readonly WaveView[] = []): SimView {
  const used = chunks.reduce((s, c) => s + c.linesNow, 0)
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
      busInFlight: chunks.filter((c) => c.transfer !== null).length,
      busCap: DEFAULTS.B,
      residencyMean: used / DEFAULTS.viewportLines,
    },
    zenActive: false,
    cliffActive: false,
    done: false,
  }
}

function makeOracleView(view: SimView, allWaves: readonly WaveView[]): OracleView {
  const nextDemandByChunk = new Map<number, number>()
  for (const c of view.chunks) {
    let d = Infinity
    for (const w of allWaves) {
      if (w.landTick > view.tick && w.glyphs.includes(c.glyph) && w.landTick < d) d = w.landTick
    }
    nextDemandByChunk.set(c.id, d)
  }
  return { ...view, allWaves, nextDemandByChunk, distractorIds: new Set() }
}

const wave = (id: number, glyphs: readonly string[], telegraphTick: number, landTick: number): WaveView => ({
  id, archetype: 'standard', glyphs, telegraphTick, landTick, sufficientExpandedFrac: 1,
})

function reactive(cfg: SimConfig): ReactiveBot {
  const bot = new ReactiveBot()
  bot.configure(cfg)
  bot.reset(1)
  return bot
}

function oracle(cfg: SimConfig): OracleBot {
  const bot = new OracleBot()
  bot.configure(cfg)
  bot.reset(1)
  return bot
}

// ── ReactiveBot ──────────────────────────────────────────────────────────

describe('ReactiveBot wall maintenance under decay', () => {
  // Glyph A is hot and hedged, but the hedge is 4 ticks from decaying
  // (age 36, TTL 40) — within rehedgeLead (L_c2s + 2): the bot must start
  // the sibling chip's replacement leg now, before the wall gap opens.
  const chunks = makeChunks([
    { glyph: 'A', tier: 1, heat: 0.6, pips: 3, summaryAgeTicks: 36 },
    { glyph: 'A', tier: 0, heat: 0.6, pips: 3 },
    { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
  ])

  test('seamless re-hedge: dying hedge triggers the sibling chip replacement leg', () => {
    expect(reactive(TTL40).act(makeView(100, chunks), null)).toEqual([{ kind: 'up', chunkId: 1 }])
  })

  test('same view at summaryTTL = Infinity: the standing hedge suffices, no action', () => {
    expect(reactive(DEFAULTS).act(makeView(100, chunks), null)).toEqual([])
  })

  test('after the decay (chip again), the hot glyph is simply re-hedged', () => {
    const after = makeChunks([
      { glyph: 'A', tier: 0, heat: 0.6, pips: 3 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ])
    expect(reactive(TTL40).act(makeView(150, after), null)).toEqual([{ kind: 'up', chunkId: 0 }])
  })
})

describe('ReactiveBot Phase-B decay-correct futility', () => {
  const mk = (age: number): SimView => {
    const w = wave(0, ['A'], 100, 127) // standard window: land = telegraph + 27
    return makeView(100, makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3, summaryAgeTicks: age },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ]), [w])
  }

  test('summary that survives the action tick is expanded (age TTL − 1)', () => {
    expect(reactive(TTL40).act(mk(39), null)).toEqual([{ kind: 'up', chunkId: 0 }])
  })

  test('summary that decays before the action processes is futile inside a standard window (age TTL)', () => {
    // The up would land on the decayed chip: L_c2s (41 > 27) can no longer
    // help this wave — the strongest reactive play is to not waste the bus.
    expect(reactive(TTL40).act(mk(40), null)).toEqual([])
  })
})

// ── OracleBot ────────────────────────────────────────────────────────────

describe('OracleBot decay-safe staging', () => {
  const mk = (land: number, ttlCfg: SimConfig): { view: SimView; ov: OracleView } => {
    const w = wave(0, ['A'], land - DEFAULTS.telegraphStd, land)
    const view = makeView(100, makeChunks([
      { glyph: 'A', tier: 1, heat: 0.9, pips: 3, summaryAgeTicks: 36 },
      { glyph: 'Z', tier: 2, protected: true, expandedLines: 5 },
    ]), [w])
    return { view, ov: makeOracleView(view, [w]) }
  }

  test('slack-rich warm job releases at the decay deadline when a cold restart cannot make the landing', () => {
    // deadline t104; land 150: slack 35 ≫ JIT band, but decay+cold-restart
    // would finish ≈ t169 > 150 — must start the warm leg NOW.
    const { view, ov } = mk(150, TTL40)
    expect(oracle(TTL40).act(view, ov)).toEqual([{ kind: 'up', chunkId: 0 }])
  })

  test('lets the summary decay when the post-decay cold restart still fits with margin', () => {
    // land 250: restart ≈ t169 ≤ 250 — decaying is the cheaper play.
    const { view, ov } = mk(250, TTL40)
    expect(oracle(TTL40).act(view, ov)).toEqual([])
  })

  test('summaryTTL = Infinity: no deadline pressure, JIT waits as in v1.1', () => {
    const { view, ov } = mk(150, DEFAULTS)
    expect(oracle(DEFAULTS).act(view, ov)).toEqual([])
  })
})

describe('runner replay equality at finite TTL', () => {
  test('ReactiveBot on summaryTTL=55: identical finalHash and result across runs', () => {
    const cfg: SimConfig = { ...DEFAULTS, summaryTTL: 55 }
    const a = runRoundDetailed(cfg, 4011, new ReactiveBot())
    const b = runRoundDetailed(cfg, 4011, new ReactiveBot())
    expect(a.finalHash).toBe(b.finalHash)
    expect(a.result).toEqual(b.result)
  })

  test('OracleBot keeps its credit under decay (TTL=55 within 5% of Infinity over 6 seeds)', () => {
    const cfg: SimConfig = { ...DEFAULTS, summaryTTL: 55 }
    let credFin = 0
    let credInf = 0
    for (let seed = 4000; seed < 4006; seed++) {
      credFin += runRoundDetailed(cfg, seed, new OracleBot()).result.meanCredit
      credInf += runRoundDetailed(DEFAULTS, seed, new OracleBot()).result.meanCredit
    }
    expect(credFin).toBeGreaterThanOrEqual(0.95 * credInf)
  })
})
