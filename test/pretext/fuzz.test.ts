/**
 * Seeded fuzz: grapheme soup (ASCII / CJK / emoji / lone combining marks /
 * ZWJ / NBSP / newlines) at widths 1..120 — never crashes, and the coverage
 * (b), line-width (c), and reading-order (d) invariants hold. Width 1 and 2
 * with wide graphemes exercise the contract's tolerated exception.
 */

import { describe, expect, test } from 'bun:test'
import { append, layout, prepare } from '../../src/pretext'
import { checkAll, int, mulberry32, randomSoup } from './helpers'

describe('fuzz', () => {
  test('500 seeded unicode strings × widths {1, 2, random, random}', () => {
    const rng = mulberry32(0xf0220)
    let layouts = 0
    for (let i = 0; i < 500; i++) {
      const text = randomSoup(rng)
      const p = prepare(text)
      for (const w of [1, 2, int(rng, 3, 120), int(rng, 3, 120)]) {
        checkAll(p, layout(p, w), w)
        layouts++
      }
    }
    expect(layouts).toBe(2000)
  })

  test('wide graphemes at widths 1..8 (tolerated width-2 exception)', () => {
    const nasty = '日本語 ab👨‍👩‍👧‍👦x 🇺🇸🇫🇷 café\n\n✊🏿✊🏿✊🏿 ヲヲ\tz'
    const p = prepare(nasty)
    for (let w = 1; w <= 8; w++) checkAll(p, layout(p, w), w)
    expect(p.segments.length).toBeGreaterThan(0)
  })

  test('append chains of soup: incremental ≡ from-scratch, invariants hold', () => {
    const rng = mulberry32(0xfade5)
    for (let chain = 0; chain < 60; chain++) {
      let p = prepare(randomSoup(rng, 40))
      let width = int(rng, 1, 50)
      let prev = layout(p, width)
      for (let k = 0; k < 5; k++) {
        p = append(p, randomSoup(rng, 30))
        if (rng() < 0.3) width = int(rng, 1, 50)
        const inc = layout(p, width, prev)
        expect(inc).toEqual(layout(p, width))
        checkAll(p, inc, width)
        prev = inc
      }
    }
  })
})
