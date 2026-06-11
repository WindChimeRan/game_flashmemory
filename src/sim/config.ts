/**
 * ALL gameplay numbers live here (ARCHITECTURE.md D7). Every value is a
 * FLOATING DEFAULT until the §7 gates pass over 100 seeded rounds.
 *
 * OWNED BY THE INTEGRATOR — module agents treat as read-only; tuning
 * sweeps propose changes via PLAYTEST.md.
 *
 * Structural relationships that must survive any tuning (§4.3 law):
 *   L_c2s + L_warm  >  telegraphStd      (cold can't react to a telegraph)
 *   L_warm          <  telegraphStd      (warm hedges can react — priced)
 *   ceil(bossG·sufficiency/B) · chainAvg ≳ telegraphBoss (bosses need staging)
 */

export interface SimConfig {
  // ── time ────────────────────────────────────────────────────────────
  /** Display rate; 1 tick = 1 token (D3). The headline difficulty knob. */
  ticksPerSec: number
  /** Round length in ticks (3 min at default rate). */
  roundTicks: number

  // ── viewport / spatial (working default — §4.1 unfrozen) ───────────
  /** Managed line budget (the context window). */
  viewportLines: number
  /** Prose tokens per rendered line (layout estimate for line costs). */
  tokensPerLine: number
  /** Newest N chunks are protected (expanded, untouchable). */
  protectedChunks: number

  // ── chunks / stream ─────────────────────────────────────────────────
  chunkTokensMin: number
  chunkTokensMax: number
  /** Gap between chunk spawns [min, max] ticks. */
  spawnGapMin: number
  spawnGapMax: number
  /** Entity alphabet size (distinct glyph letters in play). */
  glyphCount: number

  // ── commitment structure (§4.3) ─────────────────────────────────────
  /** chip → summary transfer, ticks. */
  L_c2s: number
  /** summary → expanded transfer, ticks. */
  L_warm: number
  /** Max transfers in flight. */
  B: number
  /** Player/bot actions accepted per tick. */
  actionBudget: number
  /**
   * Summary-tier decay (gate-2(b) mechanic, PLAYTEST.md 2026-06-10): a chunk
   * sitting at SUMMARY tier unused for more than `summaryTTL` ticks drops
   * back to chip at the START of a tick (before actions), emitting a
   * `decayed` event. "Used" resets the counter: arriving at summary
   * (transfer completion), its glyph being demanded by a LANDING wave, or
   * being the target of an accepted tier action (up/down — NOT pin: pin
   * guards against your own misclicks, not the cache's nature, and a free
   * 1-action pin refresh would re-enable blanket hedging, the exact
   * loophole this knob prices). Mid-transfer chunks never decay (in-flight
   * is committed, both directions). Paper-faithful: unused prefetches do
   * not persist past the next trigger window. `Infinity` disables decay and
   * reproduces frozen v1.1 behavior exactly.
   *
   * Design intent: anti-blanket pressure comes from summaryTTL < typical
   * wave gap (waveGapMin..Max), so maintaining a standing hedge wall costs
   * recurring actions + bus time instead of being a one-time purchase.
   */
  summaryTTL: number

  // ── waves (§4.4) ────────────────────────────────────────────────────
  telegraphStd: number
  telegraphBoss: number
  /** Wave cadence [min, max] ticks between landings (standard mix). */
  waveGapMin: number
  waveGapMax: number
  /** Standard wave G size range. */
  stdGlyphsMin: number
  stdGlyphsMax: number
  /** Required minimum age (ticks) of demanded glyphs' chunks. */
  stdMinAge: number
  /** Boss G size. */
  bossGlyphs: number
  /** Boss full credit at ≥ this fraction of G expanded (§3.3.2 ≈ 0.5). */
  bossSufficiency: number
  /** Bosses per round (scheduled past the midpoint). */
  bossCount: number
  /** Zen stretches per round and their length [min,max]. */
  zenCount: number
  zenLenMin: number
  zenLenMax: number

  // ── credit / coherence ──────────────────────────────────────────────
  creditSummary: number // expanded = 1, absent = 0
  creditChip: number
  /** Coherence damage = missCost · (1 − credit) (boss × bossMissMul). */
  missCost: number
  bossMissMul: number
  /** Coherence regen on a cleared wave (credit ≥ clearedAt). */
  regenPerClear: number
  clearedAt: number
  coherenceMax: number

  // ── heat & distractors (§4.4–4.5) ───────────────────────────────────
  /** Heat starts rising this many ticks before a chunk's demand. */
  heatHorizon: number
  /** Gaussian-ish noise σ on the heat channel, pre-cliff. */
  heatNoise: number
  /** Base distractor fraction of spawned chunks. */
  distractorFrac: number
  /** Leakage growth: extra distractors per spawned chunk of history. */
  distractorLeakPerChunk: number
  /** Hard cap on distractor share of live chunks. */
  distractorFracCap: number
  /** Chance a distractor shows 2 pips instead of 1. */
  distractorTwoPipChance: number
  /** Endless mode: cliff at 2 × this; heat noise ramps to heatNoiseCliff. */
  calibrationLength: number
  heatNoiseCliff: number

  // ── score (§10.5 split: additive in-run, Pareto end screen) ─────────
  wavePoints: number // points = wavePoints · credit · streakMul
  streakStep: number // streakMul = 1 + streakStep·streak (capped)
  streakCap: number
  /** Zen accrual per tick while residency < zenResidency during a stretch. */
  zenResidency: number
  zenPointsPerTick: number

