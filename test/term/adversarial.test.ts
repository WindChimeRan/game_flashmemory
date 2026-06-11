/**
 * Adversarial verification suite — attacks on documented invariants.
 *
 * Each test either pins a bug fix (foreign-grid cell-model sanitization,
 * SGR-mouse high buttons, write-throw desync, flush-outside-session,
 * stale backpressure across restart) or pins a behavior that was attacked
 * and found correct (SGR reset re-applying colors, trailing-cell clears,
 * span-ends-on-wide-head diffs, pathological input splits).
 */
import { describe, expect, test } from 'bun:test'
import { CellGrid } from '../../src/term/grid'
import { Renderer } from '../../src/term/renderer'
import { AnsiParser } from '../../src/term/input'
import { TermImpl } from '../../src/term/term'
import { rgb } from '../../src/term/ansi'
import { ATTR_BOLD, DEFAULT_COLOR, type Cell, type Grid } from '../../src/term/types'

const FULL = '\x1b[0m\x1b[2J\x1b[H'
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

/** Foreign (non-CellGrid) Grid backed by a row of cell texts. */
function foreignRow(chs: string[]): Grid {
  return {
    cols: chs.length,
    rows: 1,
    set() {},
    text: () => 0,
    fill() {},
    clear() {},
    get(_row, col): Cell {
      return { ch: chs[col] ?? ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 }
    },
  }
}

describe('foreign grids violating the cell model are sanitized', () => {
  test("orphan '' continuation must not shift the rest of the row left", () => {
    // A '' with no wide head before it: emitting nothing for it while the
    // span cursor math counts a column would desync screen vs front buffer.
    const r = new Renderer(true)
    const out = r.render(foreignRow(['', 'x', 'y']))
    // '' becomes a blank cell; x and y stay at columns 1 and 2.
    expect(out).toBe(`${BSU}${FULL}\x1b[1;2Hxy${ESU}`)
  })

  test("wide head not followed by '' must not push later cells right", () => {
    // Emitting 字 then x consecutively would put x at column 2 while the
    // model says column 1. The head wins; the contradictory cell is dropped.
    const r = new Renderer(true)
    const out = r.render(foreignRow(['字', 'x', ' ']))
    expect(out).toBe(`${BSU}${FULL}\x1b[1;1H字${ESU}`)
  })

  test('control chars and zero-width cells never reach the output stream', () => {
    const r = new Renderer(true)
    const out = r.render(foreignRow(['\x07', '́'])) // BEL + bare combining mark
    expect(out).not.toContain('\x07')
    expect(out).not.toContain('́')
    expect(out).toBe(`${BSU}${FULL}${ESU}`) // both blanked
  })

  test('multi-cluster cell text keeps only its first grapheme', () => {
    const r = new Renderer(true)
    const out = r.render(foreignRow(['ab', ' ']))
    expect(out).toBe(`${BSU}${FULL}\x1b[1;1Ha${ESU}`)
  })

  test('wide head reported at the last column is blanked, not half-painted', () => {
    const r = new Renderer(true)
    const out = r.render(foreignRow(['x', '字']))
    expect(out).toBe(`${BSU}${FULL}\x1b[1;1Hx${ESU}`)
  })
})

