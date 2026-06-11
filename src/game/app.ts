/**
 * app — the playable loop (composition root).
 *
 * Time model (D3 + hard rule 4): a fixed-tick accumulator maps real time →
 * sim ticks at config.ticksPerSec; wall-clock NEVER enters the sim — only
 * the derived tick count does. Rendering runs at ≤ 30 fps on its own clock
 * (the tween clock). Replays = seed + per-tick action log (recorded in
 * memory each round; replaySim() re-derives the same state hash).
 *
 * Input: ↑/↓ or j/k focus prev/next (viewport order then rail); letter =
 * jump to next chunk of that glyph (wraps; shift+letter always glyph-jumps
 * when the lowercase letter is bound to a verb); f = up-tier (prefetch),
 * d = down-tier (evict), p = pin, space = pause, q = quit (q again
 * confirms). Mouse: click header/chip = focus, wheel = focus prev/next.
 * Pause drops mouse tracking so prose can be selected/copied — the term
 * API has no runtime mouse toggle, so the app writes MOUSE_OFF/ON straight
 * to the output stream (friction noted; full stop()/start() would blank
 * the alt screen and hide the very prose the player wants to copy).
 * Focus loss auto-pauses. Rejected actions flash their reason.
 */

import {
  createSim,
  type Action,
  type RejectReason,
  type Sim,
  type SimConfig,
  type SimView,
} from '../sim'
import { MOUSE_OFF, MOUSE_ON, createTerm, type InputEvent, type KeyEvent, type Term } from '../term'
import { ScriptedProvider } from '../content/scripted'
import type { ContentProvider } from '../content/types'
import { TweenRuntime, type Pt, type TweenSample } from './anim'
import { ProseStore } from './prose'
import {
  MIN_COLS,
  MIN_ROWS,
  computeGeometry,
  isInline,
  proseWidth,
  renderScreen,
  type Geometry,
  type OverState,
  type ProseView,
  type ScreenState,
} from './screen'

// ── input mapping (pure, table-tested) ───────────────────────────────────

export type UiCmd =
  | { t: 'prev' }
  | { t: 'next' }
  | { t: 'up' }
  | { t: 'down' }
  | { t: 'pin' }
  | { t: 'pause' }
  | { t: 'quit' }
  | { t: 'quit-now' }
  | { t: 'restart' }
  | { t: 'glyph'; g: string }

/** Lowercase letters bound to verbs (shadowed glyphs need shift+letter). */
export const BOUND_LETTERS = new Set(['j', 'k', 'f', 'd', 'p', 'q', 'r'])

export function mapKey(e: KeyEvent): UiCmd | null {
  if (e.ctrl) return e.name === 'c' ? { t: 'quit-now' } : null
  switch (e.name) {
    case 'up':
      return { t: 'prev' }
    case 'down':
      return { t: 'next' }
    case 'space':
      return { t: 'pause' }
    case 'escape':
      return { t: 'pause' }
    default:
      break
  }
  if (e.name.length !== 1 || e.name < 'a' || e.name > 'z') return null
  if (e.shift) return { t: 'glyph', g: e.name.toUpperCase() } // always a glyph jump
  switch (e.name) {
    case 'j':
      return { t: 'next' }
    case 'k':
      return { t: 'prev' }
    case 'f':
      return { t: 'up' }
    case 'd':
      return { t: 'down' }
    case 'p':
      return { t: 'pin' }
    case 'q':
      return { t: 'quit' }
    case 'r':
      return { t: 'restart' }
    default:
      return { t: 'glyph', g: e.name.toUpperCase() }
  }
}

/** Focus order: viewport (inline) chunks in spawn order, then rail chips. */
export function focusOrder(view: SimView): number[] {
  const inline: number[] = []
  const rail: number[] = []
  for (const c of view.chunks) (isInline(c) ? inline : rail).push(c.id)
  return inline.concat(rail)
}

