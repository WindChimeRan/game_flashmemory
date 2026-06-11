/**
 * anim — FLIP tween runtime over the cell grid (game layer).
 *
 * Consumes pretext positions() diffs (moved / entered / exited) plus
 * game-side tier-change events and tweens cell positions over ~220 ms
 * easeOutCubic at the render rate. Entered segments fade in (drawn dim
 * until the tween completes); exited segments collapse toward their
 * chunk's badge (the screen truncates their text as t → 1).
 *
 * Animations are visual only — sim state is already final when a tween is
 * registered, and input is never blocked on animation. The tween clock is
 * the RENDER clock (milliseconds), fully independent of sim ticks.
 */

import type { PositionDiff } from '../pretext'

export interface Pt {
  row: number
  col: number
}

/** Default tween duration (ms). */
export const TWEEN_MS = 220

export const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** easeOutCubic: fast start, gentle landing. */
export function easeOutCubic(t: number): number {
  const k = clamp01(t)
  const inv = 1 - k
  return 1 - inv * inv * inv
}

/**
 * Position at raw progress tRaw ∈ [0,1] (ease applied inside).
 * Returns float coordinates; callers round for cell placement.
 */
export function tweenPos(from: Pt, to: Pt, tRaw: number): Pt {
  const e = easeOutCubic(tRaw)
  return {
    row: from.row + (to.row - from.row) * e,
    col: from.col + (to.col - from.col) * e,
  }
}

export type TweenKind = 'move' | 'enter' | 'exit'

export interface Tween {
  readonly key: string
  readonly kind: TweenKind
  readonly from: Pt
  readonly to: Pt
  readonly startMs: number
  readonly durationMs: number
  /** Drawn text for 'exit' tweens (collapsing words). */
  readonly text?: string
}

export interface TweenSample {
  readonly key: string
  readonly kind: TweenKind
  /** Rounded cell position at the sample time. */
  readonly row: number
  readonly col: number
  /** Raw progress 0..1 (screen uses it for fades / truncation). */
  readonly t: number
  readonly text?: string
}

export interface AddDiffOpts {
  /** Absolute target for exited segments (the chunk badge); omitted = no exit tweens. */
  exitTo?: Pt
  /** Text lookup for exited segments (required to draw them). */
  textOf?: (segId: number) => string
  /** Cap on exit tweens registered from one diff (default 24). */
  exitCap?: number
}

export class TweenRuntime {
  private readonly tweens = new Map<string, Tween>()

  constructor(readonly durationMs: number = TWEEN_MS) {}

  get size(): number {
    return this.tweens.size
  }

  add(t: {
    key: string
    kind: TweenKind
    from: Pt
    to: Pt
    startMs: number
    durationMs?: number
    text?: string
  }): void {
    this.tweens.set(t.key, {
      key: t.key,
      kind: t.kind,
      from: t.from,
      to: t.to,
      startMs: t.startMs,
      durationMs: t.durationMs ?? this.durationMs,
      ...(t.text !== undefined ? { text: t.text } : {}),
    })
  }

  /**
   * Register tweens from a pretext positions() diff. Keys are
   * `${prefix}s${segId}`; coordinates stay in the diff's space (the
   * screen offsets per-chunk-local coords; exit tweens take absolute
   * coords supplied via opts.exitTo).
   */
  addDiff(prefix: string, diff: PositionDiff, nowMs: number, opts: AddDiffOpts = {}): void {
    for (const m of diff.moved) {
      this.add({
        key: `${prefix}s${m.segId}`,
        kind: 'move',
        from: { row: m.fromRow, col: m.fromCol },
        to: { row: m.toRow, col: m.toCol },
        startMs: nowMs,
      })
    }
    for (const e of diff.entered) {
      this.add({
        key: `${prefix}s${e.segId}`,
        kind: 'enter',
        from: { row: e.toRow, col: e.toCol },
        to: { row: e.toRow, col: e.toCol },
        startMs: nowMs,
      })
    }
    if (opts.exitTo && opts.textOf) {
      const cap = opts.exitCap ?? 24
      let n = 0
      for (const x of diff.exited) {
        if (n >= cap) break
        const text = opts.textOf(x.segId)
        if (text.trim() === '') continue // collapsing whitespace draws nothing
        this.add({
          key: `${prefix}x${x.segId}`,
          kind: 'exit',
          from: { row: x.fromRow, col: x.fromCol },
          to: opts.exitTo,
          startMs: nowMs,
          text,
        })
        n++
      }
    }
  }

  /** Sample all active tweens at nowMs; finished tweens are pruned. */
  sample(nowMs: number): Map<string, TweenSample> {
    const out = new Map<string, TweenSample>()
    for (const [key, tw] of this.tweens) {
      const t = tw.durationMs <= 0 ? 1 : (nowMs - tw.startMs) / tw.durationMs
      if (t >= 1) {
        this.tweens.delete(key)
        continue
      }
      const p = tweenPos(tw.from, tw.to, t)
      out.set(key, {
        key,
        kind: tw.kind,
        row: Math.round(p.row),
        col: Math.round(p.col),
        t: clamp01(t),
        ...(tw.text !== undefined ? { text: tw.text } : {}),
      })
    }
    return out
  }

  /** True if any tween would still be active at nowMs (without pruning). */
  active(nowMs: number): boolean {
    for (const tw of this.tweens.values()) {
      if (nowMs - tw.startMs < tw.durationMs) return true
    }
    return false
  }

  clear(): void {
    this.tweens.clear()
  }
}
