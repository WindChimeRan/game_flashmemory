import { describe, expect, test } from 'bun:test'
import { layout, prepare } from '../../src/pretext'
import { ATTR_BOLD, ATTR_DIM, ATTR_REVERSE } from '../../src/term'
import {
  computeGeometry,
  corruptChar,
  isInline,
  paretoRows,
  proseWidth,
  renderScreen,
  sliceCells,
  type OverState,
  type ProseView,
  type ScreenState,
} from '../../src/game/screen'
import { UI, heatColor } from '../../src/game/theme'
import type { TweenSample } from '../../src/game/anim'
import { chunk, gridRegion, gridRows, screenState, simView, wave } from './helpers'

// ── fixture: the spec'd mid-game state ────────────────────────────────────
// 2 expanded + 1 summary + 3 chips + 1 in-flight transfer + 2 telegraphed
// waves (one boss). Prose is fixed text; goldens pin structure + sidebar.

function prose(text: string, width: number): ProseView {
  const p = prepare(text)
  const lay = layout(p, width)
  const byId = new Map(p.segments.map((s) => [s.id, s.text]))
  return { layout: lay, textOf: (id) => byId.get(id) ?? '' }
}

const W = proseWidth(100)
const A_TEXT =
  'Auric Vayle, the salvage-captain, crossed the indexed vaults with a brass astrolabe held high. ' +
  'Rumor moved through the dust-sealed stacks like a debt come due.'
const C_TEXT = 'Cinder Mal pressed a counterfeit relic-key to the seam of the night bazaar and listened.'

function midGameView() {
  return simView({
    tick: 112,
    chunks: [
      chunk({ id: 0, glyph: 'K', tier: 0, heat: 0.2, pips: 1 }),
      chunk({ id: 1, glyph: 'A', tier: 2, heat: 0.82, pips: 3, linesExpanded: 3 }),
      chunk({ id: 2, glyph: 'B', tier: 0, heat: 0.65, pips: 2 }),
      chunk({ id: 3, glyph: 'E', tier: 1, heat: 0.4, pips: 2, transfer: { toTier: 2, startTick: 100, arriveTick: 114 } }),
      chunk({ id: 4, glyph: 'F', tier: 0, heat: 0.1, pips: 1 }),
      chunk({ id: 5, glyph: 'C', tier: 2, heat: 0.45, pips: 1, protected: true, tokensShown: 17, tokensTotal: 55, linesExpanded: 2 }),
    ],
    waves: [
      wave({ id: 4, glyphs: ['A', 'B'], telegraphTick: 100, landTick: 136 }),
      wave({ id: 5, archetype: 'boss', glyphs: ['K', 'E', 'A', 'B', 'F'], telegraphTick: 80, landTick: 200, sufficientExpandedFrac: 0.6 }),
    ],
  })
}

function midGameState(extra: Partial<ScreenState> = {}): ScreenState {
  return screenState({
    view: midGameView(),
    prose: new Map([
      [1, prose(A_TEXT, W)],
      [5, prose(C_TEXT.split(' ').slice(0, 17).join(' ') + ' ', W)],
    ]),
    focusId: 1,
    ...extra,
  })
}

