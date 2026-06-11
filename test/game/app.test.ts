import { describe, expect, test } from 'bun:test'
import { DEFAULTS, preset, type SimConfig } from '../../src/sim'
import { MOUSE_OFF, MOUSE_ON } from '../../src/term'
import { GameApp, replaySim, type ActionLogEntry } from '../../src/game/app'
import { FakeTerm, gridRows, gridText } from './helpers'

class RawSink {
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}

function makeApp(config: SimConfig = preset('default'), seed = 7, term = new FakeTerm()) {
  const raw = new RawSink()
  const app = new GameApp({ config, seed, presetName: 'default', term, rawOut: raw })
  return { app, term, raw }
}

/** Drive frames at a fixed step; returns the final time. */
function frames(app: GameApp, fromMs: number, count: number, stepMs = 100): number {
  let t = fromMs
  for (let i = 0; i < count; i++) {
    t += stepMs
    app.frame(t)
  }
  return t
}

const drainMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0))

describe('GameApp loop', () => {
  test('start enters the term, frames map real time → sim ticks (10/s)', () => {
    const { app, term } = makeApp()
    app.start(0)
    expect(term.started).toBe(1)
    expect(app.sim.tickNow).toBe(0)
    frames(app, 0, 10, 100) // 1 s → 10 ticks
    expect(app.sim.tickNow).toBe(10)
    frames(app, 1000, 1, 50) // half a tick: accumulates, no tick yet
    expect(app.sim.tickNow).toBe(10)
    frames(app, 1050, 1, 50)
    expect(app.sim.tickNow).toBe(11)
    app.stop()
    expect(term.stopped).toBe(1)
  })

  test('a long stall is clamped (no spiral of death)', () => {
    const { app } = makeApp()
    app.start(0)
    app.frame(60_000) // 60 s gap → at most 1 s of catch-up ticks
    expect(app.sim.tickNow).toBeLessThanOrEqual(10)
  })

  test('renders the sidebar and streams prose into the story column', async () => {
    const { app, term } = makeApp()
    app.start(0)
    let t = 0
    for (let i = 0; i < 30; i++) {
      t = frames(app, t, 1, 100)
      await drainMicrotasks() // let the provider fill word buffers
    }
    const text = gridText(term.last!)
    expect(text).toContain('OOM default · seed 7')
    expect(text).toContain('MEM')
    expect(text).toContain('COLD')
    // streamed words visible: at least one scripted character name in prose
    expect(term.last!.get(0, 2).ch).toMatch(/[A-Z]/) // first header badge letter
    app.stop()
  })

  test('rejected actions flash the reason on the bottom line', async () => {
    const { app, term } = makeApp()
    app.start(0)
    let t = frames(app, 0, 5, 100)
    await drainMicrotasks()
    term.key('j') // focus the first (newest ⇒ protected) chunk
    term.key('d') // evict → sim rejects: protected
    t = frames(app, t, 2, 100)
    const bottom = gridRows(term.last!)[term.rows - 1]!
    expect(bottom).toContain('✗ protected')
    app.stop()
  })

  test('action log records submissions; replay reproduces the state hash', async () => {
    const script: Array<{ at: number; key: string }> = [
      { at: 500, key: 'j' },
      { at: 600, key: 'j' },
      { at: 900, key: 'd' },
      { at: 1500, key: 'k' },
      { at: 1600, key: 'p' },
      { at: 2500, key: 'f' },
    ]
    const run = (): { hash: number; tick: number; log: ActionLogEntry[] } => {
      const { app, term } = makeApp()
      app.start(0)
      let t = 0
      let si = 0
      while (t < 6000) {
        t = frames(app, t, 1, 100)
        while (si < script.length && script[si]!.at <= t) {
          term.key(script[si]!.key)
          si++
        }
      }
      const out = { hash: app.sim.stateHash(), tick: app.sim.tickNow, log: app.actionLog }
      app.stop()
      return out
    }
    const a = run()
    const b = run()
    expect(a.tick).toBe(60)
    expect(b.hash).toBe(a.hash) // same seed + same input timing ⇒ same state
    expect(a.log.length).toBeGreaterThan(0)
    // replay = seed + action log (hard rule 4)
    expect(replaySim(preset('default'), 7, a.log, a.tick)).toBe(a.hash)
  })

  test('pause freezes the sim and toggles mouse tracking off/on', () => {
    const { app, term, raw } = makeApp()
    app.start(0)
    frames(app, 0, 5, 100)
    term.key('space')
    expect(app.paused).toBe(true)
    expect(raw.writes[raw.writes.length - 1]).toBe(MOUSE_OFF)
    const tick = app.sim.tickNow
    frames(app, 500, 10, 100)
    expect(app.sim.tickNow).toBe(tick) // frozen
    term.key('space')
    expect(app.paused).toBe(false)
    expect(raw.writes[raw.writes.length - 1]).toBe(MOUSE_ON)
    frames(app, 1500, 2, 100)
    expect(app.sim.tickNow).toBeGreaterThan(tick)
    app.stop()
  })

  test('focus loss auto-pauses', () => {
    const { app, term } = makeApp()
    app.start(0)
    frames(app, 0, 2, 100)
    term.emit({ kind: 'focus', focused: false })
    expect(app.paused).toBe(true)
    app.stop()
  })

  test('q asks for confirmation; q-q quits; any other key cancels', () => {
    const { app, term } = makeApp()
    app.start(0)
    frames(app, 0, 2, 100)
    term.key('q')
    expect(app.confirmQuit).toBe(true)
    expect(app.exited).toBe(false)
    term.key('j') // cancels
    expect(app.confirmQuit).toBe(false)
    expect(app.exited).toBe(false)
    term.key('q')
    term.key('q')
    expect(app.exited).toBe(true)
    expect(app.exitCode).toBe(0)
  })

  test('ctrl-c quits immediately', () => {
    const { app, term } = makeApp()
    app.start(0)
    term.key('c', { ctrl: true })
    expect(app.exited).toBe(true)
  })

  test('wheel and click change focus via the last geometry', async () => {
    const { app, term } = makeApp()
    app.start(0)
    frames(app, 0, 10, 100)
    await drainMicrotasks()
    term.emit({ kind: 'wheel', dir: 'down', col: 10, row: 5 })
    expect(app.focusId).not.toBeNull()
    const first = app.focusId
    term.emit({ kind: 'mouse', action: 'press', button: 0, col: 5, row: 0 })
    expect(app.focusId).toBe(first) // header of the first block is row 0
    app.stop()
  })

  test('too-small terminal shows the friendly message and pauses the sim', () => {
    const term = new FakeTerm(80, 24)
    const { app } = makeApp(preset('default'), 7, term)
    app.start(0)
    frames(app, 0, 5, 100)
    expect(app.sim.tickNow).toBe(0)
    expect(gridText(term.last!)).toContain('minimum 100×30 — current 80×24')
    term.resize(120, 32)
    frames(app, 500, 5, 100)
    expect(app.sim.tickNow).toBe(5) // resumed
    app.stop()
  })

  test('resize triggers invalidate and reflow without crashing', async () => {
    const { app, term } = makeApp()
    app.start(0)
    let t = frames(app, 0, 20, 100)
    await drainMicrotasks()
    const before = term.invalidated
    term.resize(140, 40)
    expect(term.invalidated).toBe(before + 1)
    frames(app, t, 5, 100)
    expect(gridText(term.last!)).toContain('OOM')
    app.stop()
  })
})