/** Next focus in direction dir (±1), wrapping; null when nothing exists. */
export function nextFocus(view: SimView, cur: number | null, dir: 1 | -1): number | null {
  const order = focusOrder(view)
  if (order.length === 0) return null
  const idx = cur === null ? -1 : order.indexOf(cur)
  if (idx < 0) return dir === 1 ? order[0]! : order[order.length - 1]!
  return order[(idx + dir + order.length) % order.length]!
}

/** Jump to the next chunk of `glyph` after the current focus (wraps). */
export function glyphJump(view: SimView, cur: number | null, glyph: string): number | null {
  const order = focusOrder(view)
  if (order.length === 0) return null
  const byId = new Map(view.chunks.map((c) => [c.id, c]))
  const start = cur === null ? -1 : order.indexOf(cur)
  for (let k = 1; k <= order.length; k++) {
    const id = order[(start + k) % order.length]!
    if (byId.get(id)?.glyph === glyph) return id
  }
  return null
}

export const REJECT_TEXT: Record<RejectReason, string> = {
  'no-such-chunk': 'no such chunk',
  protected: 'protected — newest chunks are untouchable',
  pinned: 'pinned — unpin first',
  transferring: 'committed — transfer in flight',
  'at-top': 'already expanded',
  'at-bottom': 'already a chip',
  'bus-full': 'bus full',
  'no-headroom': 'no headroom — evict something first',
  'action-budget': 'action budget spent',
}

// ── replay (hard rule 4) ─────────────────────────────────────────────────

export interface ActionLogEntry {
  readonly tick: number
  readonly actions: readonly Action[]
}

/** Re-run seed + action log; returns the final state hash (replay proof). */
export function replaySim(
  config: SimConfig,
  seed: number,
  log: readonly ActionLogEntry[],
  untilTick?: number,
): number {
  const sim = createSim(config, seed)
  const byTick = new Map<number, readonly Action[]>()
  for (const e of log) byTick.set(e.tick, e.actions)
  const stop = untilTick ?? Infinity
  while (!sim.done && sim.tickNow < stop) {
    sim.tick(byTick.get(sim.tickNow + 1) ?? [])
  }
  return sim.stateHash()
}

// ── the app ──────────────────────────────────────────────────────────────

const FLASH_MS = 1400
const MAX_QUEUE = 8
const MISS_CORRUPT_TICKS = 15

export interface GameAppOptions {
  config: SimConfig
  seed: number
  presetName?: string
  term?: Term
  provider?: ContentProvider
  /** Raw escape-sequence sink for the pause mouse toggle (default: none
   *  when a term is injected, process.stdout otherwise). */
  rawOut?: { write(s: string): boolean } | null
}

export class GameApp {
  readonly term: Term
  readonly config: SimConfig
  readonly seed: number
  sim: Sim
  exited = false
  exitCode = 0
  paused = false
  confirmQuit = false
  focusId: number | null = null
  over: OverState | null = null
  actionLog: ActionLogEntry[] = []
  /** Previous round's log (kept when r restarts). */
  lastActionLog: ActionLogEntry[] | null = null

  private readonly presetName: string
  private readonly provider: ContentProvider
  private readonly rawOut: { write(s: string): boolean } | null
  private readonly ownsTerm: boolean
  private prose: ProseStore
  private readonly tweens = new TweenRuntime()
  private pending: Action[] = []
  private flashText: string | null = null
  private flashUntil = 0
  private corruptUntilTick = -1
  private accMs = 0
  private lastMs: number | null = null
  private lastGeo: Geometry | null = null
  private unsub: (() => void) | null = null

  constructor(opts: GameAppOptions) {
    this.config = opts.config
    this.seed = opts.seed
    this.presetName = opts.presetName ?? 'default'
    this.ownsTerm = opts.term === undefined
    this.term = opts.term ?? createTerm({ mouse: true })
    this.provider = opts.provider ?? new ScriptedProvider()
    this.rawOut =
      opts.rawOut !== undefined ? opts.rawOut : this.ownsTerm ? process.stdout : null
    this.sim = createSim(this.config, this.seed)
    this.prose = new ProseStore(this.provider, proseWidth(this.term.cols))
  }

