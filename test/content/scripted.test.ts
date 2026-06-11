/**
 * ScriptedProvider: deterministic from the spec, ≥ targetTokens pieces with
 * trailing spaces, printable ASCII (no control chars — the renderer must
 * never see ANSI/zero-width trickery from a provider), themed pulp prose
 * (not lorem ipsum), total over arbitrary glyph/theme inputs.
 */

import { describe, expect, test } from 'bun:test'
import type { ChunkSpec } from '../../src/sim/types'
import { ScriptedProvider, characterFor, motifsFor } from '../../src/content/scripted'

const spec = (over: Partial<ChunkSpec>): ChunkSpec => ({
  chunkId: 3,
  glyph: 'A',
  theme: 'archive',
  targetTokens: 60,
  seed: 12345,
  ...over,
})

async function collect(s: ChunkSpec, provider = new ScriptedProvider()): Promise<string[]> {
  const out: string[] = []
  for await (const piece of provider.nextChunk(s)) out.push(piece)
  return out
}

describe('ScriptedProvider', () => {
  test('same spec ⇒ identical stream (across provider instances)', async () => {
    const a = await collect(spec({}))
    const b = await collect(spec({}), new ScriptedProvider())
    expect(a).toEqual(b)
    expect(a.length).toBeGreaterThan(0)
  })

  test('yields ≥ targetTokens pieces, each a word with a trailing space', async () => {
    for (const target of [1, 44, 77, 300]) {
      const pieces = await collect(spec({ targetTokens: target, seed: 777 + target }))
      expect(pieces.length).toBeGreaterThanOrEqual(target)
      for (const p of pieces) {
        expect(p.endsWith(' ')).toBe(true)
        expect(p.trim().length).toBeGreaterThan(0)
        expect(/^\S+ $/.test(p)).toBe(true) // single word + single trailing space
      }
    }
  })

  test('no control characters anywhere (C0, DEL)', async () => {
    for (const seed of [1, 99, 4242]) {
      const text = (await collect(spec({ seed, targetTokens: 200 }))).join('')
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f\x7f]/.test(text)).toBe(false)
    }
  })

  test('different seeds ⇒ different prose', async () => {
    const a = (await collect(spec({ seed: 1 }))).join('')
    const b = (await collect(spec({ seed: 2 }))).join('')
    expect(a).not.toBe(b)
  })

  test('pulp serial, not lorem ipsum: names the glyph character, uses theme motifs', async () => {
    const text = (await collect(spec({ glyph: 'B', theme: 'engine', targetTokens: 120, seed: 9 }))).join('')
    expect(text.toLowerCase()).not.toContain('lorem')
    const who = characterFor('B')
    expect(who.name).toBe('Brakka Voss')
    expect(text).toContain(who.name.split(' ')[0]!)
    const motifs = motifsFor('engine')
    expect(motifs.length).toBeGreaterThanOrEqual(3)
    expect(motifs.some((m) => text.includes(m))).toBe(true)
  })

  test('glyph identity changes the cast; per-glyph character is stable', async () => {
    const a = (await collect(spec({ glyph: 'A', seed: 5 }))).join('')
    const k = (await collect(spec({ glyph: 'K', seed: 5 }))).join('')
    expect(a).not.toBe(k)
    expect(characterFor('K')).toEqual(characterFor('K'))
    expect(characterFor('A').name).not.toBe(characterFor('K').name)
  })

  test('total over unknown glyphs and themes (deterministic fallbacks)', async () => {
    const pieces = await collect(spec({ glyph: '@', theme: 'no-such-theme', targetTokens: 50, seed: 31 }))
    expect(pieces.length).toBeGreaterThanOrEqual(50)
    const text = pieces.join('')
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f]/.test(text)).toBe(false)
    expect(motifsFor('no-such-theme').length).toBeGreaterThanOrEqual(3)
  })

  test('targetTokens ≤ 0 still yields at least one sentence', async () => {
    const pieces = await collect(spec({ targetTokens: 0, seed: 8 }))
    expect(pieces.length).toBeGreaterThan(0)
  })
})