  // ── death legibility (gate #5) ──────────────────────────────────────
  /** Attribution window, ticks (~10 s). */
  attributionWindow: number
}

export const DEFAULTS: SimConfig = {
  ticksPerSec: 10,
  roundTicks: 1800,

  // 2026-06-10 tuning (PLAYTEST.md): viewportLines 34→26 + telegraphStd
  // 36→28 — the minimal 2-knob diff from the 80-point sweep that maximizes
  // commitment separation (oracle.pareto/reactive.pareto ≈ 1.5) while
  // keeping recency ≤ 0.6×oracle survival, oracle aps and near-miss in band.
  viewportLines: 26,
  tokensPerLine: 11,
  protectedChunks: 2,

  chunkTokensMin: 44,
  chunkTokensMax: 77,
  spawnGapMin: 14,
  spawnGapMax: 30,
  glyphCount: 10,

  L_c2s: 40,
  L_warm: 14,
  B: 2,
  actionBudget: 1,
  // Infinity = mechanic dormant (exact frozen v1.1 behavior). The
  // 2026-06-10 sweep (PLAYTEST.md) found no finite value that fixes gate
  // 2(b): the strongest reactive variant (hedgeHeat 0.45) parks summaries
  // for ~1–2 ticks only, so decay cannot price it, while TTL ≤ 55 pushes
  // greedy-heat's survival into gate 1's saturation dead band and TTL
  // 70–90 buys a ~0.01 pareto-gap improvement at the cost of most of gate
  // 5's margin (0.98 → 0.91). Flip to a finite value (> telegraphStd,
  // > L_warm + 2; 90 was the best finite candidate) to activate decay.
  summaryTTL: Infinity,

  telegraphStd: 28,
  telegraphBoss: 120,
  waveGapMin: 70,
  waveGapMax: 130,
  stdGlyphsMin: 1,
  stdGlyphsMax: 2,
  stdMinAge: 160,
  bossGlyphs: 5,
  bossSufficiency: 0.6,
  bossCount: 1,
  zenCount: 1,
  zenLenMin: 130,
  zenLenMax: 210,

  creditSummary: 0.45,
  creditChip: 0.15,
  missCost: 22,
  bossMissMul: 1.4,
  regenPerClear: 4,
  clearedAt: 0.85,
  coherenceMax: 100,

  heatHorizon: 90,
  heatNoise: 0.08,
  distractorFrac: 0.12,
  distractorLeakPerChunk: 0.004,
  distractorFracCap: 0.3,
  distractorTwoPipChance: 0.25,
  calibrationLength: 1800,
  heatNoiseCliff: 0.45,

  wavePoints: 100,
  streakStep: 0.1,
  streakCap: 2.0,
  zenResidency: 0.25,
  zenPointsPerTick: 1.5,

  attributionWindow: 100,
}

export type PresetName = 'chill' | 'default' | 'inferno'

// Presets sit symmetrically around the tuned DEFAULTS on the same axes
// (rate, viewport, telegraph, cadence, distractors): chill relaxes the two
// tuned knobs (viewport 26→30, telegraph 28→34), inferno tightens them
// (26→24, 28→24). All three must satisfy validateConfig (L_warm 14 < tg,
// L_cold 54 > tg holds for tg ∈ {24, 28, 34}).
export function preset(name: PresetName): SimConfig {
  switch (name) {
    case 'chill':
      return {
        ...DEFAULTS,
        ticksPerSec: 7,
        viewportLines: 30,
        telegraphStd: 34,
        waveGapMin: 90,
        waveGapMax: 150,
        distractorFrac: 0.08,
      }
    case 'default':
      return { ...DEFAULTS }
    case 'inferno':
      return {
        ...DEFAULTS,
        ticksPerSec: 14,
        viewportLines: 24,
        telegraphStd: 24,
        waveGapMin: 55,
        waveGapMax: 100,
        bossCount: 2,
        distractorFrac: 0.16,
        stdGlyphsMax: 3,
      }
  }
}

/** Structural law checks (§4.3) — sim construction asserts these. */
export function validateConfig(c: SimConfig): string[] {
  const errs: string[] = []
  if (c.L_c2s + c.L_warm <= c.telegraphStd)
    errs.push(`L_cold (${c.L_c2s + c.L_warm}) must exceed telegraphStd (${c.telegraphStd})`)
  if (c.L_warm >= c.telegraphStd)
    errs.push(`L_warm (${c.L_warm}) must be below telegraphStd (${c.telegraphStd})`)
  // Decay laws: a reaction-hedge made at telegraph time must survive to the
  // landing (else the warm path the commitment structure prices is dead on
  // arrival), and a freshly-arrived summary must comfortably outlive one
  // warm continuation (arrival reset + 1-tick handoff + L_warm). The
  // anti-blanket pressure is meant to come from summaryTTL < typical wave
  // gap, NOT from breaking the telegraph-reaction loop itself.
  if (!(c.summaryTTL > c.telegraphStd))
    errs.push(`summaryTTL (${c.summaryTTL}) must exceed telegraphStd (${c.telegraphStd})`)
  if (!(c.summaryTTL > c.L_warm + 2))
    errs.push(`summaryTTL (${c.summaryTTL}) must exceed L_warm + 2 (${c.L_warm + 2})`)
  if (c.protectedChunks < 1) errs.push('protectedChunks ≥ 1')
  if (c.B < 1) errs.push('B ≥ 1')
  return errs
}
