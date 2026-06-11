/**
 * append() stable-ID contract: ids before the last whitespace boundary are
 * untouched (same objects); an extended trailing word is RETIRED and gets a
 * fresh id (never reused, never mutated); appends starting with whitespace
 * retire nothing; grapheme clustering is re-run across the splice point.
 */

import { describe, expect, test } from 'bun:test'
import { append, prepare } from '../../src/pretext'
import { mulberry32, randomPiece } from './helpers'

describe('append: stable ids', () => {
  test('extending a trailing word retires it for a fresh id', () => {
    const p1 = prepare('hello wor')
    expect(p1.segments.map((s) => s.id)).toEqual([0, 1, 2])
    const p2 = append(p1, 'ld extra')
    // prefix untouched, by object identity
    expect(p2.segments[0]).toBe(p1.segments[0])
    expect(p2.segments[1]).toBe(p1.segments[1])
    // "wor" (id 2) retired; replacement is a fresh id, never 2 again
    expect(p2.segments.map((s) => s.text)).toEqual(['hello', ' ', 'world', ' ', 'extra'])
    expect(p2.segments.map((s) => s.id)).toEqual([0, 1, 3, 4, 5])
    expect(p2.segments.some((s) => s.id === 2)).toBe(false)
    // p1 itself is untouched (no mutation)
    expect(p1.segments.map((s) => s.text)).toEqual(['hello', ' ', 'wor'])
    expect(p1.version).toBe(0)
    expect(p2.version).toBe(1)
  })

  test('append starting with whitespace retires nothing', () => {
    const p1 = prepare('hello world')
    const p2 = append(p1, ' more')
    expect(p2.segments[0]).toBe(p1.segments[0])
    expect(p2.segments[1]).toBe(p1.segments[1])
    expect(p2.segments[2]).toBe(p1.segments[2]) // trailing word kept
    expect(p2.segments.map((s) => s.text)).toEqual(['hello', ' ', 'world', ' ', 'more'])
    expect(p2.segments.map((s) => s.id)).toEqual([0, 1, 2, 3, 4])
  })

  test('appended whitespace merges into a trailing space run (boundary re-segmented)', () => {
    const p1 = prepare('hello ')
    const p2 = append(p1, ' next')
    // the boundary space is re-segmented with the appended text: the two
    // spaces fuse into one run, exactly like a from-scratch prepare; the old
    // space id is retired for the merged segment
    expect(p2.segments.map((s) => [s.kind, s.text])).toEqual([
      ['word', 'hello'],
      ['space', '  '],
      ['word', 'next'],
    ])
    expect(p2.segments[0]).toBe(p1.segments[0])
    expect(p2.segments.map((s) => s.id)).toEqual([0, 2, 3])
  })

  test('append after a trailing space keeps the space id when nothing merges', () => {
    const p1 = prepare('hello ')
    const p2 = append(p1, 'next one')
    expect(p2.segments[1]).toBe(p1.segments[1]) // boundary untouched → kept
    expect(p2.segments.map((s) => [s.kind, s.text])).toEqual([
      ['word', 'hello'],
      ['space', ' '],
      ['word', 'next'],
      ['space', ' '],
      ['word', 'one'],
    ])
    expect(p2.segments.map((s) => s.id)).toEqual([0, 1, 2, 3, 4])
  })

  test('extending a CJK run retires nothing (glyphs are complete segments)', () => {
    const p1 = prepare('日本')
    const p2 = append(p1, '語x')
    expect(p2.segments[0]).toBe(p1.segments[0])
    expect(p2.segments[1]).toBe(p1.segments[1])
    expect(p2.segments.map((s) => s.text)).toEqual(['日', '本', '語', 'x'])
    expect(p2.segments.map((s) => s.id)).toEqual([0, 1, 2, 3])
  })

  test('combining mark joins the trailing word across the splice', () => {
    const p1 = prepare('cafe')
    const p2 = append(p1, '́!')
    expect(p2.segments).toHaveLength(1)
    expect(p2.segments[0]!.text).toBe('café!')
    expect(p2.segments[0]!.width).toBe(5) // e+mark is one width-1 grapheme
    expect(p2.segments[0]!.id).toBe(1) // fresh id, 0 retired
  })

  test('regional indicators pair across the splice', () => {
    const p1 = prepare('🇺')
    const p2 = append(p1, '🇸')
    expect(p2.segments).toHaveLength(1)
    expect(p2.segments[0]!.text).toBe('🇺🇸')
    expect(p2.segments[0]!.width).toBe(2)
    expect(p2.segments[0]!.id).toBe(1)
  })

  test('a break is a whitespace boundary: nothing before it is touched', () => {
    const p1 = prepare('ab\n')
    const p2 = append(p1, 'cd')
    expect(p2.segments[0]).toBe(p1.segments[0])
    expect(p2.segments[1]).toBe(p1.segments[1])
    expect(p2.segments.map((s) => [s.kind, s.text])).toEqual([
      ['word', 'ab'],
      ['break', '\n'],
      ['word', 'cd'],
    ])
  })

  test('appended text may itself contain spaces and breaks', () => {
    const p1 = prepare('cd')
    const p2 = append(p1, 'ef\ngh ij')
    expect(p2.segments.map((s) => [s.kind, s.text])).toEqual([
      ['word', 'cdef'],
      ['break', '\n'],
      ['word', 'gh'],
      ['space', ' '],
      ['word', 'ij'],
    ])
    expect(p2.segments.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]) // 0 retired
  })

  test('empty append bumps the version and changes nothing else', () => {
    const p1 = prepare('hello world')
    const p2 = append(p1, '')
    expect(p2.version).toBe(1)
    expect(p2.segments).toEqual(p1.segments)
    expect(p2.segments[2]).toBe(p1.segments[2])
  })

  test('ids are never reused across a whole random append chain', () => {
    const rng = mulberry32(0x5eed1d)
    for (let chain = 0; chain < 20; chain++) {
      let p = prepare(randomPiece(rng))
      const seen = new Set<number>(p.segments.map((s) => s.id))
      let prevIds = new Set<number>(p.segments.map((s) => s.id))
      for (let k = 0; k < 8; k++) {
        const next = append(p, randomPiece(rng))
        expect(next.version).toBe(p.version + 1)
        for (const s of next.segments) {
          if (!prevIds.has(s.id)) {
            // fresh segment: its id must never have existed in this lineage
            expect(seen.has(s.id)).toBe(false)
            seen.add(s.id)
          }
        }
        prevIds = new Set(next.segments.map((s) => s.id))
        p = next
      }
    }
  })
})
