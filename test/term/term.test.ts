import { describe, expect, test } from 'bun:test'
import { createTerm, detectTruecolor, TermImpl } from '../../src/term/term'
import { CellGrid } from '../../src/term/grid'
import type { InputEvent } from '../../src/term/types'

// ── fakes ─────────────────────────────────────────────────────────────

class FakeOutput {
  chunks: string[] = []
  columns = 20
  rows = 6
  nextOk = true
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()

  write(s: string): boolean {
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
  get all(): string {
    return this.chunks.join('')
  }
}

class FakeInput {
  rawCalls: boolean[] = []
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>()

  setRawMode(v: boolean): void {
    this.rawCalls.push(v)
  }
  resume(): void {}
  pause(): void {}
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
  emitData(s: string): void {
    for (const fn of [...(this.handlers.get('data') ?? [])]) fn(Buffer.from(s, 'latin1'))
  }
  listenerCount(ev: string): number {
    return (this.handlers.get(ev) ?? []).length
  }
}

function makeTerm(opts: { mouse?: boolean } = {}) {
  const input = new FakeInput()
  const output = new FakeOutput()
  const term = new TermImpl({
    mouse: opts.mouse,
    input: input as never,
    output: output as never,
  })
  return { term, input, output }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ENTER = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l\x1b[?1004h\x1b[?2004h'
const ENTER_MOUSE = ENTER + '\x1b[?1000;1002;1006h'
const EXIT = '\x1b[?2026l\x1b[?2004l\x1b[?1004l\x1b[0m\x1b[?25h\x1b[?1049l'
const EXIT_MOUSE = '\x1b[?2026l\x1b[?1006;1002;1000l\x1b[?2004l\x1b[?1004l\x1b[0m\x1b[?25h\x1b[?1049l'

// ── lifecycle ─────────────────────────────────────────────────────────

describe('lifecycle', () => {
  test('start emits alt screen → clear → cursor hide → modes on, in order', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      expect(output.all).toBe(ENTER)
    } finally {
      term.stop()
    }
  })

  test('start with mouse appends mouse modes', () => {
    const { term, output } = makeTerm({ mouse: true })
    term.start()
    try {
      expect(output.all).toBe(ENTER_MOUSE)
    } finally {
      term.stop()
    }
  })

  test('stop restores everything in reverse order', () => {
    const { term, output } = makeTerm()
    term.start()
    output.chunks = []
    term.stop()
    expect(output.all).toBe(EXIT)
  })

  test('stop with mouse turns mouse off first (after ESU)', () => {
    const { term, output } = makeTerm({ mouse: true })
    term.start()
    output.chunks = []
    term.stop()
    expect(output.all).toBe(EXIT_MOUSE)
  })

  test('raw mode toggled on at start, off at stop', () => {
    const { term, input } = makeTerm()
    term.start()
    expect(input.rawCalls).toEqual([true])
    term.stop()
    expect(input.rawCalls).toEqual([true, false])
  })

  test('restore is idempotent: double stop writes the exit sequence once', () => {
    const { term, output } = makeTerm()
    term.start()
    output.chunks = []
    term.stop()
    term.stop()
    expect(output.all).toBe(EXIT)
  })

  test('start is idempotent while started', () => {
    const { term, output } = makeTerm()
    term.start()
    term.start()
    try {
      expect(output.all).toBe(ENTER)
    } finally {
      term.stop()
    }
  })

  test('start/stop cycles work repeatedly', () => {
    const { term, output } = makeTerm()
    term.start()
    term.stop()
    output.chunks = []
    term.start()
    term.stop()
    expect(output.all).toBe(ENTER + EXIT)
  })

  test('process signal/exit handlers are registered and removed', () => {
    const before = {
      winch: process.listenerCount('SIGWINCH'),
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
      exit: process.listenerCount('exit'),
      unc: process.listenerCount('uncaughtException'),
    }
    const { term, input } = makeTerm()
    term.start()
    expect(process.listenerCount('SIGWINCH')).toBe(before.winch + 1)
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1)
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1)
    expect(process.listenerCount('exit')).toBe(before.exit + 1)
    expect(process.listenerCount('uncaughtException')).toBe(before.unc + 1)
    expect(input.listenerCount('data')).toBe(1)
    term.stop()
    expect(process.listenerCount('SIGWINCH')).toBe(before.winch)
    expect(process.listenerCount('SIGINT')).toBe(before.int)
    expect(process.listenerCount('SIGTERM')).toBe(before.term)
    expect(process.listenerCount('exit')).toBe(before.exit)
    expect(process.listenerCount('uncaughtException')).toBe(before.unc)
    expect(input.listenerCount('data')).toBe(0)
  })
})

// ── input wiring ──────────────────────────────────────────────────────

describe('input wiring', () => {
  test('bytes from the input stream become events', () => {
    const { term, input } = makeTerm()
    const events: InputEvent[] = []
    term.onInput((e) => events.push(e))
    term.start()
    try {
      input.emitData('\x1b[A')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'key', name: 'up' })
    } finally {
      term.stop()
    }
  })

  test('onInput returns a working unsubscribe', () => {
    const { term, input } = makeTerm()
    const events: InputEvent[] = []
    const off = term.onInput((e) => events.push(e))
    term.start()
    try {
      off()
      input.emitData('x')
      expect(events).toHaveLength(0)
    } finally {
      term.stop()
    }
  })

  test('bare ESC is flushed as escape after the hold timer', async () => {
    const { term, input } = makeTerm()
    const events: InputEvent[] = []
    term.onInput((e) => events.push(e))
    term.start()
    try {
      input.emitData('\x1b')
      expect(events).toHaveLength(0)
      await sleep(60)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'key', name: 'escape' })
    } finally {
      term.stop()
    }
  })

  test('the hold timer is cancelled when the sequence completes', async () => {
    const { term, input } = makeTerm()
    const events: InputEvent[] = []
    term.onInput((e) => events.push(e))
    term.start()
    try {
      input.emitData('\x1b')
      input.emitData('[A')
      await sleep(60)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ kind: 'key', name: 'up' })
    } finally {
      term.stop()
    }
  })
})