  start(nowMs: number): void {
    this.term.start()
    this.unsub = this.term.onInput((e) => this.handleInput(e))
    this.frame(nowMs)
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    this.term.stop()
  }

  get tooSmall(): boolean {
    return this.term.cols < MIN_COLS || this.term.rows < MIN_ROWS
  }

  // ── frame loop ────────────────────────────────────────────────────────

  frame(nowMs: number): void {
    if (this.exited) return
    const dt = this.lastMs === null ? 0 : Math.max(0, nowMs - this.lastMs)
    this.lastMs = nowMs
    if (!this.paused && this.over === null && !this.tooSmall) {
      this.accMs = Math.min(1000, this.accMs + dt)
      const tickMs = 1000 / this.config.ticksPerSec
      while (this.accMs >= tickMs && !this.sim.done) {
        this.accMs -= tickMs
        this.runTick(nowMs)
      }
    }
    if (this.flashText !== null && nowMs >= this.flashUntil) this.flashText = null
    const state = this.buildState(this.tweens.sample(nowMs))
    this.term.flush(renderScreen(state))
    this.lastGeo = state.tooSmall ? null : computeGeometry(state)
  }

  /** One sim tick + event → tween/effect wiring. nowMs is the render clock. */
  private runTick(nowMs: number): void {
    const beforeState = this.buildState(null)
    const beforeGeo = computeGeometry(beforeState)
    const beforeTops = new Map(beforeGeo.blocks.map((b) => [b.id, b.top]))
    const beforeView = beforeState.view

    const actions = this.pending.splice(0, this.config.actionBudget)
    const ev = this.sim.tick(actions)
    const tick = this.sim.tickNow
    if (actions.length > 0) this.actionLog.push({ tick, actions })

    if (ev.rejected.length > 0) this.flash(REJECT_TEXT[ev.rejected[0]!.reason], nowMs)

    for (const id of ev.spawned) this.prose.ensure(this.sim.chunkSpec(id))

    // collapse animations: expanded chunks that tiered down this tick
    for (const a of ev.accepted) {
      if (a.kind !== 'down') continue
      const was = beforeView.chunks[a.chunkId]
      if (!was) continue
      if (was.tier === 2) this.collapseExits(a.chunkId, beforeGeo, nowMs)
      else if (was.tier === 1) this.headerExit(a.chunkId, beforeGeo, nowMs)
    }
    // arrivals to expanded: prose enters (fade-in)
    for (const arr of ev.arrivals) {
      if (arr.tier !== 2) continue
      const prose = this.prose.get(arr.chunkId)
      if (!prose) continue
      let n = 0
      for (let li = 0; li < prose.layout.lines.length && n < 40; li++) {
        for (const pl of prose.layout.lines[li]!.placements) {
          if (n >= 40) break
          this.tweens.add({
            key: `c${arr.chunkId}s${pl.segId}`,
            kind: 'enter',
            from: { row: li, col: pl.col },
            to: { row: li, col: pl.col },
            startMs: nowMs,
          })
          n++
        }
      }
    }

    // streaming reveal (the signature reflow) — sync prose to tokensShown
    const view = this.sim.view()
    for (const c of view.chunks) {
      const prose = this.prose.get(c.id)
      if (!prose || prose.revealed >= c.tokensShown) continue
      const diff = this.prose.sync(c.id, c.tokensShown)
      if (diff && c.tier === 2) this.tweens.addDiff(`c${c.id}`, diff, nowMs)
    }

    // wave outcomes: miss → corrupt the incoming stream + flash coherence
    for (const r of ev.resolved) {
      if (!r.cleared) {
        this.corruptUntilTick = tick + MISS_CORRUPT_TICKS
        this.flash(`wave missed — coherence ${r.coherenceDelta.toFixed(0)}`, nowMs)
      }
    }

    if (ev.death) {
      this.over = { kind: ev.death.cause, summary: ev.death.summary, result: this.sim.result() }
    } else if (this.sim.done) {
      const res = this.sim.result()
      this.over = {
        kind: 'survived',
        summary: `the stream ended and coherence held — ${res.waves.length} waves served, mean recall ${res.meanCredit.toFixed(2)}`,
        result: res,
      }
    }

    // whole-block FLIP: any inline chunk whose top moved slides there
    const afterGeo = computeGeometry(this.buildState(null))
    for (const b of afterGeo.blocks) {
      const prev = beforeTops.get(b.id)
      if (prev !== undefined && prev !== b.top) {
        this.tweens.add({
          key: `b${b.id}`,
          kind: 'move',
          from: { row: prev, col: 0 },
          to: { row: b.top, col: 0 },
          startMs: nowMs,
        })
      }
    }
  }

