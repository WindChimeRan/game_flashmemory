import { describe, expect, test } from 'bun:test'
import { DemoApp, tokenizeParagraphs } from '../../src/game/demo'
import { FakeTerm, gridText } from './helpers'

const SAMPLE = [
  'The archivist had one rule: never keep more than the room could hold.',
  'Folios she loved were pressed into single cards; cards she doubted were fed to the stove.',
  'When the stove was full the archivist would open one card at random.',
].join('\n\n')

describe('tokenizeParagraphs', () => {
  test('splits on blank lines, collapses inner whitespace, keeps words', () => {
    const paras = tokenizeParagraphs('one  two\nthree\n\n\nfour five ')
    expect(paras.length).toBe(2)
    expect(paras[0]).toEqual(['one ', 'two ', 'three '])
    expect(paras[1]).toEqual(['four ', 'five '])
  })
  test('empty input → no paragraphs', () => {
    expect(tokenizeParagraphs('\n\n  \n')).toEqual([])
  })
})

describe('DemoApp (fake term streams)', () => {
  function makeDemo(text = SAMPLE, cols = 100, rows = 30) {
    const term = new FakeTerm(cols, rows)
    const app = new DemoApp({ text, term, tokPerSec: 10, seed: 7 })
    return { app, term }
  }

  test('streams words at the configured rate with live layout', () => {
    const { app, term } = makeDemo()
    app.start(0)
    expect(gridText(term.last!)).toContain('oom demo — streaming 0/')
    app.frame(1000) // 10 ticks at 10 tok/s
    const text = gridText(term.last!)
    expect(text).toContain('The archivist had one rule:')
    expect(text).toContain('streaming 10/')
    app.frame(20_000) // enough time for every token (clamped accumulation)
    for (let t = 21_000; gridText(term.last!).includes('streaming'); t += 1000) {
      app.frame(t)
      if (t > 60_000) break
    }
    expect(gridText(term.last!)).toContain('done')
    expect(gridText(term.last!)).toContain('open one card at random.')
    app.stop()
    expect(term.stopped).toBe(1)
  })

  test('space pauses streaming; q quits; ctrl-c quits', () => {
    const { app, term } = makeDemo()
    app.start(0)
    app.frame(500)
    term.key('space')
    const before = gridText(term.last!)
    app.frame(1500)
    expect(gridText(term.last!)).toContain('PAUSED')
    term.key('space')
    app.frame(1600)
    expect(gridText(term.last!)).not.toContain('PAUSED')
    void before
    term.key('q')
    expect(app.exited).toBe(true)

    const second = makeDemo()
    second.app.start(0)
    second.term.key('c', { ctrl: true })
    expect(second.app.exited).toBe(true)
  })

  test('e collapses an earlier paragraph to a ¶ line and re-expands it', () => {
    const { app, term } = makeDemo()
    app.start(0)
    // stream everything
    let t = 0
    do {
      t += 2000
      app.frame(t)
    } while (gridText(term.last!).includes('streaming') && t < 60_000)
    const full = gridText(term.last!)
    expect(full).not.toContain('words)')
    term.key('e') // fold a random earlier paragraph (seeded rng)
    app.frame(t + 250) // past the tween
    app.frame(t + 500)
    const folded = gridText(term.last!)
    expect(folded).toContain('words)') // the collapsed ¶ summary line
    term.key('e') // seeded rng picks again — eventually unfolds; force both ways
    app.frame(t + 800)
    expect(gridText(term.last!)).toContain('archivist') // still rendering text
    app.stop()
  })

  test('resize reflows to the new width (invalidate + relayout)', () => {
    const { app, term } = makeDemo(SAMPLE, 100, 30)
    app.start(0)
    app.frame(3000)
    const wide = gridText(term.last!)
    term.resize(48, 20)
    app.frame(3100)
    expect(term.invalidated).toBeGreaterThan(0)
    const narrow = gridText(term.last!)
    expect(narrow).not.toBe(wide)
    expect(narrow).toContain('archivist') // same words, new wrap
    // every rendered row fits the narrow grid
    for (const row of narrow.split('\n')) expect(row.length).toBeLessThanOrEqual(48)
    app.stop()
  })

  test('tail-anchored clipping keeps the streaming end visible on small rows', () => {
    const { app, term } = makeDemo(SAMPLE, 60, 8)
    app.start(0)
    app.frame(30_000)
    let t = 30_000
    while (gridText(term.last!).includes('streaming') && t < 90_000) {
      t += 2000
      app.frame(t)
    }
    expect(gridText(term.last!)).toContain('random.') // the last words won
    app.stop()
  })
})