describe('renderer attacks that must stay correct', () => {
  test('attr removal re-applies the still-wanted color after the reset', () => {
    // The SGR reset (0) also resets colors; a stale-state bug here would
    // leave the cell at terminal-default fg instead of red.
    const r = new Renderer(true)
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'A', rgb(255, 0, 0), DEFAULT_COLOR, ATTR_BOLD)
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[1;38;2;255;0;0mA${ESU}`)
    g.set(0, 0, 'A', rgb(255, 0, 0)) // bold off, SAME red fg
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1H\x1b[0;38;2;255;0;0mA${ESU}`)
  })

  test('row shrink: trailing cells of the longer old text are cleared', () => {
    const r = new Renderer(true)
    const g = new CellGrid(5, 1)
    g.text(0, 0, 'hello')
    r.render(g)
    g.clear()
    g.text(0, 0, 'hi')
    // h matches; e→i plus three trailing blanks must be repainted.
    expect(r.render(g)).toBe(`${BSU}\x1b[1;2Hi   ${ESU}`)
  })

  test('wide-over-wide diff where only the head cell differs', () => {
    // Continuation cells match (same '' + colors), so the span ends ON the
    // head; the wide grapheme must still be re-emitted whole.
    const r = new Renderer(true)
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字')
    r.render(g)
    g.set(0, 0, '本')
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1H本${ESU}`)
  })
})

describe('input parser attacks', () => {
  test('SGR mouse buttons 8-11 (bit 7) are swallowed, not left-clicks', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[<128;1;1M')).toEqual([]) // button 8 press
    expect(p.feed('\x1b[<129;3;3M')).toEqual([]) // button 9 press
    expect(p.feed('\x1b[<130;3;3m')).toEqual([]) // button 10 release
    // parser state intact afterwards
    expect(p.feed('\x1b[<0;1;1M')).toEqual([
      { kind: 'mouse', action: 'press', button: 0, col: 0, row: 0 },
    ])
  })

  test('drag with ctrl modifier bits still decodes (bits masked)', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[<48;5;6M')).toEqual([
      { kind: 'mouse', action: 'drag', button: 0, col: 4, row: 5 },
    ])
  })

  test('CSI delivered one byte per feed() still parses as one key', () => {
    const p = new AnsiParser()
    const out = []
    for (const byte of ['\x1b', '[', '1', ';', '5', 'A']) out.push(...p.feed(byte))
    expect(out).toEqual([
      { kind: 'key', name: 'up', ctrl: true, alt: false, shift: false, seq: '\x1b[1;5A' },
    ])
  })

  test('paste chunk ending with 5 of the 6 terminator bytes', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[200~abc\x1b[201')).toEqual([])
    expect(p.feed('~')).toEqual([{ kind: 'paste', text: 'abc' }])
  })

  test('paste body byte that is a terminator-prefix false alarm is kept', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[200~end\x1b')).toEqual([]) // trailing ESC held as prefix
    expect(p.feed('zz\x1b[201~')).toEqual([{ kind: 'paste', text: 'end\x1bzz' }])
  })
})

// ── Term lifecycle / backpressure fakes ───────────────────────────────

class FakeOutput {
  chunks: string[] = []
  columns = 10
  rows = 3
  nextOk = true
  throwNext = false
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()

  write(s: string): boolean {
    if (this.throwNext) {
      this.throwNext = false
      throw new Error('EPIPE')
    }
    this.chunks.push(s)
    return this.nextOk
  }
  on(ev: string, fn: (...a: unknown[]) => void): void {
    const list = this.handlers.get(ev) ?? []
    list.push(fn)
    this.handlers.set(ev, list)
  }
  off(ev: string, fn: (...a: unknown[]) => void): void {
    const list = this.handlers.get(ev) ?? []
    const i = list.indexOf(fn)
    if (i >= 0) list.splice(i, 1)
  }
  once(ev: string, fn: (...a: unknown[]) => void): void {
    const wrapped = (...a: unknown[]) => {
      this.off(ev, wrapped)
      fn(...a)
    }
    this.on(ev, wrapped)
  }
  emit(ev: string): void {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) fn()
  }
}

class FakeInput {
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  on(): void {}
  off(): void {}
}

function makeTerm() {
  const output = new FakeOutput()
  const term = new TermImpl({ input: new FakeInput() as never, output: output as never })
  return { term, output }
}

describe('term session attacks', () => {
  test('a throwing write invalidates: the next flush repaints fully', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      output.chunks = []
      const g = new CellGrid(4, 1)
      g.text(0, 0, 'hi')
      output.throwNext = true
      term.flush(g) // bytes rendered, write throws, screen never got them
      expect(output.chunks).toHaveLength(0)
      term.flush(g) // must NOT diff to '' against the lying front buffer
      expect(output.chunks).toEqual([`${BSU}${FULL}\x1b[1;1Hhi${ESU}`])
    } finally {
      term.stop()
    }
  })

  test('flush before start() and after stop() writes nothing', () => {
    const { term, output } = makeTerm()
    const g = new CellGrid(4, 1)
    g.text(0, 0, 'oops')
    term.flush(g) // never started
    expect(output.chunks).toHaveLength(0)
    expect(term.droppedFrames).toBe(0)

    term.start()
    term.stop()
    output.chunks = []
    term.flush(g) // stopped: must not paint over the restored shell
    expect(output.chunks).toHaveLength(0)
    expect(term.droppedFrames).toBe(0)
  })

  test('stale pending write does not drop the first frame after restart', () => {
    const { term, output } = makeTerm()
    term.start()
    const g = new CellGrid(4, 1)
    g.text(0, 0, 'a')
    output.nextOk = false
    term.flush(g) // write accepted but unflushed -> pending
    expect(output.chunks.length).toBeGreaterThan(0)
    term.stop() // drain never fires

    output.nextOk = true
    term.start()
    output.chunks = []
    term.flush(g)
    expect(output.chunks).toEqual([`${BSU}${FULL}\x1b[1;1Ha${ESU}`])
    expect(term.droppedFrames).toBe(0)
    term.stop()
  })
})
