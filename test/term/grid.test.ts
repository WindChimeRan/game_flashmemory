import { describe, expect, test } from 'bun:test'
import { CellGrid, createGrid } from '../../src/term/grid'
import { rgb } from '../../src/term/ansi'
import { ATTR_BOLD, ATTR_NONE, DEFAULT_COLOR } from '../../src/term/types'

function rowText(g: CellGrid, row: number): string[] {
  const out: string[] = []
  for (let c = 0; c < g.cols; c++) out.push(g.get(row, c).ch)
  return out
}

describe('basic cells', () => {
  test('starts blank', () => {
    const g = new CellGrid(3, 2)
    expect(g.get(0, 0)).toEqual({ ch: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: ATTR_NONE })
  })

  test('set/get roundtrip with colors and attrs', () => {
    const g = new CellGrid(3, 2)
    g.set(1, 2, 'x', rgb(1, 2, 3), 17, ATTR_BOLD)
    expect(g.get(1, 2)).toEqual({ ch: 'x', fg: rgb(1, 2, 3), bg: 17, attrs: ATTR_BOLD })
  })

  test('out-of-bounds writes are clipped, reads return blank', () => {
    const g = new CellGrid(2, 2)
    g.set(-1, 0, 'a')
    g.set(0, -1, 'a')
    g.set(2, 0, 'a')
    g.set(0, 2, 'a')
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) expect(g.get(r, c).ch).toBe(' ')
    expect(g.get(9, 9).ch).toBe(' ')
    expect(g.get(-1, 0).ch).toBe(' ')
  })

  test("set with '' or a zero-width grapheme is a no-op", () => {
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'a')
    g.set(0, 0, '')
    expect(g.get(0, 0).ch).toBe('a')
    g.set(0, 0, '́') // standalone combining mark
    expect(g.get(0, 0).ch).toBe('a')
  })

  test('clear resets everything', () => {
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'a', 1, 2, ATTR_BOLD)
    g.clear()
    expect(g.get(0, 0)).toEqual({ ch: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: ATTR_NONE })
  })
})

describe('wide graphemes', () => {
  test('wide char writes head + continuation cell', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字', 3, 4, ATTR_BOLD)
    expect(g.get(0, 0).ch).toBe('字')
    expect(g.get(0, 1)).toEqual({ ch: '', fg: 3, bg: 4, attrs: ATTR_BOLD })
    expect(g.get(0, 2).ch).toBe(' ')
  })

  test('overwriting the head blanks the orphan continuation', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字', 3, 4)
    g.set(0, 0, 'A')
    expect(rowText(g, 0)).toEqual(['A', ' ', ' ', ' '])
    // orphan keeps its colors
    expect(g.get(0, 1).fg).toBe(3)
    expect(g.get(0, 1).bg).toBe(4)
  })

  test('overwriting the continuation blanks the orphan head', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字', 3, 4)
    g.set(0, 1, 'B')
    expect(rowText(g, 0)).toEqual([' ', 'B', ' ', ' '])
    expect(g.get(0, 0).fg).toBe(3) // orphan head keeps colors
  })

  test('wide over wide, shifted by one', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字')
    g.set(0, 1, '本')
    expect(rowText(g, 0)).toEqual([' ', '本', '', ' '])
  })

  test('wide write whose continuation lands on another head orphans it', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 2, '字') // head at 2, cont at 3
    g.set(0, 1, '本') // cont lands on 字's head
    expect(rowText(g, 0)).toEqual([' ', '本', '', ' '])
  })

  test('same wide char twice is stable', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字')
    g.set(0, 0, '字')
    expect(rowText(g, 0)).toEqual(['字', '', ' ', ' '])
  })

  test('wide char at the last column is clipped entirely', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 3, '字')
    expect(rowText(g, 0)).toEqual([' ', ' ', ' ', ' '])
  })

  test('emoji ZWJ sequence is one wide cluster', () => {
    const g = new CellGrid(4, 1)
    g.set(0, 0, '👩‍👩‍👧')
    expect(g.get(0, 0).ch).toBe('👩‍👩‍👧')
    expect(g.get(0, 1).ch).toBe('')
    expect(g.get(0, 2).ch).toBe(' ')
  })
})

describe('text()', () => {
  test('writes a run and returns cells advanced', () => {
    const g = new CellGrid(8, 1)
    expect(g.text(0, 1, 'abc', 7)).toBe(3)
    expect(rowText(g, 0)).toEqual([' ', 'a', 'b', 'c', ' ', ' ', ' ', ' '])
    expect(g.get(0, 1).fg).toBe(7)
  })

  test('mixed narrow/wide advances by cell width', () => {
    const g = new CellGrid(8, 1)
    expect(g.text(0, 0, 'a字b')).toBe(4)
    expect(rowText(g, 0)).toEqual(['a', '字', '', 'b', ' ', ' ', ' ', ' '])
  })

  test('combining mark stays in its base cluster (one cell)', () => {
    const g = new CellGrid(4, 1)
    expect(g.text(0, 0, 'éx')).toBe(2)
    expect(g.get(0, 0).ch).toBe('é')
    expect(g.get(0, 1).ch).toBe('x')
  })

  test('clips at the right edge; half-fitting wide char is dropped', () => {
    const g = new CellGrid(3, 1)
    expect(g.text(0, 0, 'ab字')).toBe(2)
    expect(rowText(g, 0)).toEqual(['a', 'b', ' '])
  })

  test('row out of range writes nothing', () => {
    const g = new CellGrid(3, 1)
    expect(g.text(1, 0, 'ab')).toBe(0)
    expect(g.text(-1, 0, 'ab')).toBe(0)
  })

  test('negative start column clips but keeps advancing', () => {
    const g = new CellGrid(4, 1)
    expect(g.text(0, -2, 'abcd')).toBe(4)
    expect(rowText(g, 0)).toEqual(['c', 'd', ' ', ' '])
  })
})

describe('fill()', () => {
  test('fills a rect and clips at edges', () => {
    const g = new CellGrid(4, 3)
    g.fill(1, 1, 5, 5, '#', 2)
    expect(rowText(g, 0)).toEqual([' ', ' ', ' ', ' '])
    expect(rowText(g, 1)).toEqual([' ', '#', '#', '#'])
    expect(rowText(g, 2)).toEqual([' ', '#', '#', '#'])
    expect(g.get(1, 1).fg).toBe(2)
  })

  test('wide fill advances by two and never spills past the rect', () => {
    const g = new CellGrid(6, 1)
    g.fill(0, 0, 5, 1, '字')
    // two 字 fit in width 5; the 5th column is left untouched
    expect(rowText(g, 0)).toEqual(['字', '', '字', '', ' ', ' '])
  })

  test('zero/negative extents are no-ops', () => {
    const g = new CellGrid(3, 2)
    g.fill(0, 0, 0, 2, '#')
    g.fill(0, 0, 2, -1, '#')
    expect(rowText(g, 0)).toEqual([' ', ' ', ' '])
  })
})

describe('factory', () => {
  test('createGrid returns a working Grid', () => {
    const g = createGrid(2, 2)
    g.text(0, 0, 'hi')
    expect(g.get(0, 1).ch).toBe('i')
    expect(g.cols).toBe(2)
    expect(g.rows).toBe(2)
  })
})
