import { describe, expect, test } from 'bun:test'
import { AnsiParser } from '../../src/term/input'
import type { InputEvent, KeyEvent } from '../../src/term/types'

/** Feed chunks (latin1 strings or raw byte arrays) into a fresh parser. */
function parse(...chunks: Array<string | number[]>): InputEvent[] {
  const p = new AnsiParser()
  const out: InputEvent[] = []
  for (const c of chunks) {
    out.push(...p.feed(typeof c === 'string' ? Buffer.from(c, 'latin1') : Uint8Array.from(c)))
  }
  return out
}

/** UTF-8 bytes of a string. */
function u8(s: string): number[] {
  return [...Buffer.from(s, 'utf8')]
}

/** Reduce key events to comparable shape; throws if a non-key sneaks in. */
function keys(events: InputEvent[]): Array<{ name: string; ctrl: boolean; alt: boolean; shift: boolean }> {
  return events.map((e) => {
    if (e.kind !== 'key') throw new Error(`expected key, got ${e.kind}`)
    const { name, ctrl, alt, shift } = e
    return { name, ctrl, alt, shift }
  })
}

const k = (name: string, mods: Partial<Pick<KeyEvent, 'ctrl' | 'alt' | 'shift'>> = {}) => ({
  name,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
})

describe('plain keys', () => {
  test('ascii letters, digits, punctuation', () => {
    expect(keys(parse('a'))).toEqual([k('a')])
    expect(keys(parse('1'))).toEqual([k('1')])
    expect(keys(parse('!'))).toEqual([k('!')])
    expect(keys(parse('['))).toEqual([k('[')])
  })

  test('uppercase normalizes to lowercase + shift', () => {
    expect(keys(parse('A'))).toEqual([k('a', { shift: true })])
    expect(keys(parse('Z'))).toEqual([k('z', { shift: true })])
  })

  test('specials: enter / tab / space / backspace', () => {
    expect(keys(parse('\r'))).toEqual([k('enter')])
    expect(keys(parse('\n'))).toEqual([k('enter')]) // ctrl-j aliases to enter
    expect(keys(parse('\t'))).toEqual([k('tab')])
    expect(keys(parse(' '))).toEqual([k('space')])
    expect(keys(parse('\x7f'))).toEqual([k('backspace')])
    expect(keys(parse('\x00'))).toEqual([k('space', { ctrl: true })])
  })

  test('ctrl-letters', () => {
    expect(keys(parse('\x01'))).toEqual([k('a', { ctrl: true })])
    expect(keys(parse('\x03'))).toEqual([k('c', { ctrl: true })])
    expect(keys(parse('\x08'))).toEqual([k('h', { ctrl: true })]) // backspace key sends 0x7f
    expect(keys(parse('\x1a'))).toEqual([k('z', { ctrl: true })])
    expect(keys(parse('\x1c'))).toEqual([k('\\', { ctrl: true })])
    expect(keys(parse('\x1f'))).toEqual([k('_', { ctrl: true })])
  })

  test('multiple keys in one chunk', () => {
    expect(keys(parse('ab\r'))).toEqual([k('a'), k('b'), k('enter')])
  })
})