// ── resize ────────────────────────────────────────────────────────────

describe('resize', () => {
  test('SIGWINCH → ResizeEvent + dims update + full repaint', () => {
    const { term, input: _input, output } = makeTerm()
    const events: InputEvent[] = []
    term.onInput((e) => events.push(e))
    term.start()
    try {
      const grid = new CellGrid(4, 2)
      grid.text(0, 0, 'hi')
      term.flush(grid)
      output.chunks = []
      term.flush(grid)
      expect(output.all).toBe('') // stable frame: nothing to write

      output.columns = 30
      output.rows = 8
      ;(process as unknown as { emit(ev: string): boolean }).emit('SIGWINCH')
      expect(events.at(-1)).toEqual({ kind: 'resize', cols: 30, rows: 8 })
      expect(term.cols).toBe(30)
      expect(term.rows).toBe(8)

      term.flush(grid)
      expect(output.all.startsWith('\x1b[?2026h\x1b[0m\x1b[2J\x1b[H')).toBe(true)
    } finally {
      term.stop()
    }
  })

  test('initial dims come from the output stream', () => {
    const { term } = makeTerm()
    expect(term.cols).toBe(20)
    expect(term.rows).toBe(6)
  })
})

// ── flush & backpressure ──────────────────────────────────────────────

describe('flush and backpressure', () => {
  test('first flush is a BSU/ESU-wrapped full repaint', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      output.chunks = []
      const grid = new CellGrid(4, 2)
      grid.text(0, 0, 'ok')
      term.flush(grid)
      expect(output.all).toBe('\x1b[?2026h\x1b[0m\x1b[2J\x1b[H\x1b[1;1Hok\x1b[?2026l')
    } finally {
      term.stop()
    }
  })

  test('unchanged frame writes nothing', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      const grid = new CellGrid(4, 2)
      term.flush(grid)
      output.chunks = []
      term.flush(grid)
      expect(output.chunks).toHaveLength(0)
    } finally {
      term.stop()
    }
  })

  test('invalidate() forces the next flush to repaint fully', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      const grid = new CellGrid(4, 2)
      grid.text(0, 0, 'aa')
      term.flush(grid)
      output.chunks = []
      term.invalidate()
      term.flush(grid)
      expect(output.all).toBe('\x1b[?2026h\x1b[0m\x1b[2J\x1b[H\x1b[1;1Haa\x1b[?2026l')
    } finally {
      term.stop()
    }
  })

  test('frames are DROPPED while a write is pending, then resume on drain', () => {
    const { term, output } = makeTerm()
    term.start()
    try {
      output.chunks = []
      output.nextOk = false // simulate a slow pipe
      const grid = new CellGrid(4, 1)
      grid.text(0, 0, 'a')
      term.flush(grid)
      expect(output.chunks).toHaveLength(1) // frame written, drain pending
      expect(term.droppedFrames).toBe(0)

      grid.text(0, 0, 'b')
      term.flush(grid)
      term.flush(grid)
      expect(output.chunks).toHaveLength(1) // both dropped
      expect(term.droppedFrames).toBe(2)

      output.nextOk = true
      output.emit('drain')
      term.flush(grid)
      expect(output.chunks).toHaveLength(2) // diff frame went out
      expect(output.chunks[1]).toBe('\x1b[?2026h\x1b[1;1Hb\x1b[?2026l')
      expect(term.droppedFrames).toBe(2)
    } finally {
      term.stop()
    }
  })
})

// ── truecolor detection ───────────────────────────────────────────────

describe('truecolor detection', () => {
  test('detectTruecolor reads COLORTERM and TERM', () => {
    expect(detectTruecolor({ COLORTERM: 'truecolor' })).toBe(true)
    expect(detectTruecolor({ COLORTERM: '24bit' })).toBe(true)
    expect(detectTruecolor({ TERM: 'xterm-direct' })).toBe(true)
    expect(detectTruecolor({ TERM: 'xterm-kitty' })).toBe(true)
    expect(detectTruecolor({ TERM: 'xterm-256color' })).toBe(false)
    expect(detectTruecolor({})).toBe(false)
  })

  test('Term picks up the environment at construction', () => {
    const saved = { ct: process.env.COLORTERM, term: process.env.TERM }
    try {
      process.env.COLORTERM = 'truecolor'
      expect(makeTerm().term.supportsTruecolor).toBe(true)
      delete process.env.COLORTERM
      process.env.TERM = 'xterm-256color'
      expect(makeTerm().term.supportsTruecolor).toBe(false)
    } finally {
      if (saved.ct === undefined) delete process.env.COLORTERM
      else process.env.COLORTERM = saved.ct
      if (saved.term === undefined) delete process.env.TERM
      else process.env.TERM = saved.term
    }
  })
})

describe('factory', () => {
  test('createTerm returns a Term', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    const term = createTerm({ input: input as never, output: output as never })
    expect(term.droppedFrames).toBe(0)
    expect(typeof term.start).toBe('function')
  })
})