  /** Word segments of a collapsing chunk fly to its badge (exit tweens). */
  private collapseExits(id: number, geo: Geometry, nowMs: number): void {
    const prose = this.prose.get(id)
    const block = geo.blocks.find((b) => b.id === id)
    if (!prose || !block) return
    const target: Pt = { row: block.top, col: block.badgeCol }
    let n = 0
    for (let li = 0; li < prose.layout.lines.length && n < 24; li++) {
      for (const pl of prose.layout.lines[li]!.placements) {
        if (n >= 24) break
        const text = prose.textOf(pl.segId)
        if (text.trim() === '') continue
        this.tweens.add({
          key: `c${id}x${pl.segId}`,
          kind: 'exit',
          from: { row: block.top + 1 + li, col: geo.proseLeft + pl.col },
          to: target,
          startMs: nowMs,
          text,
        })
        n++
      }
    }
  }

  /** A summary header folding into its rail chip (badge flies right). */
  private headerExit(id: number, geo: Geometry, nowMs: number): void {
    const block = geo.blocks.find((b) => b.id === id)
    if (!block) return
    const glyph = this.sim.view().chunks[id]?.glyph ?? '?'
    this.tweens.add({
      key: `c${id}xh`,
      kind: 'exit',
      from: { row: block.top, col: block.badgeCol },
      to: { row: geo.storyRows - 2, col: geo.sidebarX + 1 },
      startMs: nowMs,
      text: glyph,
    })
  }

  // ── input ─────────────────────────────────────────────────────────────

  handleInput(e: InputEvent): void {
    if (this.exited) return
    const nowMs = this.lastMs ?? 0
    switch (e.kind) {
      case 'resize': {
        this.term.invalidate()
        const diffs = this.prose.setWidth(proseWidth(e.cols))
        const view = this.sim.view()
        for (const [id, diff] of diffs) {
          const c = view.chunks[id]
          if (c && c.tier === 2) this.tweens.addDiff(`c${id}`, diff, nowMs)
        }
        return
      }
      case 'focus':
        if (!e.focused && !this.paused && this.over === null) this.setPaused(true)
        return
      case 'wheel':
        this.focusId = nextFocus(this.sim.view(), this.focusId, e.dir === 'up' ? -1 : 1)
        return
      case 'mouse':
        if (e.action === 'press' && e.button === 0) this.click(e.row, e.col)
        return
      case 'paste':
        return
      case 'key':
        this.handleKey(e, nowMs)
        return
    }
  }

