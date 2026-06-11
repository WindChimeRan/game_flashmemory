/**
 * sanitize — the §5.4 security boundary. The layout engine must survive
 * arbitrary hostile text, so: ANSI/CSI/OSC/DCS escapes (raw C1 included),
 * C0 controls, zero-width + bidi trickery, whitespace runs and
 * think-spans must all be neutralized — including when split across
 * stream pieces at ANY boundary (SSE deltas split anywhere).
 *
 * Invisible/control characters are built via String.fromCodePoint so the
 * hostile inputs are exact, visible and reviewable (no literal invisibles
 * hiding in this file).
 */

import { describe, expect, test } from 'bun:test'
import { createSanitizer, sanitizeText } from '../../src/content/sanitize'

const clean = (s: string): string => sanitizeText(s)
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)

// named hostiles (ASCII-only construction)
const ZWSP = cp(0x200b)
const ZWNJ = cp(0x200c)
const ZWJ = cp(0x200d)
const WJ = cp(0x2060)
const BOM = cp(0xfeff)
const SHY = cp(0x00ad)
const LRM = cp(0x200e)
const RLM = cp(0x200f)
const LRE = cp(0x202a)
const PDF = cp(0x202c)
const RLO = cp(0x202e)
const LRI = cp(0x2066)
const PDI = cp(0x2069)
const ALM = cp(0x061c)
const VS16 = cp(0xfe0f)
const TAG_A = cp(0xe0041)
const TAG_END = cp(0xe007f)
const C1_CSI = cp(0x9b)
const C1_OSC = cp(0x9d)
const C1_ST = cp(0x9c)
const C1_DCS = cp(0x90)
const NBSP = cp(0x00a0)
const EM_SPACE = cp(0x2003)
const IDEO_SPACE = cp(0x3000)

describe('sanitize: ANSI / control stripping', () => {
  test('CSI SGR sequences dropped', () => {
    expect(clean('red \x1b[31mtext\x1b[0m here')).toBe('red text here')
    expect(clean('\x1b[38;5;196mX\x1b[48;2;1;2;3mY')).toBe('XY')
  })

  test('cursor/erase/scroll CSI dropped', () => {
    expect(clean('\x1b[2J\x1b[H\x1b[10;20Hhi\x1b[1S')).toBe('hi')
  })

  test('OSC terminated by BEL and by ST', () => {
    expect(clean('a\x1b]0;evil window title\x07b')).toBe('ab')
    expect(clean('a\x1b]8;;http://evil\x1b\\b')).toBe('ab')
  })

  test('DCS / APC strings dropped', () => {
    expect(clean('x\x1bPq#0;1;0\x1b\\y\x1b_apc-payload\x1b\\z')).toBe('xyz')
  })

  test('raw C1 introducers (CSI/OSC/DCS as single code points)', () => {
    expect(clean(`a${C1_CSI}31mb`)).toBe('ab')
    expect(clean(`a${C1_OSC}0;t${C1_ST}b`)).toBe('ab')
    expect(clean(`a${C1_DCS}payload${C1_ST}b`)).toBe('ab')
  })

  test('two-char escapes and intermediates', () => {
    expect(clean('a\x1b(Bb')).toBe('ab') // charset designator
    expect(clean('a\x1b#8b')).toBe('ab') // DECALN
    expect(clean('a\x1bcb')).toBe('ab') // RIS, then literal b
  })

  test('C0 dropped; newline-ish become spaces; DEL dropped', () => {
    expect(clean('a\x00\x01\x02b')).toBe('ab')
    expect(clean('a\nb\tc\rd')).toBe('a b c d')
    expect(clean('bell\x07s')).toBe('bells')
    expect(clean('del\x7fete')).toBe('delete')
  })

  test('unterminated OSC is capped — the stream is not swallowed', () => {
    const out = clean('pre\x1b]' + 'x'.repeat(5000) + ' post')
    expect(out.startsWith('pre')).toBe(true)
    expect(out.endsWith('post')).toBe(true)
    expect(out).not.toContain('\x1b')
  })

  test('a lone trailing ESC is dropped at flush', () => {
    const s = createSanitizer()
    expect(s.push('tail\x1b') + s.flush()).toBe('tail')
  })
})