describe('CSI / SS3 keys', () => {
  test('arrows', () => {
    expect(keys(parse('\x1b[A'))).toEqual([k('up')])
    expect(keys(parse('\x1b[B'))).toEqual([k('down')])
    expect(keys(parse('\x1b[C'))).toEqual([k('right')])
    expect(keys(parse('\x1b[D'))).toEqual([k('left')])
    expect(keys(parse('\x1bOA'))).toEqual([k('up')])
    expect(keys(parse('\x1bOD'))).toEqual([k('left')])
  })

  test('home/end in all encodings', () => {
    for (const seq of ['\x1b[H', '\x1b[1~', '\x1b[7~', '\x1bOH']) {
      expect(keys(parse(seq))).toEqual([k('home')])
    }
    for (const seq of ['\x1b[F', '\x1b[4~', '\x1b[8~', '\x1bOF']) {
      expect(keys(parse(seq))).toEqual([k('end')])
    }
  })

  test('pgup/pgdn/insert/delete', () => {
    expect(keys(parse('\x1b[5~'))).toEqual([k('pgup')])
    expect(keys(parse('\x1b[6~'))).toEqual([k('pgdn')])
    expect(keys(parse('\x1b[2~'))).toEqual([k('insert')])
    expect(keys(parse('\x1b[3~'))).toEqual([k('delete')])
  })

  test('function keys', () => {
    expect(keys(parse('\x1bOP'))).toEqual([k('f1')])
    expect(keys(parse('\x1bOQ'))).toEqual([k('f2')])
    expect(keys(parse('\x1bOR'))).toEqual([k('f3')])
    expect(keys(parse('\x1bOS'))).toEqual([k('f4')])
    expect(keys(parse('\x1b[11~'))).toEqual([k('f1')])
    expect(keys(parse('\x1b[15~'))).toEqual([k('f5')])
    expect(keys(parse('\x1b[17~'))).toEqual([k('f6')])
    expect(keys(parse('\x1b[21~'))).toEqual([k('f10')])
    expect(keys(parse('\x1b[23~'))).toEqual([k('f11')])
    expect(keys(parse('\x1b[24~'))).toEqual([k('f12')])
  })

  test('xterm modifier encodings (CSI 1;mod X)', () => {
    expect(keys(parse('\x1b[1;5A'))).toEqual([k('up', { ctrl: true })])
    expect(keys(parse('\x1b[1;2C'))).toEqual([k('right', { shift: true })])
    expect(keys(parse('\x1b[1;3D'))).toEqual([k('left', { alt: true })])
    expect(keys(parse('\x1b[1;7B'))).toEqual([k('down', { ctrl: true, alt: true })])
    expect(keys(parse('\x1b[1;8H'))).toEqual([k('home', { ctrl: true, alt: true, shift: true })])
  })

  test('modifiers on tilde keys and F-keys', () => {
    expect(keys(parse('\x1b[3;5~'))).toEqual([k('delete', { ctrl: true })])
    expect(keys(parse('\x1b[5;3~'))).toEqual([k('pgup', { alt: true })])
    expect(keys(parse('\x1b[1;2P'))).toEqual([k('f1', { shift: true })])
    expect(keys(parse('\x1b[1;2R'))).toEqual([k('f3', { shift: true })]) // not a DSR
  })

  test('back-tab (CSI Z) is shift+tab', () => {
    expect(keys(parse('\x1b[Z'))).toEqual([k('tab', { shift: true })])
  })

  test('seq carries the raw bytes', () => {
    const [e] = parse('\x1b[1;5A')
    expect(e).toMatchObject({ kind: 'key', seq: '\x1b[1;5A' })
  })
})

describe('alt-prefix ESC', () => {
  test('alt + letter / uppercase / enter / backspace', () => {
    expect(keys(parse('\x1ba'))).toEqual([k('a', { alt: true })])
    expect(keys(parse('\x1bA'))).toEqual([k('a', { alt: true, shift: true })])
    expect(keys(parse('\x1b\r'))).toEqual([k('enter', { alt: true })])
    expect(keys(parse('\x1b\x7f'))).toEqual([k('backspace', { alt: true })])
  })

  test('alt + ctrl-letter', () => {
    expect(keys(parse('\x1b\x01'))).toEqual([k('a', { ctrl: true, alt: true })])
  })

  test('alt + multi-byte char', () => {
    expect(keys(parse([0x1b, ...u8('é')]))).toEqual([k('é', { alt: true })])
  })

  test('held ESC becomes alt prefix when the next chunk arrives', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b')).toEqual([])
    expect(keys(p.feed('a'))).toEqual([k('a', { alt: true })])
  })
})

