/**
 * Term — raw-mode terminal session with crash-safe restore.
 *
 * Lifecycle (D5): start() = raw mode, alt screen (1049) → clear → cursor
 * hide → focus (1004) → bracketed paste (2004) → mouse (1000+1002+1006,
 * opt-in). stop() restores everything in reverse order. The restore is
 * also registered for exit/SIGINT/SIGTERM/uncaughtException and is
 * idempotent, so a crash mid-frame still leaves the shell usable.
 *
 * Backpressure: if the previous write has not drained, flush() DROPS the
 * frame (droppedFrames counts them) — never more than one frame deep.
 * Dropped frames don't touch the renderer's front buffer, so the next
 * successful flush diffs against what is actually on screen.
 */

import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  CURSOR_HOME,
  CURSOR_SHOW,
  ESU,
  FOCUS_OFF,
  FOCUS_ON,
  MOUSE_OFF,
  MOUSE_ON,
  PASTE_OFF,
  PASTE_ON,
  SGR_RESET,
} from './ansi'
import { AnsiParser } from './input'
import { Renderer } from './renderer'
import type { Grid, InputEvent, Term, TermOptions } from './types'

/** How long a bare ESC is held before being flushed as the escape key. */
const ESC_FLUSH_MS = 30

interface InLike {
  on: Function
  off: Function
  setRawMode?: (raw: boolean) => unknown
  resume?: () => unknown
  pause?: () => unknown
}

interface OutLike {
  write(s: string): boolean
  on?: Function
  off?: Function
  once?: Function
  columns?: number
  rows?: number
}

/** Truecolor detection from the environment (COLORTERM, TERM). */
export function detectTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  const colorterm = (env.COLORTERM ?? '').toLowerCase()
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return true
  const term = (env.TERM ?? '').toLowerCase()
  return term.includes('direct') || term === 'xterm-kitty'
}

export class TermImpl implements Term {
  private readonly input: InLike
  private readonly output: OutLike
  private readonly mouse: boolean
  private readonly truecolor: boolean
  private readonly renderer: Renderer
  private readonly parser = new AnsiParser()
  private readonly subs = new Set<(e: InputEvent) => void>()

  private _cols = 80
  private _rows = 24
  private _droppedFrames = 0
  private started = false
  private active = false // entered the alt screen and not yet restored
  private writePending = false
  private escTimer: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TermOptions = {}) {
    this.input = (opts.input ?? process.stdin) as unknown as InLike
    this.output = (opts.output ?? process.stdout) as unknown as OutLike
    this.mouse = opts.mouse ?? false
    this.truecolor = detectTruecolor()
    this.renderer = new Renderer(this.truecolor)
    if (typeof this.output.columns === 'number') this._cols = this.output.columns
    if (typeof this.output.rows === 'number') this._rows = this.output.rows
  }

  get cols(): number {
    return this._cols
  }
  get rows(): number {
    return this._rows
  }
  get supportsTruecolor(): boolean {
    return this.truecolor
  }
  get droppedFrames(): number {
    return this._droppedFrames
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.active = true
    this.writePending = false // a pending write from a previous session is moot
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true)
    if (typeof this.input.resume === 'function') this.input.resume()
    let enter = ALT_SCREEN_ON + CLEAR_SCREEN + CURSOR_HOME + CURSOR_HIDE + FOCUS_ON + PASTE_ON
    if (this.mouse) enter += MOUSE_ON
    this.output.write(enter)
    this.input.on('data', this.onData)
    process.on('SIGWINCH', this.onSigwinch)
    process.on('exit', this.onExit)
    process.on('SIGINT', this.onSigint)
    process.on('SIGTERM', this.onSigterm)
    process.on('uncaughtException', this.onUncaught)
    this.renderer.invalidate()
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
    this.input.off('data', this.onData)
    process.off('SIGWINCH', this.onSigwinch)
    process.off('exit', this.onExit)
    process.off('SIGINT', this.onSigint)
    process.off('SIGTERM', this.onSigterm)
    process.off('uncaughtException', this.onUncaught)
    this.restore()
    if (typeof this.input.pause === 'function') this.input.pause()
  }

  onInput(fn: (e: InputEvent) => void): () => void {
    this.subs.add(fn)
    return () => {
      this.subs.delete(fn)
    }
  }

  flush(grid: Grid): void {
    if (!this.started) return // never paint outside an active session
    if (this.writePending) {
      this._droppedFrames++
      return
    }
    const bytes = this.renderer.render(grid)
    if (bytes === '') return
    let ok: boolean
    try {
      ok = this.output.write(bytes)
    } catch {
      // The front buffer was already updated but the bytes never reached
      // the screen — repaint fully on the next flush instead of going stale.
      this.renderer.invalidate()
      return
    }
    if (ok) return
    this.writePending = true
    const onDrain = () => {
      this.writePending = false
    }
    if (typeof this.output.once === 'function') {
      this.output.once('drain', onDrain)
    } else if (typeof this.output.on === 'function') {
      const off = this.output.off
      const wrapped = () => {
        onDrain()
        if (typeof off === 'function') off.call(this.output, 'drain', wrapped)
      }
      this.output.on('drain', wrapped)
    } else {
      // No drain signal available: don't wedge the session.
      this.writePending = false
    }
  }

  invalidate(): void {
    this.renderer.invalidate()
  }

  // ── internal ────────────────────────────────────────────────────────

  private dispatch(e: InputEvent): void {
    for (const fn of [...this.subs]) fn(e)
  }

  private onData = (chunk: Uint8Array | string): void => {
    if (this.escTimer !== null) {
      clearTimeout(this.escTimer)
      this.escTimer = null
    }
    for (const e of this.parser.feed(chunk)) this.dispatch(e)
    if (this.parser.hasPendingEscape()) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null
        for (const e of this.parser.flushPending()) this.dispatch(e)
      }, ESC_FLUSH_MS)
    }
  }

  private onSigwinch = (): void => {
    if (typeof this.output.columns === 'number') this._cols = this.output.columns
    if (typeof this.output.rows === 'number') this._rows = this.output.rows
    this.renderer.invalidate()
    this.dispatch({ kind: 'resize', cols: this._cols, rows: this._rows })
  }

  /**
   * Idempotent crash-safe restore: end any synchronized update, modes off
   * (reverse of start), SGR reset, show cursor, leave alt screen, cooked
   * mode. Safe to call multiple times and from signal/exit handlers.
   */
  private restore = (): void => {
    if (!this.active) return
    this.active = false
    let out = ESU
    if (this.mouse) out += MOUSE_OFF
    out += PASTE_OFF + FOCUS_OFF + SGR_RESET + CURSOR_SHOW + ALT_SCREEN_OFF
    try {
      this.output.write(out)
    } catch {
      /* output may already be gone — restoring must never throw */
    }
    try {
      if (typeof this.input.setRawMode === 'function') this.input.setRawMode(false)
    } catch {
      /* ditto */
    }
  }

  private onExit = (): void => {
    this.restore()
  }
  private onSigint = (): void => {
    this.restore()
    process.exit(130)
  }
  private onSigterm = (): void => {
    this.restore()
    process.exit(143)
  }
  private onUncaught = (err: unknown): void => {
    this.restore()
    console.error(err)
    process.exit(1)
  }
}

/** Create a terminal session (injectable streams for tests). */
export function createTerm(opts: TermOptions = {}): Term {
  return new TermImpl(opts)
}
