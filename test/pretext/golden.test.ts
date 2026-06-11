/**
 * Golden wrapping cases (contract: src/pretext/types.ts wrapping rules).
 * Expectations are hand-traced; renderLines() reconstructs visible text
 * from placements, so these also pin down placement structure indirectly.
 */

import { describe, expect, test } from 'bun:test'
import { layout, prepare } from '../../src/pretext'
import { renderLines } from './helpers'

const lines = (text: string, width: number): string[] => {
  const p = prepare(text)
  return renderLines(p, layout(p, width))
}

describe('golden: plain ASCII paragraph', () => {
  const text = 'the quick brown fox jumps over the lazy dog'

  test('width 10', () => {
    expect(lines(text, 10)).toEqual(['the quick', 'brown fox', 'jumps over', 'the lazy', 'dog'])
  })

  test('width 20', () => {
    expect(lines(text, 20)).toEqual(['the quick brown fox', 'jumps over the lazy', 'dog'])
  })

  test('width 40', () => {
    expect(lines(text, 40)).toEqual(['the quick brown fox jumps over the lazy', 'dog'])
  })
})

describe('golden: mixed CJK/Latin', () => {
  test('wraps between CJK glyphs with width-2 accounting', () => {
    const p = prepare('abc 日本語 xy')
    const lay = layout(p, 7)
    expect(renderLines(p, lay)).toEqual(['abc 日', '本語 xy'])
    // exact placement structure (ids are 0:abc 1:sp 2:日 3:本 4:語 5:sp 6:xy)
    expect(lay.lines).toEqual([
      {
        placements: [
          { segId: 0, col: 0, width: 3 },
          { segId: 1, col: 3, width: 1 },
          { segId: 2, col: 4, width: 2 },
        ],
        width: 6,
      },
      {
        placements: [
          { segId: 3, col: 0, width: 2 },
          { segId: 4, col: 2, width: 2 },
          { segId: 5, col: 4, width: 1 },
          { segId: 6, col: 5, width: 2 },
        ],
        width: 7,
      },
    ])
  })

  test('pure CJK wraps anywhere', () => {
    expect(lines('日本語漢字', 4)).toEqual(['日本', '語漢', '字'])
  })

  test('break allowed after a wide glyph before Latin', () => {
    expect(lines('日def', 4)).toEqual(['日', 'def'])
  })

  test('no break between Latin and a following wide glyph when it fits', () => {
    expect(lines('def日', 5)).toEqual(['def日'])
  })

  test('Latin+CJK chunk wider than the line falls back to grapheme slicing', () => {
    const p = prepare('def日')
    const lay = layout(p, 4)
    expect(renderLines(p, lay)).toEqual(['def', '日'])
    // both segments land whole on their lines — no slice fields
    for (const line of lay.lines) for (const pl of line.placements) expect(pl.slice).toBeUndefined()
  })

  test('CJK at width 1: the tolerated width-2 overflow', () => {
    const p = prepare('日本')
    const lay = layout(p, 1)
    expect(renderLines(p, lay)).toEqual(['日', '本'])
    expect(lay.lines.map((l) => l.width)).toEqual([2, 2])
  })
})

describe('golden: emoji and combining marks', () => {
  test('ZWJ family sequence is a single width-2 segment', () => {
    const p = prepare('👨‍👩‍👧‍👦')
    expect(p.segments).toHaveLength(1)
    expect(p.segments[0]!.kind).toBe('word')
    expect(p.segments[0]!.width).toBe(2)
  })

  test('ZWJ family wraps as one unit and never crashes', () => {
    expect(lines('👨‍👩‍👧‍👦 ok', 5)).toEqual(['👨‍👩‍👧‍👦 ok'])
    expect(lines('👨‍👩‍👧‍👦 ok', 2)).toEqual(['👨‍👩‍👧‍👦', 'ok'])
    const p = prepare('👨‍👩‍👧‍👦')
    const lay = layout(p, 1) // tolerated exception: width 2 at width 1
    expect(lay.lines).toHaveLength(1)
    expect(lay.lines[0]!.width).toBe(2)
  })

  test('flag pairs are individual wide segments', () => {
    const p = prepare('🇺🇸🇫🇷')
    expect(p.segments.map((s) => s.width)).toEqual([2, 2])
    expect(lines('🇺🇸🇫🇷', 2)).toEqual(['🇺🇸', '🇫🇷'])
  })

  test('combining marks stay attached (NFC)', () => {
    const p = prepare('café naïve')
    expect(p.segments.map((s) => s.width)).toEqual([4, 1, 5])
    expect(lines('café naïve', 6)).toEqual(['café', 'naïve'])
  })

  test('combining marks stay attached (NFD)', () => {
    const text = 'café naïve'
    const p = prepare(text)
    expect(p.segments.map((s) => s.width)).toEqual([4, 1, 5])
    expect(lines(text, 5)).toEqual(['café', 'naïve'])
  })
})