describe('golden: mid-game screen (100×30)', () => {
  const grid = renderScreen(midGameState())
  const rows = gridRows(grid)

  test('sidebar region is pixel-exact (gauge, meters, bus, waves, rail)', () => {
    expect(gridRegion(grid, 0, 65, 35, 29)).toEqual([
      '│ OOM default · seed 7',
      '│                              MEM',
      '│ COH ████████████░░░░  78      ▒▒',
      '│ PTS   1240  STRK ×3           ▒▒',
      '│                               ··',
      '│ BUS E↑E▰▰▰▱  ·······          ··',
      '│                               ··',
      '│ INCOMING                      ██',
      '│  AB     ▓▓▓▓▓▓▓░░░  3s        ██',
      '│ ▌KEABF  ▓▓▓▓▓▓▓░░░  9s BOSS   ██',
      '│                               ██',
      '│                               ██',
      '│                               ██',
      '│                               ██',
      '│                               62%',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│',
      '│ COLD 3',
      '│ K B F',
      '│',
      '│',
    ])
  })

  test('headers: badge letters, pips, names, transfer + stream tails', () => {
    expect(rows[0]).toStartWith('▶ A ●●● Auric Vayle      ████· 3L')
    expect(rows[5]).toStartWith('  E ••  Ezri Thorn       ██··· ⇡E 85%')
    expect(rows[7]).toStartWith('▎ C ·   Cinder Mal       ██··· +17/55')
  })

  test('prose region: structure, not words — expanded chunks have body rows', () => {
    // chunk 1 prose on rows 1–3, chunk 5 prose on rows 8–9 (fuzzy: non-empty)
    for (const r of [1, 2, 3, 8, 9]) {
      expect(rows[r]!.slice(2, 64).trim().length).toBeGreaterThan(0)
    }
    // summary chunk (3) is header-only: its following row is the blank gap
    expect(rows[6]!.slice(0, 64).trim()).toBe('')
    // chips render nothing inline — only on the rail
    expect(rows.join('\n')).not.toContain('Kessa Brandt') // K stays a chip
  })

  test('protected strip carries the left-border marker', () => {
    for (const r of [7, 8, 9]) expect(rows[r]![0]).toBe('▎')
    expect(rows[1]![0]).not.toBe('▎') // unprotected block has none
  })

  test('bottom line: focus info + key hints', () => {
    expect(rows[29]).toContain('▶ A Auric Vayle · expanded')
    expect(rows[29]).toContain('q·quit')
  })

  test('badge brightness is the heat channel (redundant with the bar)', () => {
    expect(grid.get(0, 2).fg).toBe(heatColor('A', 0.82))
    expect(grid.get(0, 2).attrs & ATTR_REVERSE).toBe(ATTR_REVERSE)
    expect(grid.get(7, 2).fg).toBe(heatColor('C', 0.45))
  })

  test('geometry: blocks (inline) + rail (chips) as planned', () => {
    const geo = computeGeometry(midGameState())
    expect(geo.blocks).toEqual([
      { id: 1, top: 0, height: 4, badgeCol: 2 },
      { id: 3, top: 5, height: 1, badgeCol: 2 },
      { id: 5, top: 7, height: 3, badgeCol: 2 },
    ])
    expect(geo.rail).toEqual([
      { id: 0, row: 26, col: 67 },
      { id: 2, row: 26, col: 69 },
      { id: 4, row: 26, col: 71 },
    ])
    expect(geo.clippedTop).toBe(0)
  })
})

describe('golden: death screen', () => {
  const over: OverState = {
    kind: 'oom',
    summary:
      'OOM at tick 1184: next streamed line over budget; chunk #7 [B] (tier 2, 6 lines) was evictable 3 ticks ago — a tier-down would have freed space.',
    result: {
      seed: 7,
      ticksSurvived: 1184,
      roundTicks: 1800,
      survived: false,
      death: null,
      waves: [],
      meanCredit: 0.71,
      residencyMean: 0.42,
      score: 12840,
      pareto: 0.27,
      actionsAccepted: 210,
      actionsRejected: 12,
      actionsPerSec: 0.6,
    },
  }
  const grid = renderScreen(midGameState({ over }))

  test('cause title, attribution summary, big additive score', () => {
    expect(gridRegion(grid, 7, 17, 66, 1)[0]).toBe('│                         OUT OF MEMORY                          │')
    expect(gridRegion(grid, 13, 17, 66, 1)[0]).toBe('│                        SCORE  1 2 8 4 0                        │')
    const summary = gridRegion(grid, 9, 17, 66, 3).join(' ')
    expect(summary).toContain('OOM at tick 1184')
    expect(summary).toContain('tier-down would have freed space')
  })

  test('Pareto table styled after the paper Table 1 (exact rows)', () => {
    expect(gridRegion(grid, 15, 17, 66, 5)).toEqual([
      '│   policy            surv  recall   resid  pareto               │',
      '│ ▸ YOU               0.66    0.71    0.42    0.27               │',
      '│   FM-DS-V4          1.00    1.01   0.135    0.87               │',
      '│   Recency-Only         —    0.33       —       —               │',
      '│   Random-10%           —    0.39    0.10       —               │',
    ])
  })

  test('paretoRows derives YOU from the RoundResult', () => {
    expect(paretoRows(over.result)[1]).toEqual(['YOU', '0.66', '0.71', '0.42', '0.27'])
  })

  test('survived rounds get the triumphant variant', () => {
    const g = renderScreen(midGameState({ over: { ...over, kind: 'survived', summary: 'held' } }))
    const all = gridRows(g).join('\n')
    expect(all).toContain('ROUND SURVIVED')
    expect(all).toContain('the indexer held')
  })

  test('the game underneath is dimmed', () => {
    // a prose cell outside the panel: still its char, now faint + DIM
    const cell = grid.get(1, 3)
    expect(cell.attrs & ATTR_DIM).toBe(ATTR_DIM)
    expect(cell.fg).toBe(UI.faint)
  })
})