describe('bare ESC hold + flushPending', () => {
  test('bare ESC is held, then flushed as escape', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b')).toEqual([])
    expect(p.hasPendingEscape()).toBe(true)
    expect(keys(p.flushPending())).toEqual([k('escape')])
    expect(p.hasPendingEscape()).toBe(false)
    expect(p.flushPending()).toEqual([])
  })

  test('ESC ESC = escape emitted, second held', () => {
    const p = new AnsiParser()
    expect(keys(p.feed('\x1b\x1b'))).toEqual([k('escape')])
    expect(keys(p.flushPending())).toEqual([k('escape')])
  })

  test('flushing a partial CSI yields escape + the tail as plain keys', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[1')).toEqual([])
    expect(keys(p.flushPending())).toEqual([k('escape'), k('['), k('1')])
  })

  test('escape then arrow in the same chunk parses both', () => {
    expect(keys(parse('\x1b\x1b[A'))).toEqual([k('escape'), k('up')])
  })
})

describe('split sequences across feed() calls', () => {
  test('CSI split mid-sequence', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[')).toEqual([])
    expect(keys(p.feed('A'))).toEqual([k('up')])
  })

  test('CSI with params split', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[1;')).toEqual([])
    expect(keys(p.feed('5A'))).toEqual([k('up', { ctrl: true })])
  })

  test('UTF-8 split across chunks (3-byte)', () => {
    const bytes = u8('你')
    const p = new AnsiParser()
    expect(p.feed(Uint8Array.from(bytes.slice(0, 1)))).toEqual([])
    expect(keys(p.feed(Uint8Array.from(bytes.slice(1))))).toEqual([k('你')])
  })

  test('UTF-8 split across chunks (4-byte)', () => {
    const bytes = u8('🎮')
    const p = new AnsiParser()
    expect(p.feed(Uint8Array.from(bytes.slice(0, 2)))).toEqual([])
    expect(keys(p.feed(Uint8Array.from(bytes.slice(2))))).toEqual([k('🎮')])
  })

  test('whole UTF-8 chars decode directly', () => {
    expect(keys(parse(u8('é')))).toEqual([k('é')])
    expect(keys(parse(u8('字')))).toEqual([k('字')])
  })

  test('invalid UTF-8 bytes are dropped without wedging', () => {
    expect(keys(parse([0x80, 0x61]))).toEqual([k('a')]) // stray continuation
    expect(keys(parse([0xc3, 0x28]))).toEqual([k('(')]) // bad continuation: lead dropped
  })
})

describe('SGR mouse', () => {
  test('press / drag / release with button bits', () => {
    expect(parse('\x1b[<0;10;5M')).toEqual([
      { kind: 'mouse', action: 'press', button: 0, col: 9, row: 4 },
    ])
    expect(parse('\x1b[<2;1;1M')).toEqual([
      { kind: 'mouse', action: 'press', button: 2, col: 0, row: 0 },
    ])
    expect(parse('\x1b[<32;11;5M')).toEqual([
      { kind: 'mouse', action: 'drag', button: 0, col: 10, row: 4 },
    ])
    expect(parse('\x1b[<33;4;4M')).toEqual([
      { kind: 'mouse', action: 'drag', button: 1, col: 3, row: 3 },
    ])
    expect(parse('\x1b[<0;11;5m')).toEqual([
      { kind: 'mouse', action: 'release', button: 0, col: 10, row: 4 },
    ])
  })

  test('wheel becomes WheelEvent', () => {
    expect(parse('\x1b[<64;3;4M')).toEqual([{ kind: 'wheel', dir: 'up', col: 2, row: 3 }])
    expect(parse('\x1b[<65;3;4M')).toEqual([{ kind: 'wheel', dir: 'down', col: 2, row: 3 }])
  })

  test('modifier bits are masked off; wheel with ctrl still wheels', () => {
    expect(parse('\x1b[<16;2;3M')).toEqual([
      { kind: 'mouse', action: 'press', button: 0, col: 1, row: 2 },
    ])
    expect(parse('\x1b[<80;2;3M')).toEqual([{ kind: 'wheel', dir: 'up', col: 1, row: 2 }])
  })

  test('motion without button (hover, mode 1003) is swallowed', () => {
    expect(parse('\x1b[<35;2;2M')).toEqual([])
  })

  test('legacy X10 mouse reports are swallowed, not misparsed', () => {
    expect(parse('\x1b[M !!')).toEqual([])
    expect(keys(parse('\x1b[M !!a'))).toEqual([k('a')])
  })
})

