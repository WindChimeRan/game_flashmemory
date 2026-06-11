/**
 * prepare()/append() — segmentation goldens and stable-ID contract tests
 * (src/pretext/types.ts invariants: stable ids, monotonic assignment, tail
 * re-segmentation that never touches ids before the last whitespace
 * boundary).
 */

import { describe, expect, test } from 'bun:test'
import { append, prepare } from '../../src/pretext'
import type { Prepared } from '../../src/pretext'
import { mulberry32, pick, randomPiece, randomSoup } from './helpers'

/** kind/text/width triples — segmentation shape without ids. */
const shape = (p: Prepared): Array<[string, string, number]> =>
  p.segments.map((s) => [s.kind, s.text, s.width])
const ids = (p: Prepared): number[] => p.segments.map((s) => s.id)

describe('prepare: classification', () => {
  test('plain ASCII words and spaces', () => {
    const p = prepare('the quick fox')
    expect(shape(p)).toEqual([
      ['word', 'the', 3],
      ['space', ' ', 1],
      ['word', 'quick', 5],
      ['space', ' ', 1],
      ['word', 'fox', 3],
    ])
    expect(ids(p)).toEqual([0, 1, 2, 3, 4])
    expect(p.version).toBe(0)
  })

  test('whitespace runs collapse into one space segment (tab measures 0)', () => {
    const p = prepare('a \t b')
    expect(shape(p)).toEqual([
      ['word', 'a', 1],
      ['space', ' \t ', 2],
      ['word', 'b', 1],
    ])
  })

  test('NBSP is non-breaking: glued into the word', () => {
    expect(shape(prepare('a\u00a0b'))).toEqual([['word', 'a\u00a0b', 3]])
  })

  test('ideographic space U+3000 is a width-2 space', () => {
    expect(shape(prepare('a\u3000b'))).toEqual([
      ['word', 'a', 1],
      ['space', '\u3000', 2],
      ['word', 'b', 1],
    ])
  })

  test('newlines: one break each; CRLF is a single break', () => {
    const p = prepare('x\n\r\ny\rz')
    expect(shape(p)).toEqual([
      ['word', 'x', 1],
      ['break', '\n', 0],
      ['break', '\r\n', 0],
      ['word', 'y', 1],
      ['break', '\r', 0],
      ['word', 'z', 1],
    ])
  })

  test('U+2028 line separator is a break', () => {
    expect(shape(prepare('a\u2028b'))).toEqual([
      ['word', 'a', 1],
      ['break', '\u2028', 0],
      ['word', 'b', 1],
    ])
  })

  test('every wide grapheme is its own breakable word segment', () => {
    expect(shape(prepare('abc日本def'))).toEqual([
      ['word', 'abc', 3],
      ['word', '日', 2],
      ['word', '本', 2],
      ['word', 'def', 3],
    ])
  })

  test('emoji ZWJ family sequence is ONE width-2 segment', () => {
    const fam = '👨‍👩‍👧‍👦'
    expect(shape(prepare(`go${fam}x`))).toEqual([
      ['word', 'go', 2],
      ['word', fam, 2],
      ['word', 'x', 1],
    ])
  })

  test('regional-indicator flags pair into single wide segments', () => {
    expect(shape(prepare('🇺🇸🇯🇵'))).toEqual([
      ['word', '🇺🇸', 2],
      ['word', '🇯🇵', 2],
    ])
  })

  test('combining marks stay inside their base word', () => {
    const p = prepare('cafe\u0301 x')
    expect(shape(p)).toEqual([
      ['word', 'cafe\u0301', 4],
      ['space', ' ', 1],
      ['word', 'x', 1],
    ])
  })

  test('empty string prepares to zero segments', () => {
    const p = prepare('')
    expect(p.segments).toEqual([])
    expect(p.version).toBe(0)
  })
})

