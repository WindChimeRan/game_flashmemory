/**
 * Incrementality is invisible (contract invariant): layout(p, w, prev) must
 * be DEEPLY EQUAL to layout(p, w) — prev is only a speed hint. Property-
 * tested over seeded random append chains at random widths, plus targeted
 * edges (version-only bumps, width changes, stale prev, actual line reuse).
 */

import { describe, expect, test } from 'bun:test'
import { append, layout, prepare } from '../../src/pretext'
import type { Layout, Prepared } from '../../src/pretext'
import { checkAll, int, mulberry32, randomPiece } from './helpers'

describe('incremental layout ≡ from-scratch layout', () => {
  test('property: random append chains at random widths (200 increments)', () => {
    const rng = mulberry32(0xc0ffee)
    let increments = 0
    for (let chain = 0; chain < 40; chain++) {
      let p: Prepared = prepare(randomPiece(rng))
      let width = int(rng, 1, 60)
      let prev: Layout = layout(p, width)
      expect(layout(p, width)).toEqual(prev) // determinism baseline
      for (let k = 0; k < 5; k++) {
        p = append(p, randomPiece(rng))
        if (rng() < 0.25) width = int(rng, 1, 60) // width change → full path
        const inc = layout(p, width, prev)
        const scratch = layout(p, width)
        expect(inc).toEqual(scratch)
        checkAll(p, inc, width)
        prev = inc
        increments++
      }
    }
    expect(increments).toBe(200)
  })

  test('empty append: same lines, new version', () => {
    const p1 = prepare('alpha beta gamma delta')
    const prev = layout(p1, 8)
    const p2 = append(p1, '')
    const inc = layout(p2, 8, prev)
    expect(inc.version).toBe(p2.version)
    expect(inc.lines).toEqual(prev.lines)
    expect(inc).toEqual(layout(p2, 8))
  })

  test('same version: prev is already the answer', () => {
    const p = prepare('alpha beta gamma')
    const prev = layout(p, 7)
    expect(layout(p, 7, prev)).toEqual(layout(p, 7))
  })

  test('prev at a different width is ignored, result still correct', () => {
    let p = prepare('alpha beta gamma delta')
    const prevNarrow = layout(p, 6)
    p = append(p, ' epsilon')
    expect(layout(p, 30, prevNarrow)).toEqual(layout(p, 30))
  })

  test('prev several appends old is still a valid hint', () => {
    let p = prepare('one two three four five six seven')
    const stale = layout(p, 10)
    for (const piece of [' eight', ' nine', '日本語', '\nten eleven']) p = append(p, piece)
    expect(layout(p, 10, stale)).toEqual(layout(p, 10))
  })

  test('tail-only append actually reuses untouched line objects', () => {
    // implementation behavior (not contract): early lines are reused by
    // reference, proving the incremental path engaged
    let p = prepare('aaa bbb ccc ddd eee fff ggg hhh')
    const prev = layout(p, 7)
    expect(prev.lines.length).toBeGreaterThan(3)
    p = append(p, 'iii jjj')
    const inc = layout(p, 7, prev)
    expect(inc).toEqual(layout(p, 7))
    expect(inc.lines[0]).toBe(prev.lines[0])
    expect(inc.lines[1]).toBe(prev.lines[1])
  })

  test('incremental across hard breaks and sliced chunks', () => {
    let p = prepare('intro\n\nabcdefghijklmnopqrstuvwxyz then 日本語 follows')
    let prev = layout(p, 6)
    for (const piece of [' tail', 'extended', '\nnew paragraph', ' 漢字漢字漢字漢字']) {
      p = append(p, piece)
      const inc = layout(p, 6, prev)
      expect(inc).toEqual(layout(p, 6))
      prev = inc
    }
  })
})
