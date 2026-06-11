/**
 * demo — Stage 0 exit criterion (`oom demo <file.md>`).
 *
 * Streams the file's words into the viewport at ~14 tok/s with live
 * incremental reflow (pretext append + layout + positions → FLIP tweens),
 * handles resize reflow, and exposes a toy tier toggle: `e` collapses or
 * re-expands a random earlier paragraph, exercising the same fold/unfold
 * animation the game uses. No sim — just pretext + term + anim.
 */

import { createTerm, ATTR_BOLD, ATTR_DIM, ATTR_NONE, type Grid, type InputEvent, type Term } from '../term'
import { createGrid } from '../term'
import { makeRng, type Rng } from '../sim'
import { cellWidth, graphemes } from '../shared/width'
import { TweenRuntime, type TweenSample } from './anim'
import { ChunkProse } from './prose'
import { sliceCells } from './screen'
import { UI } from './theme'

export const DEMO_TOK_PER_SEC = 14

interface Para {
  readonly words: readonly string[]
  readonly prose: ChunkProse
  collapsed: boolean
}

/** Blank-line-separated paragraphs → word streams (trailing-space pieces). */
export function tokenizeParagraphs(text: string): string[][] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p !== '')
    .map((p) => p.split(' ').map((w) => `${w} `))
}

export interface DemoOptions {
  text: string
  term?: Term
  tokPerSec?: number
  seed?: number
}

export class DemoApp {
  readonly term: Term
  exited = false
  exitCode = 0
  paused = false

  private readonly paras: Para[] = []
  private readonly allWords: string[][]
  private readonly tweens = new TweenRuntime()
  private readonly rng: Rng
  private readonly tokPerSec: number
  private streamedTokens = 0
  private readonly totalTokens: number
  private startedParas = 0
  private accMs = 0
  private lastMs: number | null = null
  private unsub: (() => void) | null = null
  private readonly ownsTerm: boolean

  constructor(opts: DemoOptions) {
    this.ownsTerm = opts.term === undefined
    this.term = opts.term ?? createTerm({})
    this.allWords = tokenizeParagraphs(opts.text)
    this.totalTokens = this.allWords.reduce((s, w) => s + w.length, 0)
    this.tokPerSec = opts.tokPerSec ?? DEMO_TOK_PER_SEC
    this.rng = makeRng(opts.seed ?? 7)
  }