// NOTE: core append id-stability goldens (trailing-word retirement,
// whitespace appends, CJK tails, RI pairing, id-reuse chains) live in
// append.test.ts; this file adds the seam-merge and shape-equality cases.
describe('append: seam merges & lineage shape', () => {
  test('combining mark merges into the trailing word', () => {
    const p2 = append(prepare('x ab'), '\u0301c')
    expect(shape(p2)).toEqual([
      ['word', 'x', 1],
      ['space', ' ', 1],
      ['word', 'ab\u0301c', 3],
    ])
    expect(ids(p2)).toEqual([0, 1, 3])
  })

  test('split CRLF merges into one break across append', () => {
    const p2 = append(prepare('a\r'), '\nb')
    expect(shape(p2)).toEqual([
      ['word', 'a', 1],
      ['break', '\r\n', 0],
      ['word', 'b', 1],
    ])
    expect(ids(p2)).toEqual([0, 2, 3]) // '\r' (id 1) retired for the merged '\r\n'
  })

  test('combining mark after a trailing space merges into the space cluster', () => {
    const p2 = append(prepare('a '), '\u0301b')
    expect(shape(p2)).toEqual([
      ['word', 'a', 1],
      ['space', ' \u0301', 1],
      ['word', 'b', 1],
    ])
  })

  test('split surrogate pair is reassembled across append', () => {
    const emoji = '😀' // U+1F600 — two code units
    const p2 = append(prepare('hi ' + emoji[0]!), emoji[1]!)
    expect(shape(p2)).toEqual([
      ['word', 'hi', 2],
      ['space', ' ', 1],
      ['word', emoji, 2],
    ])
  })

  test('append to an empty prepare', () => {
    const p2 = append(prepare(''), 'hi there')
    expect(shape(p2)).toEqual([
      ['word', 'hi', 2],
      ['space', ' ', 1],
      ['word', 'there', 5],
    ])
    expect(ids(p2)).toEqual([0, 1, 2])
  })

  test('ids before the last whitespace boundary never change; fresh ids only grow', () => {
    const rng = mulberry32(0xbeef)
    let p = prepare('seed text ')
    let maxSeen = Math.max(...ids(p))
    for (let step = 0; step < 40; step++) {
      const before = p.segments
      const piece = step % 3 === 0 ? randomSoup(rng, 12) : randomPiece(rng)
      const next = append(p, piece)
      // Find the last whitespace boundary of the OLD segment list.
      let b = before.length
      while (b > 0 && before[b - 1]!.kind === 'word') b--
      if (b > 0) b-- // the boundary segment itself may legitimately merge
      for (let i = 0; i < b; i++) expect(next.segments[i]).toBe(before[i]!)
      // Monotonic versions, monotonic fresh ids, no id reuse.
      expect(next.version).toBe(p.version + 1)
      const oldIds = new Set(ids(p))
      for (const s of next.segments) {
        if (!oldIds.has(s.id)) {
          expect(s.id).toBeGreaterThan(maxSeen)
          maxSeen = s.id
        }
      }
      // Ids strictly increase along the segment list.
      const seq = ids(next)
      for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeGreaterThan(seq[i - 1]!)
      p = next
    }
  })

  test('property: append lineage is segment-shape-identical to from-scratch prepare', () => {
    for (let seed = 0; seed < 60; seed++) {
      const rng = mulberry32(seed * 2654435761 + 1)
      let text = randomPiece(rng)
      let p = prepare(text)
      for (let step = 0; step < 6; step++) {
        const piece =
          rng() < 0.5
            ? randomPiece(rng)
            : rng() < 0.7
              ? randomSoup(rng, 16)
              : pick(rng, ['\n', '\r', '\n\r', '\r\n', ' ', '\u0301', '🇸', '\u200d', '😀'[0]!, '😀'[1]!])
        text += piece
        p = append(p, piece)
        expect(shape(p)).toEqual(shape(prepare(text)))
      }
    }
  })
})