describe('sanitize: zero-width, bidi, width trickery', () => {
  test('zero-width chars stripped', () => {
    expect(clean(`a${ZWSP}${ZWNJ}${ZWJ}${WJ}${BOM}b`)).toBe('ab')
  })

  test('soft hyphen + bidi marks/overrides/isolates stripped', () => {
    expect(clean(`a${SHY}${LRM}${RLM}${LRE}${PDF}${RLO}${LRI}${PDI}${ALM}b`)).toBe('ab')
  })

  test('variation selectors and invisible tag chars stripped', () => {
    expect(clean(`a${VS16}${TAG_A}${TAG_END}b`)).toBe('ab')
  })

  test('exotic unicode spaces become plain spaces and collapse', () => {
    expect(clean(`a${NBSP}${EM_SPACE}${IDEO_SPACE} b`)).toBe('a b')
  })
})

describe('sanitize: whitespace collapse', () => {
  test('runs collapse; leading/trailing dropped', () => {
    expect(clean('  a   b \n\n c  ')).toBe('a b c')
  })

  test('collapse works across pushes', () => {
    const s = createSanitizer()
    expect(s.push('a ') + s.push('  b') + s.flush()).toBe('a b')
  })
})

describe('sanitize: think spans', () => {
  test('whole span dropped', () => {
    expect(clean('pre <think>secret plan</think> post')).toBe('pre post')
  })

  test('case-insensitive tags', () => {
    expect(clean('a<THINK>x</ThInK>b')).toBe('ab')
  })

  test('stray closer dropped, surrounding text kept', () => {
    expect(clean('keep </think> this')).toBe('keep this')
  })

  test('unclosed think drops the tail (never leaks)', () => {
    expect(clean('head <think>never ends and ends not')).toBe('head')
  })

  test('partial tag at stream end is literal text', () => {
    const s = createSanitizer()
    expect(s.push('almost <thin') + s.flush()).toBe('almost <thin')
  })

  test('lookalike tags stay literal', () => {
    expect(clean('<thinker> hi')).toBe('<thinker> hi')
    expect(clean('a < think> b')).toBe('a < think> b')
    expect(clean('<<think>x</think>ok')).toBe('<ok')
  })

  test('think span split across pieces at EVERY boundary', () => {
    const full = 'A <think>hidden words</think>B C'
    for (let cut = 1; cut < full.length; cut++) {
      const s = createSanitizer()
      const out = s.push(full.slice(0, cut)) + s.push(full.slice(cut)) + s.flush()
      expect(out).toBe('A B C')
    }
  })

  test('escape sequence split across pieces at EVERY boundary', () => {
    const full = 'X \x1b[38;5;196mY\x1b[0m Z'
    for (let cut = 1; cut < full.length; cut++) {
      const s = createSanitizer()
      const out = s.push(full.slice(0, cut)) + s.push(full.slice(cut)) + s.flush()
      expect(out).toBe('X Y Z')
    }
  })

  test('three-way piece splits of a think span', () => {
    const full = 'go <think>x</think>on'
    for (let a = 1; a < full.length - 1; a++) {
      for (let b = a + 1; b < full.length; b++) {
        const s = createSanitizer()
        const out = s.push(full.slice(0, a)) + s.push(full.slice(a, b)) + s.push(full.slice(b)) + s.flush()
        expect(out).toBe('go on')
      }
    }
  })

  test('zero-width chars cannot smuggle a tag past the filter', () => {
    expect(clean(`a<th${ZWSP}ink>secret</th${ZWSP}ink>b`)).toBe('ab')
  })
})

describe('sanitize: hostile soup stays printable', () => {
  test('no controls/escapes/invisibles survive', () => {
    const evil = `\x1b[2J<think>\x07</think>${RLO}god${PDF} \x1b]0;t\x07ok ${C1_CSI}31mfine${ZWSP} end\x1b`
    const out = sanitizeText(evil)
    for (const ch of out) {
      const c = ch.codePointAt(0)!
      expect(c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)).toBe(true)
      expect([0x200b, 0x200e, 0x200f, 0x202e, 0x202c, 0xfeff].includes(c)).toBe(false)
    }
    expect(out).toContain('ok')
    expect(out).toContain('fine')
  })

  test('clean prose passes through verbatim (minus collapse)', () => {
    const text = 'Auric Vayle crossed the indexed vaults with a brass astrolabe held high.'
    expect(clean(text)).toBe(text)
  })
})
