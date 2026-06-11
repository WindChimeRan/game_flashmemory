import { describe, expect, test } from 'bun:test'
import { CellGrid } from '../../src/term/grid'
import { Renderer } from '../../src/term/renderer'
import { rgb } from '../../src/term/ansi'
import { ATTR_BOLD, ATTR_UNDERLINE, DEFAULT_COLOR, type Cell, type Grid } from '../../src/term/types'

const FULL = '\x1b[0m\x1b[2J\x1b[H' // full-repaint prelude
const BSU = '\x1b[?2026h'
const ESU = '\x1b[?2026l'

describe('full repaint', () => {
  test('first render: exact bytes for a single red cell', () => {
    const r = new Renderer(true)
    const g = new CellGrid(3, 2)
    g.set(0, 0, 'A', rgb(255, 0, 0))
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[38;2;255;0;0mA${ESU}`)
  })

  test('blank cells are not painted (2J already blanked them)', () => {
    const r = new Renderer(true)
    const g = new CellGrid(80, 24)
    expect(r.render(g)).toBe(`${BSU}${FULL}${ESU}`)
  })

  test('full-repaint shape: per-row spans, skipping blank runs', () => {
    const r = new Renderer(true)
    const g = new CellGrid(5, 2)
    g.text(0, 0, 'ab')
    g.text(1, 3, 'cd')
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1Hab\x1b[2;4Hcd${ESU}`)
  })

  test('invalidate() forces a full repaint of unchanged content', () => {
    const r = new Renderer(true)
    const g = new CellGrid(3, 1)
    g.set(0, 0, 'x')
    r.render(g)
    expect(r.render(g)).toBe('')
    r.invalidate()
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1Hx${ESU}`)
  })

  test('dimension change forces a full repaint', () => {
    const r = new Renderer(true)
    const a = new CellGrid(2, 1)
    a.set(0, 0, 'x')
    r.render(a)
    const b = new CellGrid(3, 1)
    b.set(0, 0, 'x')
    expect(r.render(b)).toBe(`${BSU}${FULL}\x1b[1;1Hx${ESU}`)
  })
})

describe('diff frames', () => {
  test('no change → empty string (no BSU/ESU)', () => {
    const r = new Renderer(true)
    const g = new CellGrid(4, 4)
    g.text(0, 0, 'hi')
    r.render(g)
    expect(r.render(g)).toBe('')
  })

  test('single cell change → exact expected bytes', () => {
    const r = new Renderer(true)
    const g = new CellGrid(3, 2)
    g.set(0, 0, 'A', rgb(255, 0, 0))
    r.render(g)
    g.set(1, 1, 'B') // default colors; tracker currently red
    expect(r.render(g)).toBe(`${BSU}\x1b[2;2H\x1b[39mB${ESU}`)
  })

  test('SGR batching: one SGR covers a run of same-styled cells', () => {
    const r = new Renderer(true)
    const g = new CellGrid(4, 1)
    g.text(0, 0, 'AB', rgb(0, 0, 255))
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[38;2;0;0;255mAB${ESU}`)
    g.text(0, 0, 'CD', rgb(0, 0, 255))
    // same style → no SGR at all in the diff frame
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1HCD${ESU}`)
  })

  test('SGR state persists across frames', () => {
    const r = new Renderer(true)
    const g = new CellGrid(3, 1)
    g.set(0, 0, 'a', rgb(255, 0, 0))
    r.render(g)
    g.set(0, 1, 'b', rgb(255, 0, 0))
    expect(r.render(g)).toBe(`${BSU}\x1b[1;2Hb${ESU}`)
  })

  test('two separate dirty spans → two cursor moves', () => {
    const r = new Renderer(true)
    const g = new CellGrid(5, 1)
    r.render(g)
    g.set(0, 0, 'a')
    g.set(0, 4, 'b')
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1Ha\x1b[1;5Hb${ESU}`)
  })

  test('attribute removal goes through a reset', () => {
    const r = new Renderer(true)
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'A', DEFAULT_COLOR, DEFAULT_COLOR, ATTR_BOLD)
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[1mA${ESU}`)
    g.set(0, 0, 'A') // bold off
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1H\x1b[0mA${ESU}`)
  })

  test('attribute addition is incremental (no reset)', () => {
    const r = new Renderer(true)
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'A', DEFAULT_COLOR, DEFAULT_COLOR, ATTR_BOLD)
    r.render(g)
    g.set(0, 0, 'A', DEFAULT_COLOR, DEFAULT_COLOR, ATTR_BOLD | ATTR_UNDERLINE)
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1H\x1b[4mA${ESU}`)
  })

  test('background color changes are emitted', () => {
    const r = new Renderer(true)
    const g = new CellGrid(2, 1)
    g.set(0, 0, ' ', DEFAULT_COLOR, rgb(0, 0, 0))
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[48;2;0;0;0m ${ESU}`)
  })
})

describe('wide characters', () => {
  test('wide grapheme emitted once; continuation advances the cursor', () => {
    const r = new Renderer(true)
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字')
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H字${ESU}`)
  })

  test('overwriting half a wide char repaints head + blanked orphan', () => {
    const r = new Renderer(true)
    const g = new CellGrid(4, 1)
    g.set(0, 0, '字')
    r.render(g)
    g.set(0, 0, 'X') // grid blanks the orphan continuation
    expect(r.render(g)).toBe(`${BSU}\x1b[1;1HX ${ESU}`)
  })

  test('text after a wide char lands at the right columns', () => {
    const r = new Renderer(true)
    const g = new CellGrid(6, 1)
    g.text(0, 0, 'a字b')
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1Ha字b${ESU}`)
  })
})

describe('color downconversion', () => {
  test('truecolor quantized to 256 when unsupported', () => {
    const r = new Renderer(false)
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'R', rgb(255, 0, 0))
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[38;5;196mR${ESU}`)
  })

  test('palette indices pass through unchanged', () => {
    const r = new Renderer(false)
    const g = new CellGrid(2, 1)
    g.set(0, 0, 'P', 42)
    expect(r.render(g)).toBe(`${BSU}${FULL}\x1b[1;1H\x1b[38;5;42mP${ESU}`)
  })
})

describe('foreign Grid implementations', () => {
  test('a non-CellGrid Grid is materialized via get()', () => {
    const cells = new Map<string, Cell>()
    cells.set('0,1', { ch: 'z', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 })
    const fake: Grid = {
      cols: 3,
      rows: 1,
      set() {},
      text: () => 0,
      fill() {},
      clear() {},
      get(row, col) {
        return (
          cells.get(`${row},${col}`) ?? { ch: ' ', fg: DEFAULT_COLOR, bg: DEFAULT_COLOR, attrs: 0 }
        )
      },
    }
    const r = new Renderer(true)
    expect(r.render(fake)).toBe(`${BSU}${FULL}\x1b[1;2Hz${ESU}`)
  })
})
