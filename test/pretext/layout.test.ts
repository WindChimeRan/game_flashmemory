/**
 * layout() golden wrapping tests — exact expected lines for the contract's
 * wrapping rules: greedy wrap, line-end space consumption, spaces never
 * starting a wrapped line, hard breaks, CJK anywhere-wrap, emoji/combining
 * widths, over-wide hard slicing, exact-fit edges, the width-1 tolerated
 * exception.
 */

import { describe, expect, test } from 'bun:test'
import { layout, prepare } from '../../src/pretext'
import type { Layout, Prepared } from '../../src/pretext'
import { checkAll, renderLines } from './helpers'

/** Layout + full invariant check + rendered lines, in one call. */
function lay(p: Prepared, width: number): { l: Layout; lines: string[] } {
  const l = layout(p, width)
  checkAll(p, l, l.width)
  return { l, lines: renderLines(p, l) }
}

describe('plain ASCII paragraph', () => {
  test('greedy wrap at width 10, line-end spaces consumed', () => {
    const p = prepare('the quick brown fox jumps over the lazy dog')
    const { l, lines } = lay(p, 10)
    expect(lines).toEqual(['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog'])
    expect(l.lines.map((ln) => ln.width)).toEqual([9, 9, 10, 8, 3])
    // The space between "jumps" and "over" is placed mid-line; the one after
    // "over" lands at the line end and is consumed (no placement).
    expect(l.lines[2]!.placements.length).toBe(3)
  })

  test('width and version are recorded; fractional width floors', () => {
    const p = prepare('a b c')
    const l = layout(p, 10.9)
    expect(l.width).toBe(10)
    expect(l.version).toBe(p.version)
  })

  test('purity: same inputs give deeply equal layouts', () => {
    const p = prepare('the quick brown fox\n\njumps 日本語 over 👨‍👩‍👧‍👦 the lazy dog')
    expect(layout(p, 13)).toEqual(layout(p, 13))
  })
})

describe('CJK / Latin mixed', () => {
  test('pure CJK wraps between any two glyphs', () => {
    const p = prepare('你好世界平')
    const { lines } = lay(p, 5)
    expect(lines).toEqual(['你好', '世界', '平'])
  })

  test('Latin glues to a following CJK glyph; break allowed after the glyph', () => {
    const p = prepare('OOM是memory索引器')
    const { lines } = lay(p, 8)
    expect(lines).toEqual(['OOM是', 'memory索', '引器'])
  })

  test('odd width leaves a dangling cell rather than splitting a glyph', () => {
    const p = prepare('日本語テキスト')
    const { l, lines } = lay(p, 5)
    expect(lines).toEqual(['日本', '語テ', 'キス', 'ト'])
    expect(l.lines[0]!.width).toBe(4) // 5th cell unusable for a width-2 glyph
  })
})

describe('emoji & combining marks', () => {
  test('ZWJ family sequence wraps as one width-2 unit', () => {
    const fam = '👨‍👩‍👧‍👦'
    const p = prepare(`hi ${fam} fam`)
    const { l, lines } = lay(p, 4)
    expect(lines).toEqual(['hi', fam, 'fam'])
    expect(l.lines[1]!.width).toBe(2)
  })

  test('combining marks add no width', () => {
    const p = prepare('café noir')
    const { l, lines } = lay(p, 5)
    expect(lines).toEqual(['café', 'noir'])
    expect(l.lines[0]!.width).toBe(4)
  })
})

describe('over-wide words: hard slicing', () => {
  test('a 25-cell word slices across 3 lines at width 10, then flow resumes', () => {
    const p = prepare('abcdefghijklmnopqrstuvwxy end')
    const { l, lines } = lay(p, 10)
    expect(lines).toEqual(['abcdefghij', 'klmnopqrst', 'uvwxy end'])
    const wordId = p.segments[0]!.id
    const slices = l.lines.flatMap((ln) => ln.placements.filter((pl) => pl.segId === wordId))
    expect(slices.map((pl) => pl.slice)).toEqual([
      [0, 10],
      [10, 20],
      [20, 25],
    ])
    expect(slices.map((pl) => [pl.col, pl.width])).toEqual([
      [0, 10],
      [0, 10],
      [0, 5],
    ])
  })

  test('an over-wide word starts on a fresh line (no mid-line slice start)', () => {
    const p = prepare('xy abcdefgh')
    const { l, lines } = lay(p, 5)
    expect(lines).toEqual(['xy', 'abcde', 'fgh'])
    expect(l.lines[1]!.placements[0]!.slice).toEqual([0, 5])
  })

  test('exact multiple of width: slices with no remainder line', () => {
    const p = prepare('abcdefghij')
    const { lines } = lay(p, 5)
    expect(lines).toEqual(['abcde', 'fghij'])
  })
})