describe('golden: over-wide word slicing', () => {
  test('13-cell word at width 5: three lines, exact slice ranges', () => {
    const p = prepare('abcdefghijklm')
    const lay = layout(p, 5)
    expect(lay.lines).toEqual([
      { placements: [{ segId: 0, col: 0, width: 5, slice: [0, 5] }], width: 5 },
      { placements: [{ segId: 0, col: 0, width: 5, slice: [5, 10] }], width: 5 },
      { placements: [{ segId: 0, col: 0, width: 3, slice: [10, 13] }], width: 3 },
    ])
    expect(renderLines(p, lay)).toEqual(['abcde', 'fghij', 'klm'])
  })

  test('13-cell word at width 4: four lines, exact slice ranges', () => {
    const p = prepare('abcdefghijklm')
    const lay = layout(p, 4)
    expect(lay.lines.map((l) => l.placements[0]!.slice)).toEqual([
      [0, 4],
      [4, 8],
      [8, 12],
      [12, 13],
    ])
  })

  test('over-wide word mid-text starts slicing on a fresh line', () => {
    expect(lines('ab cdefghij kl', 4)).toEqual(['ab', 'cdef', 'ghij', 'kl'])
  })

  test('text continues on the final slice line', () => {
    expect(lines('cdefgh ij', 5)).toEqual(['cdefg', 'h ij'])
  })
})

describe('golden: exact-fit boundaries', () => {
  test('word exactly fills the line', () => {
    const p = prepare('abcde')
    const lay = layout(p, 5)
    expect(lay.lines).toEqual([{ placements: [{ segId: 0, col: 0, width: 5 }], width: 5 }])
  })

  test('word + space + word exactly fills (space placed)', () => {
    const p = prepare('ab cd')
    const lay = layout(p, 5)
    expect(lay.lines).toEqual([
      {
        placements: [
          { segId: 0, col: 0, width: 2 },
          { segId: 1, col: 2, width: 1 },
          { segId: 2, col: 3, width: 2 },
        ],
        width: 5,
      },
    ])
  })

  test('content after an exact fit wraps, consuming the space', () => {
    expect(lines('ab cd ef', 5)).toEqual(['ab cd', 'ef'])
    expect(lines('abcde fg', 5)).toEqual(['abcde', 'fg'])
  })
})

describe('golden: empties, whitespace, hard breaks', () => {
  test('empty string: one empty line', () => {
    const p = prepare('')
    expect(p.segments).toHaveLength(0)
    expect(layout(p, 10).lines).toEqual([{ placements: [], width: 0 }])
  })

  test('whitespace-only: one empty line, spaces consumed', () => {
    expect(layout(prepare('   '), 10).lines).toEqual([{ placements: [], width: 0 }])
    expect(layout(prepare(' \t '), 10).lines).toEqual([{ placements: [], width: 0 }])
  })

  test('consecutive newlines preserve blank lines', () => {
    expect(lines('a\n\nb', 10)).toEqual(['a', '', 'b'])
    expect(lines('x\n\n\ny', 10)).toEqual(['x', '', '', 'y'])
    expect(lines('\n', 10)).toEqual(['', ''])
    expect(lines('a\n', 10)).toEqual(['a', ''])
  })

  test('CRLF is one break segment', () => {
    const p = prepare('a\r\nb')
    expect(p.segments[1]).toEqual({ id: 1, kind: 'break', text: '\r\n', width: 0 })
    expect(lines('a\r\nb', 10)).toEqual(['a', 'b'])
  })

  test('trailing space before a break is consumed', () => {
    const p = prepare('ab \ncd')
    const lay = layout(p, 10)
    expect(renderLines(p, lay)).toEqual(['ab', 'cd'])
    expect(lay.lines[0]!.width).toBe(2)
  })

  test('indentation after a hard break is preserved', () => {
    const p = prepare('ab\n  cd')
    const lay = layout(p, 10)
    expect(renderLines(p, lay)).toEqual(['ab', '  cd'])
    expect(lay.lines[1]!.placements[0]).toEqual({ segId: 2, col: 0, width: 2 })
  })

  test('NBSP is non-breaking glue', () => {
    const p = prepare('a b c')
    expect(p.segments[0]!.text).toBe('a b')
    expect(lines('a b c', 3)).toEqual(['a b', 'c'])
  })

  test('tab rides along at width 0', () => {
    const p = prepare('a\tb')
    const lay = layout(p, 10)
    expect(renderLines(p, lay)).toEqual(['a\tb'])
    expect(lay.lines[0]!.width).toBe(2)
  })
})