describe('warp fast-forward', () => {
  test('warp runs ticks instantly, logs caretaker actions, replay still exact', () => {
    const term = new FakeTerm()
    const app = new GameApp({ config: preset('default'), seed: 7, term, rawOut: null, warpTicks: 300 })
    app.start(0)
    expect(app.sim.tickNow).toBe(300)
    expect(app.over).toBeNull()
    expect(app.actionLog.length).toBeGreaterThan(0) // caretaker evictions recorded
    expect(replaySim(preset('default'), 7, app.actionLog, 300)).toBe(app.sim.stateHash())
    app.stop()
  })

  test('two warped apps agree (warp is deterministic)', () => {
    const mk = () => {
      const app = new GameApp({ config: preset('default'), seed: 9, term: new FakeTerm(), rawOut: null, warpTicks: 200 })
      app.start(0)
      const h = app.sim.stateHash()
      app.stop()
      return h
    }
    expect(mk()).toBe(mk())
  })
})

describe('death and restart', () => {
  // A viewport this tight OOMs within the first chunks (admission failure).
  const tightCfg: SimConfig = { ...DEFAULTS, viewportLines: 8, roundTicks: 600 }

  test('death freezes the sim and shows the attribution + Pareto screen', async () => {
    const { app, term } = makeApp(tightCfg, 11)
    app.start(0)
    let t = 0
    for (let i = 0; i < 300 && app.over === null; i++) {
      t = frames(app, t, 1, 100)
      await drainMicrotasks()
    }
    expect(app.over).not.toBeNull()
    expect(app.over!.kind).toBe('oom')
    const text = gridText(term.last!)
    expect(text).toContain('OUT OF MEMORY')
    expect(text).toContain('SCORE')
    expect(text).toContain('FM-DS-V4')
    expect(text).toContain('Recency-Only')
    const frozen = app.sim.tickNow
    frames(app, t, 5, 100)
    expect(app.sim.tickNow).toBe(frozen)
    app.stop()
  })

  test('r restarts the same seed; q quits from the over screen', async () => {
    const { app, term } = makeApp(tightCfg, 11)
    app.start(0)
    let t = 0
    for (let i = 0; i < 300 && app.over === null; i++) t = frames(app, t, 1, 100)
    expect(app.over).not.toBeNull()
    term.key('f') // ignored on the over screen
    expect(app.over).not.toBeNull()
    term.key('r')
    expect(app.over).toBeNull()
    expect(app.sim.tickNow).toBe(0)
    expect(app.actionLog.length).toBe(0)
    t = frames(app, t, 3, 100)
    expect(app.sim.tickNow).toBe(3)
    // die again, then quit from the over screen
    for (let i = 0; i < 300 && app.over === null; i++) t = frames(app, t, 1, 100)
    term.key('q')
    expect(app.exited).toBe(true)
    app.stop()
  })

  test('surviving the round shows the triumphant screen', () => {
    const cfg: SimConfig = { ...DEFAULTS, roundTicks: 40 }
    const { app, term } = makeApp(cfg, 3)
    app.start(0)
    let t = 0
    for (let i = 0; i < 60 && app.over === null; i++) t = frames(app, t, 1, 100)
    expect(app.over).not.toBeNull()
    expect(app.over!.kind).toBe('survived')
    expect(gridText(term.last!)).toContain('ROUND SURVIVED')
    app.stop()
  })
})
