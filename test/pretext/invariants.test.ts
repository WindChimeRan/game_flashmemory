/**
 * Contract invariants over seeded random documents:
 * (b) every word segment placed exactly once or sliced covering all cells
 *     exactly once; (c) no line exceeds the wrap width (tolerated exception
 *     aside) and placements tile lines contiguously; (d) reading placements
 *     in order reconstructs segment order. Plus purity/determinism.
 */

import { describe, expect, test } from 'bun:test'
import { append, layout, prepare } from '../../src/pretext'
import { checkAll, int, mulberry32, randomPiece } from './helpers'

describe('layout invariants on random documents', () => {
  test('coverage, line widths, reading order across widths', () => {
    const rng = mulberry32(0xab5eed)
    let checked = 0
    for (let doc = 0; doc < 60; doc++) {
      const text = randomPiece(rng) + (rng() < 0.3 ? '\n' + randomPiece(rng) : '')
      const p = prepare(text)
      for (const width of [1, 2, 7, 23, 61]) {
        checkAll(p, layout(p, width), width)
        checked++
      }
    }
    expect(checked).toBe(300)
  })

  test('invariants hold along append chains', () => {
    const rng = mulberry32(0xfeed5)
    for (let chain = 0; chain < 15; chain++) {
      let p = prepare(randomPiece(rng))
      for (let k = 0; k < 6; k++) {
        p = append(p, randomPiece(rng))
        const width = int(rng, 1, 40)
        checkAll(p, layout(p, width), width)
      }
    }
  })

  test('purity: same inputs give deeply equal outputs', () => {
    const rng = mulberry32(0xdec0de)
    for (let i = 0; i < 20; i++) {
      const text = randomPiece(rng)
      const w = int(rng, 1, 50)
      const p1 = prepare(text)
      const p2 = prepare(text)
      expect(p2).toEqual(p1) // prepare is deterministic (ids included)
      expect(layout(p1, w)).toEqual(layout(p2, w))
      expect(layout(p1, w)).toEqual(layout(p1, w))
    }
  })

  test('layout does not mutate Prepared or prev', () => {
    const p = prepare('one two three 日本語 four')
    const segsBefore = JSON.stringify(p.segments)
    const prev = layout(p, 8)
    const prevBefore = JSON.stringify(prev)
    const p2 = append(p, ' five six')
    layout(p2, 8, prev)
    layout(p2, 8)
    expect(JSON.stringify(p.segments)).toBe(segsBefore)
    expect(JSON.stringify(prev)).toBe(prevBefore)
  })
})