describe('screen behaviors', () => {
  test('miss effect corrupts the streaming tail and flashes the coherence bar', () => {
    const clean = renderScreen(midGameState())
    const corrupted = renderScreen(midGameState({ corruptUntilTick: 120 })) // tick 112 < 120
    // streaming chunk (5) prose rows differ; finished chunk (1) prose intact
    const cleanC = gridRegion(clean, 8, 2, 62, 2).join('\n')
    const corrC = gridRegion(corrupted, 8, 2, 62, 2).join('\n')
    expect(corrC).not.toBe(cleanC)
    expect(gridRegion(corrupted, 1, 2, 62, 3)).toEqual(gridRegion(clean, 1, 2, 62, 3))
    // coherence bar flashes (reverse video)
    expect(corrupted.get(2, 71).attrs & ATTR_REVERSE).toBe(ATTR_REVERSE)
    expect(clean.get(2, 71).attrs & ATTR_REVERSE).toBe(0)
  })

  test('corruptChar is deterministic and keeps spaces', () => {
    expect(corruptChar('a', 5, 3, 7)).toBe(corruptChar('a', 5, 3, 7))
    expect(corruptChar(' ', 5, 3, 7)).toBe(' ')
    const subs = new Set<string>()
    for (let col = 0; col < 40; col++) subs.add(corruptChar('a', 5, 3, col))
    expect(subs.size).toBeGreaterThan(3) // varies across cells
  })

  test('zen indicator and cliff warning', () => {
    const zen = renderScreen(midGameState({ view: { ...midGameView(), zenActive: true } }))
    expect(gridRows(zen).join('\n')).toContain('ZEN — purge for bonus')
    const cliff = renderScreen(midGameState({ view: { ...midGameView(), cliffActive: true } }))
    expect(gridRows(cliff).join('\n')).toContain('SIGNAL DEGRADED')
  })

  test('flash, confirm-quit and paused variants own the bottom line', () => {
    expect(gridRows(renderScreen(midGameState({ flash: 'bus full' })))[29]).toContain('✗ bus full')
    expect(gridRows(renderScreen(midGameState({ confirmQuit: true })))[29]).toContain('q again to quit')
    expect(gridRows(renderScreen(midGameState({ paused: true })))[29]).toContain('PAUSED — mouse off')
    expect(gridRows(renderScreen(midGameState({ paused: true })))[0]).toContain('PAUSED')
  })

  test('too-small terminal renders the friendly minimum-size message', () => {
    const st = screenState({ view: midGameView(), cols: 80, rows: 24, tooSmall: true })
    const all = gridRows(renderScreen(st)).join('\n')
    expect(all).toContain('minimum 100×30 — current 80×24')
    expect(all).not.toContain('INCOMING')
  })

  test('gauge red zone: filled cells in the top 10% turn hot', () => {
    const view = simView({
      chunks: midGameView().chunks,
      meters: { ...midGameView().meters, viewportUsed: 33, viewportBudget: 34 },
    })
    const g = renderScreen(screenState({ view }))
    expect(g.get(2, 97).ch).toBe('█') // top gauge cell filled at 97%
    expect(g.get(2, 97).fg).toBe(UI.gaugeHot)
  })

  test('stream-anchored clipping: overflow drops the top with a ⋯ marker', () => {
    const chunks = Array.from({ length: 9 }, (_, i) =>
      chunk({ id: i, glyph: 'ABCDEFGHI'[i]!, tier: 2, linesExpanded: 4, tokensShown: 44, tokensTotal: 44 }),
    )
    const st = screenState({ view: simView({ chunks }) })
    const geo = computeGeometry(st)
    expect(geo.clippedTop).toBeGreaterThan(0)
    expect(geo.blocks[0]!.top).toBeLessThan(0)
    expect(gridRows(renderScreen(st))[0]).toContain('⋯')
  })

  test('rail overflow shows +N', () => {
    const chunks = Array.from({ length: 60 }, (_, i) => chunk({ id: i, glyph: 'X', tier: 0 }))
    const st = screenState({ view: simView({ chunks }) })
    const geo = computeGeometry(st)
    expect(geo.railOverflow).toBeGreaterThan(0)
    expect(gridRows(renderScreen(st)).join('\n')).toContain(`+${geo.railOverflow}`)
  })

  test('isInline: chips are rail-only unless transferring', () => {
    expect(isInline(chunk({ id: 0, glyph: 'A', tier: 0 }))).toBe(false)
    expect(isInline(chunk({ id: 0, glyph: 'A', tier: 0, transfer: { toTier: 1, startTick: 0, arriveTick: 40 } }))).toBe(true)
    expect(isInline(chunk({ id: 0, glyph: 'A', tier: 1 }))).toBe(true)
  })

  test('sliceCells honors cell ranges across wide graphemes', () => {
    expect(sliceCells('abcdef', 1, 4)).toBe('bcd')
    expect(sliceCells('日本語', 0, 2)).toBe('日')
    expect(sliceCells('日本語', 2, 6)).toBe('本語')
  })
})

