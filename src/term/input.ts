/**
 * Sans-IO input parser: feed bytes, get events. No timers, no streams.
 *
 * Handles: UTF-8 reassembly across chunks; CSI/SS3 keys with xterm
 * modifier encodings; ctrl-letters; alt-prefix ESC; bare-ESC hold +
 * flushPending(); SGR mouse (press/release/drag, wheel→WheelEvent);
 * focus in/out; bracketed paste (ESC bytes inside paste are NOT parsed,
 * and paste text is delivered whole so grapheme clusters stay intact);
 * swallows common terminal responses (DA1, DSR, DECRPM, OSC/DCS replies)
 * without emitting key events.
 *
 * Decisions (documented, test-pinned):
 * - 0x0A (ctrl-j / LF) is normalized to 'enter' alongside 0x0D.
 * - 0x08 is decoded truthfully as ctrl+h (the Backspace key sends 0x7F).
 * - A–Z decode as lowercase name + shift:true; other printables as typed.
 * - ESC ESC = two escape presses (first emitted, second held).
 * - CSI 1;mod R is F3-with-modifier; any other CSI ...R is swallowed as a
 *   DSR cursor-position report (we never query DSR, but be liberal).
 * - flushPending(): bare ESC → escape key; ESC-led CSI/SS3 partial →
 *   escape key + the tail reparsed as plain keys; OSC/DCS fragments and
 *   incomplete UTF-8 are discarded; an unterminated paste keeps waiting.
 */

import type {
  InputEvent,
  InputParser,
  KeyEvent,
  MouseEvent,
  WheelEvent,
} from './types'

const ESC_B = 0x1b
/** ESC [ 2 0 1 ~ — bracketed-paste terminator. */
const PASTE_END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e] as const

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

type ParseResult = { consumed: number; events: InputEvent[] } | 'incomplete'

function key(name: string, seq: string, ctrl = false, alt = false, shift = false): KeyEvent {
  return { kind: 'key', name, ctrl, alt, shift, seq }
}

/** Normalize a decoded character: A–Z → lowercase + shift; ' ' → 'space'. */
function charKey(chr: string, seq: string): KeyEvent {
  if (chr === ' ') return key('space', seq)
  if (chr >= 'A' && chr <= 'Z') return key(chr.toLowerCase(), seq, false, false, true)
  return key(chr, seq)
}

/** Decode a C0 control byte (or DEL) to a key event. */
function c0Key(b: number, seq: string): KeyEvent | null {
  switch (b) {
    case 0x00:
      return key('space', seq, true) // NUL = ctrl+space
    case 0x09:
      return key('tab', seq)
    case 0x0a:
    case 0x0d:
      return key('enter', seq)
    case 0x1b:
      return key('escape', seq)
    case 0x7f:
      return key('backspace', seq)
    default:
      break
  }
  if (b >= 0x01 && b <= 0x1a) return key(String.fromCharCode(b + 0x60), seq, true) // ctrl+a..z
  if (b >= 0x1c && b <= 0x1f) return key(String.fromCharCode(b + 0x40), seq, true) // ctrl+\ ] ^ _
  return null
}

function utf8Len(lead: number): number {
  if (lead < 0x80) return 1
  if ((lead & 0xe0) === 0xc0) return 2
  if ((lead & 0xf0) === 0xe0) return 3
  if ((lead & 0xf8) === 0xf0) return 4
  return 0 // stray continuation byte / invalid lead
}

/** Raw bytes as a latin1 string (for KeyEvent.seq debugging). */
function latin1(bytes: number[]): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

function findSeq(buf: number[], seq: readonly number[], from: number): number {
  const n = buf.length - seq.length
  outer: for (let i = from; i <= n; i++) {
    for (let k = 0; k < seq.length; k++) {
      if (buf[i + k] !== seq[k]) continue outer
    }
    return i
  }
  return -1
}

const CSI_ARROW_KEYS = new Map<string, string>([
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
  ['H', 'home'],
  ['F', 'end'],
])

