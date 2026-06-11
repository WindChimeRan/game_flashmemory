/**
 * Chunk-header character names follow the story language: ScreenState
 * carries an optional nameFor (sourced from ContentProvider.nameFor via
 * GameApp); when absent the screen falls back to the scripted English
 * cast — providers without the seam behave exactly as before.
 */

import { describe, expect, test } from 'bun:test'
import { renderScreen } from '../../src/game/screen'
import { GameApp } from '../../src/game/app'
import { preset } from '../../src/sim'
import { ScriptedProvider, characterFor } from '../../src/content/scripted'
import type { ContentProvider } from '../../src/content/types'
import { FakeTerm, chunk, gridRows, gridText, screenState, simView } from './helpers'

const view = simView({ chunks: [chunk({ id: 0, glyph: 'A', tier: 1 })] })

describe('screen · nameFor seam', () => {
  test('headers use nameFor when present (zh cast in zh mode)', () => {
    const g = renderScreen(screenState({ view, nameFor: () => '顾长风' }))
    const text = gridText(g)
    expect(text).toContain('顾长风')
    expect(text).not.toContain('Auric Vayle')
  })

  test('fallback: absent nameFor renders the scripted English cast', () => {
    const g = renderScreen(screenState({ view }))
    expect(gridText(g)).toContain('Auric Vayle')
  })

  test('the focused bottom line uses the same name source', () => {
    const zh = renderScreen(screenState({ view, focusId: 0, nameFor: () => '顾长风' }))
    expect(gridRows(zh)[29]!).toContain('顾长风')
    const en = renderScreen(screenState({ view, focusId: 0 }))
    expect(gridRows(en)[29]!).toContain('Auric Vayle')
  })

  test('wide names keep the header column grid (16-cell pad, CJK-safe)', () => {
    // header layout: badge(2..3) pips(4..6) gap name(8..23) gap bar(25..29);
    // a 6-cell zh name pads to the same 16 cells as the English names
    const zh = renderScreen(screenState({ view, nameFor: () => '顾长风' }))
    const en = renderScreen(screenState({ view }))
    expect(zh.get(0, 8).ch).toBe('顾')
    expect(en.get(0, 8).ch).toBe('A') // 'Auric Vayle'
    expect(zh.get(0, 25).ch).toBe('█') // heat 0.5 → ███·· at the same cell
    expect(en.get(0, 25).ch).toBe('█')
  })
})

describe('GameApp · provider nameFor plumbing', () => {
  test('a provider with nameFor drives header names end to end', async () => {
    const base = new ScriptedProvider()
    const provider: ContentProvider = {
      nextChunk: (spec) => base.nextChunk(spec),
      nameFor: (glyph) => `燕惊鸿${glyph}`,
    }
    const term = new FakeTerm()
    const app = new GameApp({ config: preset('default'), seed: 7, term, rawOut: null, provider })
    app.start(0)
    for (let i = 1; i <= 20; i++) app.frame(i * 100)
    await new Promise<void>((r) => setTimeout(r, 0))
    app.frame(2100)
    expect(gridText(term.last!)).toContain('燕惊鸿')
    app.stop()
  })

  test('default provider (no nameFor) keeps scripted names — old behavior', () => {
    const term = new FakeTerm()
    const app = new GameApp({ config: preset('default'), seed: 7, term, rawOut: null })
    app.start(0)
    for (let i = 1; i <= 20; i++) app.frame(i * 100)
    const text = gridText(term.last!)
    // at least one header shows a scripted cast name for its glyph
    const shown = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].some((g) =>
      text.includes(characterFor(g).name),
    )
    expect(shown).toBe(true)
    app.stop()
  })
})
