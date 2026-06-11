import { describe, expect, test } from 'bun:test'
import { TWEEN_MS, TweenRuntime, easeOutCubic, tweenPos } from '../../src/game/anim'
import type { PositionDiff } from '../../src/pretext'

describe('tween math', () => {
  test('easeOutCubic endpoints and shape', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10) // 1 − 0.5³
    expect(easeOutCubic(-1)).toBe(0) // clamped
    expect(easeOutCubic(2)).toBe(1)
    // monotone, fast early
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25)
  })

  test('tweenPos at t = 0 / 0.5 / 1', () => {
    const from = { row: 10, col: 0 }
    const to = { row: 2, col: 40 }
    expect(tweenPos(from, to, 0)).toEqual({ row: 10, col: 0 })
    expect(tweenPos(from, to, 1)).toEqual({ row: 2, col: 40 })
    const mid = tweenPos(from, to, 0.5)
    expect(mid.row).toBeCloseTo(10 + (2 - 10) * 0.875, 10)
    expect(mid.col).toBeCloseTo(40 * 0.875, 10)
  })
})

describe('TweenRuntime', () => {
  const diff: PositionDiff = {
    moved: [{ segId: 1, fromRow: 3, fromCol: 5, toRow: 4, toCol: 0 }],
    entered: [{ segId: 2, toRow: 4, toCol: 8 }],
    exited: [{ segId: 3, fromRow: 1, fromCol: 2 }],
  }

  test('addDiff registers move/enter, and exit only with target+text', () => {
    const rt = new TweenRuntime()
    rt.addDiff('c7', diff, 1000)
    expect(rt.size).toBe(2) // no exitTo → no exit tween
    rt.addDiff('c7', diff, 1000, { exitTo: { row: 0, col: 0 }, textOf: () => 'word ' })
    expect(rt.size).toBe(3)
  })

  test('whitespace-only exits are skipped', () => {
    const rt = new TweenRuntime()
    rt.addDiff('c7', diff, 0, { exitTo: { row: 0, col: 0 }, textOf: () => '  ' })
    expect(rt.size).toBe(2)
  })

  test('sample at start, mid, end positions; finished tweens prune', () => {
    const rt = new TweenRuntime()
    rt.add({ key: 'm', kind: 'move', from: { row: 10, col: 0 }, to: { row: 2, col: 40 }, startMs: 1000 })

    const s0 = rt.sample(1000).get('m')!
    expect(s0.row).toBe(10)
    expect(s0.col).toBe(0)
    expect(s0.t).toBe(0)

    const sMid = rt.sample(1000 + TWEEN_MS / 2).get('m')!
    expect(sMid.row).toBe(Math.round(10 - 8 * 0.875))
    expect(sMid.col).toBe(Math.round(40 * 0.875))

    expect(rt.sample(1000 + TWEEN_MS).has('m')).toBe(false) // t = 1 → done
    expect(rt.size).toBe(0)
  })

  test('enter tween carries t for the dim fade; exit carries its text', () => {
    const rt = new TweenRuntime(200)
    rt.add({ key: 'e', kind: 'enter', from: { row: 1, col: 1 }, to: { row: 1, col: 1 }, startMs: 0 })
    rt.add({ key: 'x', kind: 'exit', from: { row: 5, col: 9 }, to: { row: 0, col: 0 }, startMs: 0, text: 'gone ' })
    const at = rt.sample(100)
    expect(at.get('e')!.t).toBeCloseTo(0.5, 10)
    expect(at.get('e')!.row).toBe(1)
    const x = at.get('x')!
    expect(x.text).toBe('gone ')
    expect(x.row).toBeLessThan(5)
    expect(x.col).toBeLessThan(9)
  })

  test('same key re-add replaces (latest wins); clear empties', () => {
    const rt = new TweenRuntime()
    rt.add({ key: 'k', kind: 'move', from: { row: 0, col: 0 }, to: { row: 8, col: 0 }, startMs: 0 })
    rt.add({ key: 'k', kind: 'move', from: { row: 4, col: 0 }, to: { row: 6, col: 0 }, startMs: 0 })
    expect(rt.size).toBe(1)
    expect(rt.sample(0).get('k')!.row).toBe(4)
    rt.clear()
    expect(rt.size).toBe(0)
  })

  test('active() reports without pruning', () => {
    const rt = new TweenRuntime(100)
    rt.add({ key: 'a', kind: 'move', from: { row: 0, col: 0 }, to: { row: 1, col: 0 }, startMs: 50 })
    expect(rt.active(60)).toBe(true)
    expect(rt.active(151)).toBe(false)
    expect(rt.size).toBe(1) // untouched
  })

  test('exit cap bounds tweens from one diff', () => {
    const rt = new TweenRuntime()
    const big: PositionDiff = {
      moved: [],
      entered: [],
      exited: Array.from({ length: 50 }, (_, i) => ({ segId: i, fromRow: 0, fromCol: i })),
    }
    rt.addDiff('p', big, 0, { exitTo: { row: 0, col: 0 }, textOf: () => 'w ', exitCap: 10 })
    expect(rt.size).toBe(10)
  })
})
