/**
 * Double-buffered diff renderer — pure core, returns the byte string.
 *
 * render(back) compares the back grid against the front buffer (what is
 * already on screen) row by row, finds dirty spans, and emits minimal
 * output: one cursor move per span plus an SGR state machine that only
 * emits changes. Every non-empty frame is wrapped in BSU/ESU (DEC 2026).
 * The first render, any render after invalidate(), and any render whose
 * grid dimensions changed repaint fully (SGR reset + clear + home, then
 * paint every non-blank cell).
 *
 * The Term wires this to the output stream; tests golden the strings.
 */

import { DEFAULT_COLOR, type Grid } from './types'
import { cellWidth, graphemes } from '../shared/width'
import {
  BSU,
  CLEAR_SCREEN,
  CURSOR_HOME,
  ESU,
  SGR_RESET,
  attrParams,
  bgParam,
  cursorTo,
  fgParam,
  sgr,
} from './ansi'
import { CellGrid } from './grid'

export class Renderer {
  private readonly truecolor: boolean
  private front: CellGrid | null = null
  private needsFull = true
  // SGR state machine — tracks what the terminal currently has applied.
  private curFg = DEFAULT_COLOR
  private curBg = DEFAULT_COLOR
  private curAttrs = 0

  constructor(truecolor: boolean) {
    this.truecolor = truecolor
  }

  /** Force the next render to repaint the full screen. */
  invalidate(): void {
    this.needsFull = true
  }

  /**
   * Diff `back` against the front buffer and return the ANSI bytes to
   * bring the screen up to date ('' when nothing changed). Updates the
   * front buffer to match `back`.
   */
  render(back: Grid): string {
    const b = back instanceof CellGrid ? back : materialize(back)
    if (!this.front || this.front.cols !== b.cols || this.front.rows !== b.rows) {
      this.front = new CellGrid(b.cols, b.rows)
      this.needsFull = true
    }
    const f = this.front
    let body = ''
    if (this.needsFull) {
      // Reset SGR, clear, home; then diff against an all-blank front so
      // only non-blank cells are painted (2J already blanked the screen).
      body += SGR_RESET + CLEAR_SCREEN + CURSOR_HOME
      this.curFg = DEFAULT_COLOR
      this.curBg = DEFAULT_COLOR
      this.curAttrs = 0
      f.clear()
    }

    const cols = b.cols
    const rows = b.rows
    for (let r = 0; r < rows; r++) {
      const base = r * cols
      let c = 0
      while (c < cols) {
        while (c < cols && !differs(f, b, base + c)) c++
        if (c >= cols) break
        let start = c
        // Never start a span on a continuation cell: include its head so
        // the wide grapheme is re-emitted whole.
        if (b.chArr[base + start] === '' && start > 0) start--
        let end = c
        while (end + 1 < cols && differs(f, b, base + end + 1)) end++
        body += cursorTo(r, start)
        for (let x = start; x <= end; x++) {
          const i = base + x
          const ch = b.chArr[i]!
          if (ch === '') continue // wide head already advanced the cursor
          body += this.sgrTransition(b.fgArr[i]!, b.bgArr[i]!, b.attrArr[i]!)
          body += ch
        }
        c = end + 1
      }
    }

    f.copyFrom(b)
    this.needsFull = false
    if (body === '') return ''
    return BSU + body + ESU
  }

  /** Emit only the SGR changes needed to move from current → target state. */
  private sgrTransition(fg: number, bg: number, attrs: number): string {
    if (fg === this.curFg && bg === this.curBg && attrs === this.curAttrs) return ''
    const params: Array<string | number> = []
    if (this.curAttrs & ~attrs) {
      // Some attribute must turn OFF → full reset, then re-apply.
      params.push(0)
      this.curFg = DEFAULT_COLOR
      this.curBg = DEFAULT_COLOR
      this.curAttrs = 0
    }
    for (const p of attrParams(attrs & ~this.curAttrs)) params.push(p)
    if (fg !== this.curFg) params.push(fgParam(fg, this.truecolor))
    if (bg !== this.curBg) params.push(bgParam(bg, this.truecolor))
    this.curFg = fg
    this.curBg = bg
    this.curAttrs = attrs
    return sgr(params)
  }
}

function differs(f: CellGrid, b: CellGrid, i: number): boolean {
  return (
    f.chArr[i] !== b.chArr[i] ||
    f.fgArr[i] !== b.fgArr[i] ||
    f.bgArr[i] !== b.bgArr[i] ||
    f.attrArr[i] !== b.attrArr[i]
  )
}

/**
 * Copy a foreign Grid implementation into a CellGrid via get(), enforcing
 * the cell-model invariants the diff loop's cursor arithmetic relies on:
 * - '' appears exactly under a wide head (orphan '' becomes ' ');
 * - a wide head is always followed by '' (the head wins over whatever the
 *   foreign grid reports at col+1; a head clipped at the right edge blanks);
 * - zero-width / control-char cells become ' ' (controls must never reach
 *   the output stream); multi-cluster strings keep their first grapheme.
 * Colors/attrs are taken from the foreign cell unchanged.
 */
function materialize(g: Grid): CellGrid {
  const out = new CellGrid(g.cols, g.rows)
  for (let r = 0; r < g.rows; r++) {
    let underHead = false // previous column was a wide head
    for (let c = 0; c < g.cols; c++) {
      const cell = g.get(r, c)
      const i = r * g.cols + c
      out.fgArr[i] = cell.fg
      out.bgArr[i] = cell.bg
      out.attrArr[i] = cell.attrs
      if (underHead) {
        out.chArr[i] = ''
        underHead = false
        continue
      }
      let ch = cell.ch
      if (ch.length > 1) ch = graphemes(ch)[0] ?? ' '
      if (ch === '' || cellWidth(ch) === 0) {
        ch = ' ' // orphan continuation / zero-width / control char
      } else if (cellWidth(ch) === 2) {
        if (c + 1 < g.cols) underHead = true
        else ch = ' ' // wide head clipped at the right edge
      }
      out.chArr[i] = ch
    }
  }
  return out
}