describe('exact-fit edges', () => {
  test('word exactly the wrap width fills the line', () => {
    const { lines } = lay(prepare('abcde fghij'), 5)
    expect(lines).toEqual(['abcde', 'fghij'])
  })

  test('space + word exactly fit together', () => {
    const { l, lines } = lay(prepare('ab cd'), 5)
    expect(lines).toEqual(['ab cd'])
    expect(l.lines[0]!.width).toBe(5)
  })

  test('one cell short: space is consumed at the break', () => {
    const { lines } = lay(prepare('ab cde'), 5)
    expect(lines).toEqual(['ab', 'cde'])
  })

  test('wrapped lines never start with a space', () => {
    const { l, lines } = lay(prepare('aaaa bb'), 4)
    expect(lines).toEqual(['aaaa', 'bb'])
    expect(l.lines[1]!.placements[0]!.col).toBe(0)
  })
})

describe('hard breaks & empties', () => {
  test('empty string lays out as a single empty line', () => {
    const p = prepare('')
    const { l } = lay(p, 10)
    expect(l.lines).toEqual([{ placements: [], width: 0 }])
  })

  test('consecutive newlines preserve blank lines', () => {
    const { lines } = lay(prepare('a\n\nb'), 10)
    expect(lines).toEqual(['a', '', 'b'])
  })

  test('trailing newline opens a trailing empty line', () => {
    const { lines } = lay(prepare('a\n'), 10)
    expect(lines).toEqual(['a', ''])
  })

  test('CRLF counts as one break', () => {
    const { lines } = lay(prepare('a\r\nb'), 10)
    expect(lines).toEqual(['a', 'b'])
  })

  test('indentation after a hard break is preserved', () => {
    const p = prepare('first\n  indented')
    const { l, lines } = lay(p, 20)
    expect(lines).toEqual(['first', '  indented'])
    expect(l.lines[1]!.placements[0]!).toEqual({ segId: p.segments[2]!.id, col: 0, width: 2 })
  })

  test('trailing spaces before a newline are consumed', () => {
    const p = prepare('ab \ncd')
    const { l, lines } = lay(p, 10)
    expect(lines).toEqual(['ab', 'cd'])
    expect(l.lines[0]!.width).toBe(2)
  })

  test('spaces-only text yields one empty line (fully consumed)', () => {
    const { l } = lay(prepare('   '), 10)
    expect(l.lines).toEqual([{ placements: [], width: 0 }])
  })
})

describe('width-1 tolerated exception', () => {
  test('a width-2 grapheme at width 1 overflows by one cell, alone on its line', () => {
    const p = prepare('ab 日')
    const { l, lines } = lay(p, 1)
    expect(lines).toEqual(['a', 'b', '日'])
    expect(l.lines.map((ln) => ln.width)).toEqual([1, 1, 2])
  })

  test('every line of a pure-CJK text at width 1 carries one glyph', () => {
    const p = prepare('你好')
    const { l, lines } = lay(p, 1)
    expect(lines).toEqual(['你', '好'])
    expect(l.lines.map((ln) => ln.width)).toEqual([2, 2])
  })
})

describe('viewport-shaped smoke', () => {
  test('a paragraph reflows consistently across widths (40 → 20 → 40)', () => {
    const text =
      'Memory pressure rises as the stream lands. 索引器 must evict cold chunks ' +
      'before the viewport overflows, yet prefetch 未来 needs ahead of the wave.'
    const p = prepare(text)
    const w40 = lay(p, 40).lines
    const w20 = lay(p, 20).lines
    const again = lay(p, 40).lines
    expect(again).toEqual(w40)
    expect(w20.length).toBeGreaterThan(w40.length)
    // Stripping whitespace, both widths render the same character stream.
    const flat = (ls: string[]) => ls.join('').replace(/\s+/g, '')
    expect(flat(w20)).toBe(flat(w40))
  })
})