describe('tween application in the screen', () => {
  const samples = (entries: TweenSample[]): Map<string, TweenSample> =>
    new Map(entries.map((s) => [s.key, s]))

  test('a moved segment draws at the sampled position, not its layout slot', () => {
    const st = midGameState({
      tweens: samples([{ key: 'c1s0', kind: 'move', row: 2, col: 10, t: 0.5 }]),
    })
    const g = renderScreen(st)
    // seg 0 of chunk 1 is the word "Auric": normally at (1,2); tweened to (3,12)
    expect(g.get(3, 12).ch).toBe('A')
    expect(g.get(1, 2).ch).toBe(' ')
  })

  test('an entering segment fades in via DIM until the tween completes', () => {
    const st = midGameState({
      tweens: samples([{ key: 'c1s0', kind: 'enter', row: 0, col: 0, t: 0.4 }]),
    })
    const g = renderScreen(st)
    expect(g.get(1, 2).ch).toBe('A')
    expect(g.get(1, 2).attrs & ATTR_DIM).toBe(ATTR_DIM)
  })

  test('an exit sample draws its text truncated toward the badge', () => {
    const st = midGameState({
      tweens: samples([{ key: 'c9x1', kind: 'exit', row: 12, col: 30, t: 0.5, text: 'gone' }]),
    })
    const g = renderScreen(st)
    expect(g.get(12, 30).ch).toBe('g')
    expect(g.get(12, 31).ch).toBe('o')
    expect(g.get(12, 32).ch).toBe(' ') // ceil(4 · (1−0.5)) = 2 chars kept
    expect(g.get(12, 30).attrs & ATTR_DIM).toBe(ATTR_DIM)
  })

  test('a block move tween shifts the whole chunk (header + prose)', () => {
    const st = midGameState({
      tweens: samples([{ key: 'b1', kind: 'move', row: 2, col: 0, t: 0.3 }]),
    })
    const g = renderScreen(st)
    expect(g.get(2, 2).ch).toBe('A') // header badge now on row 2
    expect(g.get(0, 2).ch).toBe(' ')
    expect(gridRows(g)[3]).toContain('Auric Vayle,') // prose follows
  })
})
