/**
 * ScriptedProvider adversarial probes — the piece/token accounting contract:
 * the sim charges 1 tick per token and the consumer counts PIECES, so pieces
 * must map 1:1 onto whitespace-delimited words (a hidden double space or an
 * empty piece would desync tokensShown from rendered words), the stream must
 * stop within one sentence of the target (bounded overshoot, even for huge
 * targets), and glyph→character mapping must be total + case-insensitive.
 */

import { describe, expect, test } from 'bun:test'
import type { ChunkSpec } from '../../src/sim/types'
import { characterFor, scriptedPieces } from '../../src/content/scripted'

const spec = (over: Partial<ChunkSpec>): ChunkSpec => ({
  chunkId: 3,
  glyph: 'A',
  theme: 'archive',
  targetTokens: 60,
  seed: 12345,
  ...over,
})

const collect = (s: ChunkSpec): string[] => [...scriptedPieces(s)]

describe('ScriptedProvider piece/token accounting', () => {
  test('pieces ↔ words are exactly 1:1 after concatenation (no empty/multi-word pieces)', () => {
    for (const seed of [7, 88, 999]) {
      const pieces = collect(spec({ seed, targetTokens: 150 }))
      const words = pieces.join('').split(' ').filter((w) => w.length > 0)
      expect(words.length).toBe(pieces.length)
      expect(pieces.every((p) => /^\S+ $/.test(p))).toBe(true)
    }
  })

  test('huge target terminates with bounded overshoot (finishes the sentence, no more)', () => {
    const target = 4000
    const pieces = collect(spec({ targetTokens: target, seed: 17 }))
    expect(pieces.length).toBeGreaterThanOrEqual(target)
    expect(pieces.length).toBeLessThan(target + 40) // ≤ one template sentence
    const last = pieces[pieces.length - 1]!
    expect(/[.!?] $/.test(last)).toBe(true) // stream ends on a sentence boundary
  })

  test('glyph mapping is case-insensitive and total', () => {
    expect(characterFor('b')).toEqual(characterFor('B'))
    expect(collect(spec({ glyph: 'b', seed: 5 }))).toEqual(collect(spec({ glyph: 'B', seed: 5 })))
    // Empty/unknown glyphs fall back to a deterministic stranger, no crash.
    expect(characterFor('').name).toContain('stranger')
    expect(characterFor('@')).toEqual(characterFor('@'))
    const odd = collect(spec({ glyph: '', theme: '', targetTokens: 30, seed: 2 }))
    expect(odd.length).toBeGreaterThanOrEqual(30)
  })
})
