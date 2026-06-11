/**
 * Cell grid (the back buffer) — Grid contract implementation.
 *
 * Wide graphemes occupy two cells: the head cell holds the grapheme, the
 * cell at col+1 holds '' (continuation). Overwriting either half of a wide
 * pair blanks the orphaned half with a space (its colors are kept).
 * Writes outside the grid are silently clipped; a wide grapheme whose
 * continuation would fall off the right edge is clipped entirely.
 */

import { ATTR_NONE, DEFAULT_COLOR, type Cell, type Color, type Grid } from './types'
import { cellWidth, graphemes } from '../shared/width'

export class CellGrid implements Grid {
  readonly cols: number
  readonly rows: number

  /** @internal flat row-major cell text; '' = continuation of a wide char. */
  chArr: string[]
  /** @internal */ fgArr: Int32Array
  /** @internal */ bgArr: Int32Array
  /** @internal */ attrArr: Uint8Array

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, cols | 0)
    this.rows = Math.max(0, rows | 0)
    const n = this.cols * this.rows
    this.chArr = new Array<string>(n).fill(' ')
    this.fgArr = new Int32Array(n).fill(DEFAULT_COLOR)
    this.bgArr = new Int32Array(n).fill(DEFAULT_COLOR)
    this.attrArr = new Uint8Array(n)
  }

  set(
    row: number,
    col: number,
    ch: string,
    fg: Color = DEFAULT_COLOR,
    bg: Color = DEFAULT_COLOR,
    attrs: number = ATTR_NONE,
  ): void {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return
    if (ch === '') return // continuation cells are managed internally
    const w = cellWidth(ch)
    if (w === 0) return // zero-width grapheme: no cell representation
    if (w === 2 && col + 1 >= this.cols) return // wide char would be cut: clip
    this.blankPartner(row, col)
    if (w === 2) this.blankPartner(row, col + 1)
    const i = row * this.cols + col
    this.chArr[i] = ch
    this.fgArr[i] = fg
    this.bgArr[i] = bg
    this.attrArr[i] = attrs
    if (w === 2) {
      const j = i + 1
      this.chArr[j] = ''
      this.fgArr[j] = fg
      this.bgArr[j] = bg
      this.attrArr[j] = attrs
    }
  }

  /**
   * If the cell at (row, col) is half of a wide pair, blank the OTHER half
   * with a space (keeping that cell's colors). The caller overwrites
   * (row, col) itself right after.
   */
  private blankPartner(row: number, col: number): void {
    const i = row * this.cols + col
    if (this.chArr[i] === '') {
      // Continuation: orphan the head at col-1 (always in-bounds by invariant).
      this.chArr[i - 1] = ' '
    } else if (col + 1 < this.cols && this.chArr[i + 1] === '') {
      // Wide head: orphan the continuation at col+1.
      this.chArr[i + 1] = ' '
    }
  }

  text(
    row: number,
    col: number,
    s: string,
    fg: Color = DEFAULT_COLOR,
    bg: Color = DEFAULT_COLOR,
    attrs: number = ATTR_NONE,
  ): number {
    if (row < 0 || row >= this.rows) return 0
    let c = col
    for (const g of graphemes(s)) {
      const w = cellWidth(g)
      if (w === 0) continue
      if (c + w > this.cols) break // clip at the right edge
      this.set(row, c, g, fg, bg, attrs) // negative c clips inside set()
      c += w
    }
    return c - col
  }

  fill(
    row: number,
    col: number,
    w: number,
    h: number,
    ch: string,
    fg: Color = DEFAULT_COLOR,
    bg: Color = DEFAULT_COLOR,
    attrs: number = ATTR_NONE,
  ): void {
    const step = ch === '' ? 0 : cellWidth(ch)
    if (step === 0) return
    for (let r = row; r < row + h; r++) {
      if (r < 0 || r >= this.rows) continue
      // A wide fill char that would spill past the rect is not written.
      for (let c = col; c + step <= col + w; c += step) {
        this.set(r, c, ch, fg, bg, attrs)
      }
    }
  }

  clear(): void {
    this.chArr.fill(' ')
    this.fgArr.fill(DEFAULT_COLOR)
    this.bgArr.fill(DEFAULT_COLOR)
    this.attrArr.fill(0)
  }

  get(row: number, col: number): Cell {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      return { ch: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: ATTR_NONE }
    }
    const i = row * this.cols + col
    return { ch: this.chArr[i]!, fg: this.fgArr[i]!, bg: this.bgArr[i]!, attrs: this.attrArr[i]! }
  }

  /** @internal Copy all cells from a same-sized grid (renderer back→front). */
  copyFrom(other: CellGrid): void {
    const n = this.cols * this.rows
    for (let i = 0; i < n; i++) this.chArr[i] = other.chArr[i]!
    this.fgArr.set(other.fgArr)
    this.bgArr.set(other.bgArr)
    this.attrArr.set(other.attrArr)
  }
}

/** Create a Grid (the game's drawing surface / renderer back buffer). */
export function createGrid(cols: number, rows: number): Grid {
  return new CellGrid(cols, rows)
}