describe('focus events', () => {
  test('CSI I / CSI O', () => {
    expect(parse('\x1b[I')).toEqual([{ kind: 'focus', focused: true }])
    expect(parse('\x1b[O')).toEqual([{ kind: 'focus', focused: false }])
  })
})

describe('bracketed paste', () => {
  test('simple paste', () => {
    expect(parse('\x1b[200~hello\x1b[201~')).toEqual([{ kind: 'paste', text: 'hello' }])
  })

  test('ESC bytes inside paste are NOT parsed', () => {
    expect(parse('\x1b[200~a\x1b[Ac\x1b[201~')).toEqual([{ kind: 'paste', text: 'a\x1b[Ac' }])
  })

  test('keys after the paste still parse', () => {
    const events = parse('\x1b[200~hi\x1b[201~x')
    expect(events[0]).toEqual({ kind: 'paste', text: 'hi' })
    expect(keys(events.slice(1))).toEqual([k('x')])
  })

  test('paste split across chunks, terminator split too', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[200~he')).toEqual([])
    expect(p.feed('llo\x1b[20')).toEqual([])
    expect(p.feed('1~')).toEqual([{ kind: 'paste', text: 'hello' }])
  })

  test('false-alarm partial terminator stays in the text', () => {
    expect(parse('\x1b[200~x\x1b[20zzz\x1b[201~')).toEqual([
      { kind: 'paste', text: 'x\x1b[20zzz' },
    ])
  })

  test('multi-byte text inside paste decodes as UTF-8', () => {
    const p = new AnsiParser()
    const bytes = [
      ...Buffer.from('\x1b[200~', 'latin1'),
      ...u8('你好'),
      ...Buffer.from('\x1b[201~', 'latin1'),
    ]
    expect(p.feed(Uint8Array.from(bytes))).toEqual([{ kind: 'paste', text: '你好' }])
  })

  test('unterminated paste keeps waiting (flushPending does not corrupt it)', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b[200~partial')).toEqual([])
    expect(p.hasPendingEscape()).toBe(false)
    expect(p.flushPending()).toEqual([])
    expect(p.feed('-done\x1b[201~')).toEqual([{ kind: 'paste', text: 'partial-done' }])
  })
})

describe('terminal responses are swallowed', () => {
  test('DA1 / DA2', () => {
    expect(parse('\x1b[?1;2c')).toEqual([])
    expect(parse('\x1b[?64;1;2;6;9;15;22c')).toEqual([])
    expect(parse('\x1b[>0;276;0c')).toEqual([])
  })

  test('DSR cursor position report', () => {
    expect(parse('\x1b[24;80R')).toEqual([])
    expect(parse('\x1b[3;1R')).toEqual([])
  })

  test('DECRPM', () => {
    expect(parse('\x1b[?2026;1$y')).toEqual([])
    expect(parse('\x1b[?1049;2$y')).toEqual([])
  })

  test('OSC responses (BEL- and ST-terminated)', () => {
    expect(parse('\x1b]11;rgb:1111/2222/3333\x07')).toEqual([])
    expect(parse('\x1b]11;rgb:0000/0000/0000\x1b\\')).toEqual([])
  })

  test('OSC split across feeds still swallowed', () => {
    const p = new AnsiParser()
    expect(p.feed('\x1b]11;rgb:11')).toEqual([])
    expect(p.feed('11/2222/3333\x07a')).toEqual([
      { kind: 'key', name: 'a', ctrl: false, alt: false, shift: false, seq: 'a' },
    ])
  })

  test('DCS response', () => {
    expect(parse('\x1bP>|term v1\x1b\\')).toEqual([])
  })

  test('unknown CSI finals are swallowed silently', () => {
    expect(parse('\x1b[97;5u')).toEqual([]) // kitty-style, not enabled
    expect(parse('\x1b[8;24;80t')).toEqual([]) // window report
  })

  test('responses interleaved with real keys', () => {
    expect(keys(parse('a\x1b[?1;2cb'))).toEqual([k('a'), k('b')])
  })
})