  private get proseW(): number {
    return Math.max(16, this.term.cols - 4)
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

  // ── streaming ─────────────────────────────────────────────────────────

  private get doneStreaming(): boolean {
    return this.streamedTokens >= this.totalTokens
  }

  private streamToken(nowMs: number): void {
    if (this.startedParas < this.allWords.length && this.startedParas === this.paras.length) {
      // nothing pending: start the next paragraph
      this.paras.push({
        words: this.allWords[this.startedParas]!,
        prose: new ChunkProse(this.proseW),
        collapsed: false,
      })
    }
    const idx = this.paras.length - 1
    const para = this.paras[idx]
    if (!para) return
    const next = para.words[para.prose.revealed]
    if (next === undefined) return
    const before = this.tops()
    const diff = para.prose.appendWords([next])
    this.streamedTokens++
    if (!para.collapsed) this.tweens.addDiff(`p${idx}`, diff, nowMs)
    this.blockTweens(before, nowMs)
    if (para.prose.revealed >= para.words.length) this.startedParas++
  }

  // ── geometry ──────────────────────────────────────────────────────────

  /** Top row of each started paragraph (tail-anchored clipping). */
  private tops(): number[] {
    const heights = this.paras.map((p) => (p.collapsed ? 1 : Math.max(1, p.prose.layout.lines.length)))
    let total = 0
    for (const h of heights) total += h
    total += Math.max(0, this.paras.length - 1)
    const avail = this.term.rows - 1
    let top = -Math.max(0, total - avail)
    const tops: number[] = []
    for (const h of heights) {
      tops.push(top)
      top += h + 1
    }
    return tops
  }

  private blockTweens(before: number[], nowMs: number): void {
    const after = this.tops()
    for (let i = 0; i < after.length && i < before.length; i++) {
      if (before[i] !== after[i]) {
        this.tweens.add({
          key: `bp${i}`,
          kind: 'move',
          from: { row: before[i]!, col: 0 },
          to: { row: after[i]!, col: 0 },
          startMs: nowMs,
        })
      }
    }
  }

  // ── input ─────────────────────────────────────────────────────────────

  handleInput(e: InputEvent): void {
    if (this.exited) return
    const nowMs = this.lastMs ?? 0
    if (e.kind === 'resize') {
      this.term.invalidate()
      const before = this.tops()
      for (let i = 0; i < this.paras.length; i++) {
        const diff = this.paras[i]!.prose.relayout(this.proseW)
        if (!this.paras[i]!.collapsed) this.tweens.addDiff(`p${i}`, diff, nowMs)
      }
      this.blockTweens(before, nowMs)
      return
    }
    if (e.kind !== 'key') return
    if (e.ctrl && e.name === 'c') {
      this.exited = true
      return
    }
    switch (e.name) {
      case 'q':
        this.exited = true
        return
      case 'space':
        this.paused = !this.paused
        return
      case 'e':
        this.toggleRandomPara(nowMs)
        return
      default:
        return
    }
  }

  /** The toy tier toggle: fold/unfold a random earlier paragraph. */
  private toggleRandomPara(nowMs: number): void {
    const earlier = this.paras.length - (this.doneStreaming ? 0 : 1)
    if (earlier <= 0) return
    const i = this.rng.int(0, earlier - 1)
    const para = this.paras[i]!
    const before = this.tops()
    const top = before[i]!
    para.collapsed = !para.collapsed
    if (para.collapsed) {
      // exit tweens: words collapse toward the paragraph's ¶ badge
      let n = 0
      const lines = para.prose.layout.lines
      for (let li = 0; li < lines.length && n < 24; li++) {
        for (const pl of lines[li]!.placements) {
          if (n >= 24) break
          const text = para.prose.textOf(pl.segId)
          if (text.trim() === '') continue
          this.tweens.add({
            key: `p${i}x${pl.segId}`,
            kind: 'exit',
            from: { row: top + li, col: 2 + pl.col },
            to: { row: top, col: 2 },
            startMs: nowMs,
            text,
          })
          n++
        }
      }
    } else {
      let n = 0
      const lines = para.prose.layout.lines
      for (let li = 0; li < lines.length && n < 40; li++) {
        for (const pl of lines[li]!.placements) {
          if (n >= 40) break
          this.tweens.add({
            key: `p${i}s${pl.segId}`,
            kind: 'enter',
            from: { row: li, col: pl.col },
            to: { row: li, col: pl.col },
            startMs: nowMs,
          })
          n++
        }
      }
    }
    this.blockTweens(before, nowMs)
  }

  // ── frame ─────────────────────────────────────────────────────────────

  frame(nowMs: number): void {
    if (this.exited) return
    const dt = this.lastMs === null ? 0 : Math.max(0, nowMs - this.lastMs)
    this.lastMs = nowMs
    if (!this.paused && !this.doneStreaming) {
      this.accMs = Math.min(1000, this.accMs + dt)
      const tokMs = 1000 / this.tokPerSec
      while (this.accMs >= tokMs && !this.doneStreaming) {
        this.accMs -= tokMs
        this.streamToken(nowMs)
      }
    }
    this.term.flush(this.render(this.tweens.sample(nowMs)))
  }

  render(samples: ReadonlyMap<string, TweenSample>): Grid {
    const grid = createGrid(this.term.cols, this.term.rows)
    const rows = this.term.rows - 1
    const tops = this.tops()
    for (let i = 0; i < this.paras.length; i++) {
      const para = this.paras[i]!
      const blockTw = samples.get(`bp${i}`)
      const off = blockTw && blockTw.kind === 'move' ? blockTw.row - tops[i]! : 0
      const top = tops[i]! + off
      if (para.collapsed) {
        if (top >= 0 && top < rows) {
          const preview = para.words.slice(0, 6).join('').trim()
          grid.set(top, 0, '¶', UI.accent, undefined, ATTR_BOLD)
          grid.text(top, 2, `${preview} … (${para.words.length} words)`, UI.dim, undefined, ATTR_DIM)
        }
        continue
      }
      const lines = para.prose.layout.lines
      for (let li = 0; li < lines.length; li++) {
        for (const pl of lines[li]!.placements) {
          const text = para.prose.textOf(pl.segId)
          if (text === '') continue
          let row = top + li
          let col = 2 + pl.col
          let attrs = ATTR_NONE
          const tw = samples.get(`p${i}s${pl.segId}`)
          if (tw) {
            if (tw.kind === 'move') {
              row = top + tw.row
              col = 2 + tw.col
            } else if (tw.kind === 'enter') {
              attrs = ATTR_DIM
            }
          }
          if (row < 0 || row >= rows) continue
          const piece = pl.slice ? sliceCells(text, pl.slice[0], pl.slice[1]) : text
          grid.text(row, col, piece, UI.text, undefined, attrs)
        }
      }
      if (top >= 0 && top < rows) grid.set(top, 0, '¶', UI.faint, undefined, ATTR_DIM)
    }
    // exit tweens (collapsing words), absolute coords
    for (const tw of samples.values()) {
      if (tw.kind !== 'exit' || tw.text === undefined) continue
      if (tw.row < 0 || tw.row >= rows) continue
      const keepCells = Math.max(1, Math.ceil(stringCells(tw.text) * (1 - tw.t)))
      grid.text(tw.row, tw.col, sliceCells(tw.text, 0, keepCells), UI.dim, undefined, ATTR_DIM)
    }
    // streaming caret
    if (!this.doneStreaming && this.paras.length > 0) {
      const i = this.paras.length - 1
      const para = this.paras[i]!
      const lines = para.prose.layout.lines
      const lastLine = lines[lines.length - 1]!
      const row = tops[i]! + lines.length - 1
      if (row >= 0 && row < rows && !para.collapsed) {
        grid.set(row, 2 + lastLine.width, '▍', UI.accent, undefined, this.paused ? ATTR_DIM : ATTR_BOLD)
      }
    }
    // bottom line
    const status = this.paused ? 'PAUSED' : this.doneStreaming ? 'done' : 'streaming'
    grid.text(
      this.term.rows - 1,
      1,
      `oom demo — ${status} ${this.streamedTokens}/${this.totalTokens} tok`,
      this.paused ? UI.warn : UI.dim,
      undefined,
      this.paused ? ATTR_BOLD : ATTR_DIM,
    )
    const hints = 'e·fold/unfold  ␣·pause  q·quit'
    const hx = this.term.cols - hints.length - 1
    if (hx > 30) grid.text(this.term.rows - 1, hx, hints, UI.faint, undefined, ATTR_DIM)
    return grid
  }
}

function stringCells(s: string): number {
  let w = 0
  for (const g of graphemes(s)) w += cellWidth(g)
  return w
}

/** Real-time driver: ≤ 30 fps until quit. */
export async function runDemo(opts: DemoOptions): Promise<number> {
  const app = new DemoApp(opts)
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
