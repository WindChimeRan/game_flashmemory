/**
 * prose — per-chunk word buffering + incremental layout (game layer).
 *
 * Content wiring per the design: sim owns token counts; the game asks
 * sim.chunkSpec(id), pulls words from the ContentProvider into a per-chunk
 * buffer (ahead of display — scripted is instant), and reveals words 1:1
 * with the sim's tokensShown. Prose NEVER affects sim state; on a buffer
 * lag the reveal simply trails until words arrive.
 */

import { append, layout, positions, prepare } from '../pretext'
import type { Layout, PositionDiff, Prepared } from '../pretext'
import type { ContentProvider } from '../content/types'
import type { ChunkSpec } from '../sim'

/** One chunk's revealed prose: Prepared lineage + current layout. */
export class ChunkProse {
  prepared: Prepared
  layout: Layout
  /** Words appended so far (1 word = 1 sim token). */
  revealed = 0
  private width: number
  private byId = new Map<number, string>()
  private byIdVersion = -1

  constructor(width: number) {
    this.width = Math.max(1, width)
    this.prepared = prepare('')
    this.layout = layout(this.prepared, this.width)
  }

  /** Append word pieces (producer includes whitespace); returns the FLIP diff. */
  appendWords(words: readonly string[]): PositionDiff {
    const old = this.layout
    this.prepared = append(this.prepared, words.join(''))
    this.layout = layout(this.prepared, this.width, old)
    this.revealed += words.length
    return positions(old, this.layout)
  }

  /** Re-wrap at a new width (resize); returns the FLIP diff. */
  relayout(width: number): PositionDiff {
    const old = this.layout
    this.width = Math.max(1, width)
    this.layout = layout(this.prepared, this.width)
    return positions(old, this.layout)
  }

  /** Segment text lookup for rendering / exit tweens. */
  textOf = (segId: number): string => {
    if (this.byIdVersion !== this.prepared.version) {
      this.byId.clear()
      for (const s of this.prepared.segments) this.byId.set(s.id, s.text)
      this.byIdVersion = this.prepared.version
    }
    return this.byId.get(segId) ?? ''
  }
}

export class ProseStore {
  private readonly provider: ContentProvider
  private width: number
  private readonly words = new Map<number, string[]>()
  private readonly chunks = new Map<number, ChunkProse>()

  constructor(provider: ContentProvider, width: number) {
    this.provider = provider
    this.width = Math.max(1, width)
  }

  /** Start buffering a freshly spawned chunk (idempotent). */
  ensure(spec: ChunkSpec): void {
    if (this.words.has(spec.chunkId)) return
    const buf: string[] = []
    this.words.set(spec.chunkId, buf)
    this.chunks.set(spec.chunkId, new ChunkProse(this.width))
    // Pull ahead into the buffer; display drains via sync(). Never blocks.
    void (async () => {
      let n = 0
      for await (const piece of this.provider.nextChunk(spec)) {
        buf.push(piece)
        if (++n >= spec.targetTokens) break
      }
    })().catch(() => {
      /* provider failure leaves the buffer short; reveal just trails */
    })
  }

  get(id: number): ChunkProse | undefined {
    return this.chunks.get(id)
  }

  /**
   * Reveal words for chunk `id` up to the sim's tokensShown (bounded by
   * what the buffer holds). Returns the FLIP diff when anything new was
   * revealed, else null.
   */
  sync(id: number, tokensShown: number): PositionDiff | null {
    const prose = this.chunks.get(id)
    const buf = this.words.get(id)
    if (!prose || !buf) return null
    const avail = Math.min(tokensShown, buf.length)
    if (avail <= prose.revealed) return null
    return prose.appendWords(buf.slice(prose.revealed, avail))
  }

  /** Re-wrap every chunk at a new width; returns per-chunk FLIP diffs. */
  setWidth(width: number): Map<number, PositionDiff> {
    this.width = Math.max(1, width)
    const out = new Map<number, PositionDiff>()
    for (const [id, prose] of this.chunks) out.set(id, prose.relayout(this.width))
    return out
  }
}