  private handleKey(e: KeyEvent, nowMs: number): void {
    const cmd = mapKey(e)
    if (cmd?.t === 'quit-now') {
      this.exit(0)
      return
    }
    if (this.over) {
      if (cmd?.t === 'restart') this.restart()
      else if (cmd?.t === 'quit') this.exit(0)
      return
    }
    if (this.confirmQuit) {
      this.confirmQuit = false
      if (cmd?.t === 'quit') this.exit(0)
      else this.flash('quit cancelled', nowMs)
      return // the cancelling key is swallowed
    }
    if (cmd === null) return
    const view = this.sim.view()
    switch (cmd.t) {
      case 'prev':
        this.focusId = nextFocus(view, this.focusId, -1)
        break
      case 'next':
        this.focusId = nextFocus(view, this.focusId, 1)
        break
      case 'glyph': {
        const id = glyphJump(view, this.focusId, cmd.g)
        if (id === null) this.flash(`no [${cmd.g}] chunk`, nowMs)
        else this.focusId = id
        break
      }
      case 'up':
      case 'down':
      case 'pin':
        this.queueAction(cmd.t, nowMs)
        break
      case 'pause':
        this.setPaused(!this.paused)
        break
      case 'quit':
        this.confirmQuit = true
        break
      case 'restart':
        break // only meaningful on the over screen
    }
  }

  private queueAction(kind: 'up' | 'down' | 'pin', nowMs: number): void {
    if (this.focusId === null) {
      this.flash('no chunk focused — j/k to focus', nowMs)
      return
    }
    if (this.pending.length >= MAX_QUEUE) {
      this.flash('action queue full', nowMs)
      return
    }
    this.pending.push({ kind, chunkId: this.focusId })
  }

  private click(row: number, col: number): void {
    const geo = this.lastGeo
    if (!geo) return
    if (col < geo.borderCol) {
      for (const b of geo.blocks) {
        if (row >= b.top && row < b.top + b.height) {
          this.focusId = b.id
          return
        }
      }
      return
    }
    for (const cell of geo.rail) {
      if (cell.row === row && (cell.col === col || cell.col + 1 === col)) {
        this.focusId = cell.id
        return
      }
    }
  }

  private setPaused(p: boolean): void {
    if (this.paused === p) return
    this.paused = p
    // No runtime mouse toggle in the Term API — write the mode switch
    // directly so the player can select/copy prose while paused.
    this.rawOut?.write(p ? MOUSE_OFF : MOUSE_ON)
  }

  private restart(): void {
    this.lastActionLog = this.actionLog
    this.actionLog = []
    this.sim = createSim(this.config, this.seed)
    this.prose = new ProseStore(this.provider, proseWidth(this.term.cols))
    this.tweens.clear()
    this.pending = []
    this.focusId = null
    this.over = null
    this.confirmQuit = false
    this.corruptUntilTick = -1
    this.accMs = 0
  }

  private exit(code: number): void {
    this.exited = true
    this.exitCode = code
  }

  private flash(text: string, nowMs: number): void {
    this.flashText = text
    this.flashUntil = nowMs + FLASH_MS
  }

  // ── state assembly ────────────────────────────────────────────────────

  private buildState(tweens: ReadonlyMap<string, TweenSample> | null): ScreenState {
    const view = this.sim.view()
    const prose = new Map<number, ProseView>()
    for (const c of view.chunks) {
      const p = this.prose.get(c.id)
      if (p) prose.set(c.id, { layout: p.layout, textOf: p.textOf })
    }
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      view,
      prose,
      focusId: this.focusId,
      paused: this.paused,
      flash: this.flashText,
      confirmQuit: this.confirmQuit,
      corruptUntilTick: this.corruptUntilTick,
      tweens,
      title: `${this.presetName} · seed ${this.seed}`,
      ticksPerSec: this.config.ticksPerSec,
      over: this.over,
      tooSmall: this.tooSmall,
    }
  }
}

/** Real-time driver: ≤ 30 fps frames until the app exits. */
export async function runGame(opts: GameAppOptions): Promise<number> {
  const app = new GameApp(opts)
  app.start(performance.now())
  return await new Promise<number>((resolve) => {
    const iv = setInterval(() => {
      app.frame(performance.now())
      if (app.exited) {
        clearInterval(iv)
        app.stop()
        resolve(app.exitCode)
      }
    }, 33)
  })
}
