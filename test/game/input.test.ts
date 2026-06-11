import { describe, expect, test } from 'bun:test'
import type { SimView } from '../../src/sim'
import type { KeyEvent } from '../../src/term'
import { focusOrder, glyphJump, mapKey, nextFocus, REJECT_TEXT, type UiCmd } from '../../src/game/app'
import { chunk, simView } from './helpers'

const key = (name: string, mods: Partial<KeyEvent> = {}): KeyEvent =>
  ({ kind: 'key', name, ctrl: false, alt: false, shift: false, seq: name, ...mods }) as KeyEvent

describe('mapKey table', () => {
  const cases: Array<[string, Partial<KeyEvent>, UiCmd | null]> = [
    ['up', {}, { t: 'prev' }],
    ['down', {}, { t: 'next' }],
    ['k', {}, { t: 'prev' }],
    ['j', {}, { t: 'next' }],
    ['f', {}, { t: 'up' }],
    ['d', {}, { t: 'down' }],
    ['p', {}, { t: 'pin' }],
    ['space', {}, { t: 'pause' }],
    ['escape', {}, { t: 'pause' }],
    ['q', {}, { t: 'quit' }],
    ['r', {}, { t: 'restart' }],
    // unbound letters jump to that glyph
    ['a', {}, { t: 'glyph', g: 'A' }],
    ['x', {}, { t: 'glyph', g: 'X' }],
    // shift+letter ALWAYS glyph-jumps, even for verb-bound letters
    ['f', { shift: true }, { t: 'glyph', g: 'F' }],
    ['d', { shift: true }, { t: 'glyph', g: 'D' }],
    ['q', { shift: true }, { t: 'glyph', g: 'Q' }],
    // ctrl-c quits immediately; other ctrl chords are ignored
    ['c', { ctrl: true }, { t: 'quit-now' }],
    ['d', { ctrl: true }, null],
    // unmapped keys
    ['enter', {}, null],
    ['1', {}, null],
    ['f1', {}, null],
  ]
  for (const [name, mods, want] of cases) {
    test(`${JSON.stringify(mods)} ${name} → ${want ? want.t : 'null'}`, () => {
      expect(mapKey(key(name, mods))).toEqual(want as never)
    })
  }
})

describe('focus order and movement', () => {
  // viewport order (inline: expanded/summary/transferring) then rail (chips)
  const view: SimView = simView({
    chunks: [
      chunk({ id: 0, glyph: 'A', tier: 0 }), // chip → rail
      chunk({ id: 1, glyph: 'B', tier: 2 }),
      chunk({ id: 2, glyph: 'A', tier: 1 }),
      chunk({ id: 3, glyph: 'C', tier: 0, transfer: { toTier: 1, startTick: 0, arriveTick: 40 } }),
      chunk({ id: 4, glyph: 'B', tier: 0 }), // chip → rail
    ],
  })

  test('focusOrder = inline ids then rail ids, both in spawn order', () => {
    expect(focusOrder(view)).toEqual([1, 2, 3, 0, 4])
  })

  test('nextFocus walks the order and wraps both ways', () => {
    expect(nextFocus(view, null, 1)).toBe(1)
    expect(nextFocus(view, 1, 1)).toBe(2)
    expect(nextFocus(view, 4, 1)).toBe(1) // wrap forward
    expect(nextFocus(view, 1, -1)).toBe(4) // wrap backward
    expect(nextFocus(view, null, -1)).toBe(4)
    expect(nextFocus(simView({ chunks: [] }), null, 1)).toBeNull()
  })

  test('glyphJump finds the next chunk of the glyph and wraps', () => {
    expect(glyphJump(view, 1, 'A')).toBe(2)
    expect(glyphJump(view, 2, 'A')).toBe(0) // next A is the chip on the rail
    expect(glyphJump(view, 0, 'A')).toBe(2) // wraps around past the end
    expect(glyphJump(view, null, 'B')).toBe(1)
    expect(glyphJump(view, 1, 'B')).toBe(4)
    expect(glyphJump(view, 4, 'B')).toBe(1) // wrap
    expect(glyphJump(view, 1, 'Z')).toBeNull() // no such glyph
  })

  test('glyphJump with a single match returns it from itself (wraps fully)', () => {
    expect(glyphJump(view, 3, 'C')).toBe(3)
  })
})

describe('reject reasons', () => {
  test('every sim RejectReason has a flash text', () => {
    const reasons = [
      'no-such-chunk',
      'protected',
      'pinned',
      'transferring',
      'at-top',
      'at-bottom',
      'bus-full',
      'no-headroom',
      'action-budget',
    ] as const
    for (const r of reasons) {
      expect(REJECT_TEXT[r].length).toBeGreaterThan(0)
    }
  })
})
