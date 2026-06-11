/**
 * term — contracts for the terminal layer (ARCHITECTURE.md D5).
 *
 * OWNED BY THE INTEGRATOR — implementation work must not edit this file.
 *
 * Scope: raw-mode lifecycle with crash-safe restore, double-buffered
 * cell-grid diff renderer wrapped in DEC 2026 synchronized updates, and a
 * sans-IO input parser (keys, SGR mouse, wheel-as-events, focus,
 * bracketed paste). Reimplemented from public specs (xterm ctlseqs);
 * see ARCHITECTURE.md D6 for the reference policy.
 */

/**
 * Color encoding (packed number):
 *  -1                → terminal default
 *  0..255            → 256-color palette index
 *  0x1000000 | rgb   → truecolor (bit 24 set; rgb = r<<16 | g<<8 | b)
 * The renderer downconverts truecolor → 256 when the terminal lacks
 * truecolor support.
 */
export type Color = number
export const DEFAULT_COLOR: Color = -1
export const TRUECOLOR_BIT = 0x1000000

/** Attribute bitfield. */
export const ATTR_NONE = 0
export const ATTR_BOLD = 1
export const ATTR_DIM = 2
export const ATTR_ITALIC = 4
export const ATTR_UNDERLINE = 8
export const ATTR_REVERSE = 16

export interface Cell {
  /** One grapheme cluster; '' marks the continuation cell of a wide char. */
  ch: string
  fg: Color
  bg: Color
  attrs: number
}

/**
 * A mutable cell grid (the back buffer). Wide graphemes occupy two cells:
 * set() writes the grapheme at (row,col) and a '' continuation at col+1.
 * Writes that fall outside the grid are silently clipped.
 */
export interface Grid {
  readonly cols: number
  readonly rows: number
  set(row: number, col: number, ch: string, fg?: Color, bg?: Color, attrs?: number): void
  /** Write a string; returns cells advanced. Clips at the right edge. */
  text(row: number, col: number, s: string, fg?: Color, bg?: Color, attrs?: number): number
  fill(row: number, col: number, w: number, h: number, ch: string, fg?: Color, bg?: Color, attrs?: number): void
  clear(): void
  get(row: number, col: number): Cell
}

/** Normalized key names: 'a'..'z', '0'..'9', punctuation as typed, plus:
 *  'up' 'down' 'left' 'right' 'enter' 'escape' 'space' 'tab' 'backspace'
 *  'delete' 'home' 'end' 'pgup' 'pgdn' 'insert' 'f1'..'f12'. */
export interface KeyEvent {
  kind: 'key'
  name: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Raw bytes, for debugging. */
  seq: string
}
export interface MouseEvent {
  kind: 'mouse'
  action: 'press' | 'release' | 'drag'
  /** 0 = left, 1 = middle, 2 = right. */
  button: 0 | 1 | 2
  /** 0-based screen coordinates (terminal reports 1-based; parser shifts). */
  col: number
  row: number
}
export interface WheelEvent {
  kind: 'wheel'
  dir: 'up' | 'down'
  col: number
  row: number
}
export interface FocusEvent {
  kind: 'focus'
  focused: boolean
}
export interface ResizeEvent {
  kind: 'resize'
  cols: number
  rows: number
}
export interface PasteEvent {
  kind: 'paste'
  text: string
}
export type InputEvent = KeyEvent | MouseEvent | WheelEvent | FocusEvent | ResizeEvent | PasteEvent

/**
 * Sans-IO input parser: feed bytes, get events. Owns reassembly of split
 * UTF-8 and split escape sequences across chunk boundaries. A bare ESC is
 * held until either more bytes arrive or flushPending() is called (the
 * Term drives a ~30 ms timer).
 */
export interface InputParser {
  feed(chunk: Uint8Array | string): InputEvent[]
  /** Flush a held bare-ESC (returns it as escape key) and any partials. */
  flushPending(): InputEvent[]
}

export interface TermOptions {
  /** Enable mouse tracking (modes 1000+1002+1006). Default false. */
  mouse?: boolean
  /** Injected streams for tests; default process.stdin/stdout. */
  input?: NodeJS.ReadStream | { on: Function; off: Function }
  output?: NodeJS.WriteStream | { write(s: string): boolean; on?: Function }
}

/**
 * Terminal session. start() saves state and enters: raw mode, alt screen
 * (1049), hide cursor, focus events (1004), bracketed paste (2004), mouse
 * (opt). stop() restores EVERYTHING in reverse order; restore is also
 * registered for exit/SIGINT/SIGTERM/uncaughtException and is idempotent.
 *
 * flush(grid): diff against the front buffer → minimal ANSI (cursor moves
 * + SGR-batched runs), the whole frame wrapped in BSU/ESU (DEC 2026).
 * First flush after start()/resize()/invalidate() repaints fully.
 * Backpressure: if the previous write hasn't drained, DROP this frame
 * (count it; never queue more than one frame deep).
 */
export interface Term {
  readonly cols: number
  readonly rows: number
  readonly supportsTruecolor: boolean
  /** Frames dropped due to backpressure (diagnostics). */
  readonly droppedFrames: number
  start(): void
  stop(): void
  onInput(fn: (e: InputEvent) => void): () => void
  flush(grid: Grid): void
  invalidate(): void
}
export const TERM_CONTRACT_VERSION = 1
