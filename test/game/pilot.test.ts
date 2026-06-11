/**
 * Pilot mode (--pilot): a roster bot sources the ACTIONS each tick inside
 * the playable app, with the headless runner's per-tick ordering
 * (bot.act(view) → sim.tick). Determinism law under test: with the
 * scripted provider, app-side pilot ticking reproduces bots/runner.ts
 * exactly — same bot + seed + config ⇒ same stateHash at the same tick
 * (prose layer aside). Keyboard shrinks to ␣ pause / q-q quit, and the
 * bottom bar carries an honest PILOT tag.
 */

import { describe, expect, test } from 'bun:test'
import { createSim, preset, type SimConfig } from '../../src/sim'
import { makeBot, runRoundDetailed } from '../../src/bots'
import { GameApp, replaySim, type PilotSpec } from '../../src/game/app'
import { FakeTerm, gridRows, gridText } from './helpers'

/** bots/runner.ts's exact per-tick loop, stopped at `ticks` (trackWaves off). */
function runnerSimAt(config: SimConfig, seed: number, botName: string, ticks: number): number {
  const bot = makeBot(botName)
  bot.configure?.(config)
  bot.reset(seed)
  const sim = createSim(config, seed)
  for (let i = 0; i < ticks && !sim.done; i++) {
    const oracle = bot.wantsOracle === true ? sim.oracleView() : null
    sim.tick(bot.act(oracle ?? sim.view(), oracle))
  }
  return sim.stateHash()
}

function pilotApp(botName: string, seed: number, opts: { warpTicks?: number } = {}): { app: GameApp; term: FakeTerm } {
  const term = new FakeTerm()
  const pilot: PilotSpec = { name: botName, bot: makeBot(botName) }
  const app = new GameApp({
    config: preset('default'),
    seed,
    presetName: 'default',
    term,
    rawOut: null,
    pilot,
    warpTicks: opts.warpTicks ?? 0,
  })
  return { app, term }
}

/** Drive frames at a fixed step; 100 ms = exactly 1 tick on default preset. */
function frames(app: GameApp, fromMs: number, count: number, stepMs = 100): number {
  let t = fromMs
  for (let i = 0; i < count; i++) {
    t += stepMs
    app.frame(t)
  }
  return t
}

describe('pilot determinism (hard rule 4 extended to the pilot seat)', () => {
  test('the manual runner loop matches runRoundDetailed for a full round', () => {
    // proves runnerSimAt is a faithful reimplementation before we lean on it
    const config = preset('default')
    const detail = runRoundDetailed(config, 7, makeBot('par'))
    const ticks = detail.result.ticksSurvived
    expect(runnerSimAt(config, 7, 'par', ticks + 16)).toBe(detail.finalHash)
  })

  test('app-side pilot ticking matches the headless runner at tick 300 (par)', () => {
    const { app } = pilotApp('par', 7)
    app.start(0)
    frames(app, 0, 300, 100)
    expect(app.sim.tickNow).toBe(300)
    expect(app.over).toBeNull()
    expect(app.sim.stateHash()).toBe(runnerSimAt(preset('default'), 7, 'par', 300))
    // replay proof: seed + recorded action log reproduces the same state
    expect(replaySim(preset('default'), 7, app.actionLog, 300)).toBe(app.sim.stateHash())
    app.stop()
  })

  test('two pilot apps agree with each other and the runner (seed 11)', () => {
    const run = (): number => {
      const { app } = pilotApp('par', 11)
      app.start(0)
      frames(app, 0, 300, 100)
      const h = app.sim.stateHash()
      app.stop()
      return h
    }
    const a = run()
    expect(run()).toBe(a)
    expect(a).toBe(runnerSimAt(preset('default'), 11, 'par', 300))
  })

  test('an oracle pilot gets the oracle view (wantsOracle path) and still matches', () => {
    const { app } = pilotApp('oracle', 7)
    app.start(0)
    frames(app, 0, 120, 100)
    expect(app.sim.tickNow).toBe(120)
    expect(app.sim.stateHash()).toBe(runnerSimAt(preset('default'), 7, 'oracle', 120))
    app.stop()
  })

  test('warp + pilot: the bot flies the warp too — still the runner trajectory', () => {
    const { app } = pilotApp('par', 7, { warpTicks: 200 })
    app.start(0)
    expect(app.sim.tickNow).toBe(200)
    expect(app.sim.stateHash()).toBe(runnerSimAt(preset('default'), 7, 'par', 200))
    frames(app, 0, 100, 100) // keep flying in real time
    expect(app.sim.tickNow).toBe(300)
    expect(app.sim.stateHash()).toBe(runnerSimAt(preset('default'), 7, 'par', 300))
    app.stop()
  })
})

describe('pilot UI and input', () => {
  test('the bottom bar renders the honest PILOT tag with the reduced keys', () => {
    const { app, term } = pilotApp('par', 7)
    app.start(0)
    frames(app, 0, 5, 100)
    const bottom = gridRows(term.last!)[term.rows - 1]!
    expect(bottom).toContain('PILOT par')
    expect(bottom).toContain('␣·pause q·quit')
    expect(bottom).not.toContain('j/k to focus a chunk') // human hint suppressed
    expect(gridText(term.last!)).not.toContain('f·fetch') // gameplay keys gone
    app.stop()
  })

  test('gameplay keys are inert; ␣ pauses and q-q quits', () => {
    const { app, term } = pilotApp('par', 7)
    app.start(0)
    frames(app, 0, 10, 100)
    term.key('j') // focus nav — inert in pilot mode
    term.key('k')
    expect(app.focusId).toBeNull()
    term.key('f') // would queue an action (and flash) for a human — inert
    term.key('d')
    term.key('p')
    frames(app, 1000, 2, 100)
    const bottom = gridRows(term.last!)[term.rows - 1]!
    expect(bottom).not.toContain('no chunk focused')
    // pause still works
    term.key('space')
    expect(app.paused).toBe(true)
    const tick = app.sim.tickNow
    frames(app, 1200, 5, 100)
    expect(app.sim.tickNow).toBe(tick) // frozen — the bot does not act either
    term.key('space')
    expect(app.paused).toBe(false)
    // q-q quits; an inert key does NOT cancel the confirm (only ␣/q react)
    term.key('q')
    expect(app.confirmQuit).toBe(true)
    term.key('j')
    expect(app.confirmQuit).toBe(true)
    term.key('q')
    expect(app.exited).toBe(true)
    app.stop()
  })

  test('pilot actions land in the action log (replays stay exact)', () => {
    const { app } = pilotApp('par', 7)
    app.start(0)
    frames(app, 0, 300, 100)
    expect(app.actionLog.length).toBeGreaterThan(0) // par acts within 300 ticks
    for (const e of app.actionLog) {
      expect(e.actions.length).toBeGreaterThan(0)
      expect(e.tick).toBeGreaterThan(0)
      expect(e.tick).toBeLessThanOrEqual(300)
    }
    app.stop()
  })
})