const CSI_FN_FINALS = new Map<string, string>([
  ['P', 'f1'],
  ['Q', 'f2'],
  ['R', 'f3'], // only for CSI 1;mod R — see dispatchCsi
  ['S', 'f4'],
])

const SS3_KEYS = new Map<string, string>([
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
  ['H', 'home'],
  ['F', 'end'],
  ['P', 'f1'],
  ['Q', 'f2'],
  ['R', 'f3'],
  ['S', 'f4'],
  ['M', 'enter'], // keypad enter
])

const TILDE_KEYS = new Map<number, string>([
  [1, 'home'],
  [2, 'insert'],
  [3, 'delete'],
  [4, 'end'],
  [5, 'pgup'],
  [6, 'pgdn'],
  [7, 'home'], // rxvt
  [8, 'end'], // rxvt
  [11, 'f1'],
  [12, 'f2'],
  [13, 'f3'],
  [14, 'f4'],
  [15, 'f5'],
  [17, 'f6'],
  [18, 'f7'],
  [19, 'f8'],
  [20, 'f9'],
  [21, 'f10'],
  [23, 'f11'],
  [24, 'f12'],
])

export class AnsiParser implements InputParser {
  private buf: number[] = []
  private inPaste = false
  private pasteBytes: number[] = []

  feed(chunk: Uint8Array | string): InputEvent[] {
    if (typeof chunk === 'string') {
      const bytes = encoder.encode(chunk)
      for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i]!)
    } else {
      for (let i = 0; i < chunk.length; i++) this.buf.push(chunk[i]!)
    }
    return this.drain(false)
  }

  flushPending(): InputEvent[] {
    return this.drain(true)
  }

  /** True when an ESC-led partial is held (the Term arms its flush timer). */
  hasPendingEscape(): boolean {
    return !this.inPaste && this.buf.length > 0 && this.buf[0] === ESC_B
  }

  private drain(flush: boolean): InputEvent[] {
    const events: InputEvent[] = []
    let i = 0
    while (i < this.buf.length) {
      if (this.inPaste) {
        i = this.scanPaste(i, events)
        if (this.inPaste) break // waiting for the terminator (even on flush)
        continue
      }
      const r = this.parseAt(i)
      if (r === 'incomplete') {
        if (!flush) break
        i = this.flushPartial(i, events)
        continue
      }
      for (const e of r.events) events.push(e)
      i += r.consumed
    }
    this.buf = i === 0 ? this.buf : this.buf.slice(i)
    return events
  }

  /** Flush semantics for an incomplete token at offset i; returns new i. */
  private flushPartial(i: number, events: InputEvent[]): number {
    const b = this.buf[i]!
    if (b !== ESC_B) return this.buf.length // incomplete UTF-8: discard
    const n = this.buf[i + 1]
    if (n === undefined) {
      events.push(key('escape', '\x1b')) // held bare ESC
      return i + 1
    }
    if (n === 0x5d || n === 0x50) return this.buf.length // OSC/DCS fragment: discard
    // CSI/SS3/alt partial: emit escape, reparse the tail as plain input.
    events.push(key('escape', '\x1b'))
    return i + 1
  }

  private parseAt(i: number): ParseResult {
    const b = this.buf[i]!
    if (b !== ESC_B) return this.parseKeyAt(i)
    const n = this.buf[i + 1]
    if (n === undefined) return 'incomplete' // bare ESC: hold
    if (n === 0x5b) return this.parseCsi(i) // ESC [
    if (n === 0x4f) return this.parseSs3(i) // ESC O
    if (n === 0x5d) return this.parseStringSeq(i, true) // OSC (BEL or ST)
    if (n === 0x50) return this.parseStringSeq(i, false) // DCS (ST)
    if (n === ESC_B) return { consumed: 1, events: [key('escape', '\x1b')] } // ESC ESC
    // alt-prefixed key
    const sub = this.parseKeyAt(i + 1)
    if (sub === 'incomplete') return 'incomplete'
    const events = sub.events.map((e) =>
      e.kind === 'key' ? { ...e, alt: true, seq: '\x1b' + e.seq } : e,
    )
    return { consumed: 1 + sub.consumed, events }
  }

  /** Parse one plain key (C0, printable ASCII, or one UTF-8 code point). */
  private parseKeyAt(i: number): ParseResult {
    const b = this.buf[i]!
    if (b < 0x20 || b === 0x7f) {
      const ev = c0Key(b, String.fromCharCode(b))
      return { consumed: 1, events: ev ? [ev] : [] }
    }
    if (b < 0x80) {
      const s = String.fromCharCode(b)
      return { consumed: 1, events: [charKey(s, s)] }
    }
    const len = utf8Len(b)
    if (len === 0) return { consumed: 1, events: [] } // invalid byte: drop
    if (i + len > this.buf.length) return 'incomplete'
    const bytes: number[] = []
    for (let k = 0; k < len; k++) bytes.push(this.buf[i + k]!)
    for (let k = 1; k < len; k++) {
      if ((bytes[k]! & 0xc0) !== 0x80) return { consumed: 1, events: [] } // malformed: drop lead
    }
    const chr = decoder.decode(Uint8Array.from(bytes))
    return { consumed: len, events: [charKey(chr, latin1(bytes))] }
  }

  private parseCsi(i: number): ParseResult {
    const n = this.buf.length
    let j = i + 2
    let paramStr = ''
    while (j < n && this.buf[j]! >= 0x30 && this.buf[j]! <= 0x3f) {
      paramStr += String.fromCharCode(this.buf[j]!)
      j++
    }
    let inter = ''
    while (j < n && this.buf[j]! >= 0x20 && this.buf[j]! <= 0x2f) {
      inter += String.fromCharCode(this.buf[j]!)
      j++
    }
    if (j >= n) return 'incomplete'
    const fb = this.buf[j]!
    if (fb < 0x40 || fb > 0x7e) {
      // Malformed (C0/ESC inside the sequence): abort, reparse from fb.
      return { consumed: j - i, events: [] }
    }
    const final = String.fromCharCode(fb)
    // Legacy X10 mouse: CSI M + 3 raw bytes (sent when SGR is unsupported).
    if (final === 'M' && paramStr === '' && inter === '') {
      if (n < j + 4) return 'incomplete'
      return { consumed: j + 4 - i, events: [] } // swallow
    }
    const seqBytes: number[] = []
    for (let k = i; k <= j; k++) seqBytes.push(this.buf[k]!)
    return { consumed: j - i + 1, events: this.dispatchCsi(paramStr, inter, final, latin1(seqBytes)) }
  }

  private dispatchCsi(paramStr: string, inter: string, final: string, seq: string): InputEvent[] {
    // SGR mouse: CSI < b ; x ; y M/m
    if (paramStr.startsWith('<') && (final === 'M' || final === 'm')) {
      return sgrMouse(paramStr.slice(1), final)
    }
    if (final === 'I') return [{ kind: 'focus', focused: true }]
    if (final === 'O') return [{ kind: 'focus', focused: false }]
    // DEC responses (DA1 'CSI ? .. c', DECRPM 'CSI ? .. $ y', ...): swallow.
    if (paramStr.startsWith('?') || paramStr.startsWith('>') || paramStr.startsWith('=')) return []
    if (inter !== '') return [] // unknown intermediates: swallow

    const params = paramStr === '' ? [] : paramStr.split(';').map((s) => parseInt(s, 10) || 0)
    const mod = Math.max(0, (params[1] ?? 1) - 1)
    const shift = (mod & 1) !== 0
    const alt = (mod & 2) !== 0
    const ctrl = (mod & 4) !== 0

    const arrow = CSI_ARROW_KEYS.get(final)
    if (arrow !== undefined) return [key(arrow, seq, ctrl, alt, shift)]

    if (final === 'Z') return [key('tab', seq, false, false, true)] // back-tab

    if (final === '~') {
      const n0 = params[0] ?? 0
      if (n0 === 200) {
        this.inPaste = true
        return []
      }
      if (n0 === 201) return [] // stray paste end: ignore
      const name = TILDE_KEYS.get(n0)
      return name !== undefined ? [key(name, seq, ctrl, alt, shift)] : []
    }

    if (final === 'R') {
      // CSI 1;mod R = modified F3; anything else = DSR cursor report.
      if (params.length === 2 && params[0] === 1) return [key('f3', seq, ctrl, alt, shift)]
      return []
    }

    const fn = CSI_FN_FINALS.get(final)
    if (fn !== undefined) return [key(fn, seq, ctrl, alt, shift)]

    return [] // unknown final: swallow (covers 'c', 'y', 'u', 'n', 't', ...)
  }

  private parseSs3(i: number): ParseResult {
    const fb = this.buf[i + 2]
    if (fb === undefined) return 'incomplete'
    const final = String.fromCharCode(fb)
    const name = SS3_KEYS.get(final)
    const seq = '\x1bO' + final
    return { consumed: 3, events: name !== undefined ? [key(name, seq)] : [] }
  }

  /** Swallow OSC (BEL- or ST-terminated) / DCS (ST-terminated) strings. */
  private parseStringSeq(i: number, allowBel: boolean): ParseResult {
    const n = this.buf.length
    for (let j = i + 2; j < n; j++) {
      const b = this.buf[j]!
      if (allowBel && b === 0x07) return { consumed: j + 1 - i, events: [] }
      if (b === ESC_B) {
        if (j + 1 >= n) return 'incomplete' // could be ESC \ (ST)
        if (this.buf[j + 1] === 0x5c) return { consumed: j + 2 - i, events: [] }
      }
    }
    return 'incomplete'
  }

  /** Accumulate paste bytes; emit PasteEvent when the terminator arrives. */
  private scanPaste(i: number, events: InputEvent[]): number {
    const idx = findSeq(this.buf, PASTE_END, i)
    if (idx >= 0) {
      for (let k = i; k < idx; k++) this.pasteBytes.push(this.buf[k]!)
      events.push({ kind: 'paste', text: decoder.decode(Uint8Array.from(this.pasteBytes)) })
      this.pasteBytes = []
      this.inPaste = false
      return idx + PASTE_END.length
    }
    // Keep the longest buffer tail that is a prefix of the terminator.
    const n = this.buf.length
    let keep = 0
    const maxKeep = Math.min(PASTE_END.length - 1, n - i)
    for (let len = maxKeep; len >= 1; len--) {
      let ok = true
      for (let k = 0; k < len; k++) {
        if (this.buf[n - len + k] !== PASTE_END[k]) {
          ok = false
          break
        }
      }
      if (ok) {
        keep = len
        break
      }
    }
    for (let k = i; k < n - keep; k++) this.pasteBytes.push(this.buf[k]!)
    return n - keep
  }
}

/** Decode 'b;x;y' + final M/m into mouse / wheel events. */
function sgrMouse(body: string, final: string): Array<MouseEvent | WheelEvent> {
  const parts = body.split(';').map((s) => parseInt(s, 10) || 0)
  const b = parts[0] ?? 0
  const col = Math.max(0, (parts[1] ?? 1) - 1)
  const row = Math.max(0, (parts[2] ?? 1) - 1)
  // Buttons 8-11 (back/forward, bit 7): not representable as 0|1|2 — swallow
  // rather than fabricate a left/middle/right click.
  if (b & 128) return []
  if (b & 64) {
    const low = b & 3
    if (low === 0) return [{ kind: 'wheel', dir: 'up', col, row }]
    if (low === 1) return [{ kind: 'wheel', dir: 'down', col, row }]
    return [] // wheel left/right: swallow
  }
  const btn = b & 3
  if (btn === 3) return [] // motion with no button (mode 1003): swallow
  const action: MouseEvent['action'] = final === 'm' ? 'release' : b & 32 ? 'drag' : 'press'
  return [{ kind: 'mouse', action, button: btn as 0 | 1 | 2, col, row }]
}

/** Create a sans-IO input parser. */
export function createInputParser(): InputParser {
  return new AnsiParser()
}
