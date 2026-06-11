/**
 * prepare()/append() — the "expensive" pass of the pretext-tui pipeline
 * (OOM_DESIGN.md §5.1, src/pretext/types.ts): grapheme segmentation and
 * cell-width measurement, run once per text, incrementally on append.
 *
 * Classification (per grapheme cluster, by its FIRST code point so that
 * degenerate clusters like "space + combining mark" stay in class):
 * - 'break': a newline grapheme — \n, \r, \r\n (one cluster per UAX #29),
 *   U+2028, U+2029, U+0085. One segment per newline; width 0 per contract.
 * - 'space': a maximal run of breakable whitespace (space, tab, VT, FF,
 *   U+1680, U+2000–200A, U+205F, U+3000) becomes ONE segment whose width is
 *   the sum of its grapheme widths (tab measures 0, ideographic space 2).
 *   NBSP / narrow NBSP are deliberately NOT spaces: they are non-breaking,
 *   so they glue into word segments.
 * - 'word': everything else. Narrow graphemes (width 0–1) coalesce into one
 *   segment; every wide grapheme (width 2: CJK, emoji presentation) is
 *   emitted as its OWN single-grapheme segment so CJK text can wrap at any
 *   glyph boundary — layout's break-after-wide rule keys off exactly these
 *   single-grapheme width-2 segments.
 *
 * append() tail re-segmentation strategy (the contract's stable-ID rule):
 * 1. The tail = the trailing run of 'word' segments PLUS the one boundary
 *    segment just before it (the last space/break, when one exists). The
 *    boundary is included because appended text can merge INTO it: a lone
 *    '\r' + appended '\n' is one CRLF cluster, a trailing space + appended
 *    whitespace is one space run, a trailing space + appended combining
 *    mark is one cluster. Step 3's keep-prefix preserves the boundary's id
 *    whenever it is unaffected (the overwhelmingly common case). Segments
 *    before the tail are reused BY OBJECT — ids untouched.
 * 2. Re-segment (tailText + appendedText) from scratch. This re-runs
 *    grapheme clustering across the splice point, which is the only place
 *    clustering can change (combining marks, ZWJ joins, regional-indicator
 *    pairing all extend the final cluster).
 * 3. Keep the longest prefix of the re-segmented tail that matches the old
 *    tail segment-for-segment (same kind + text ⇒ same width): those old
 *    segment objects are reused, ids untouched. Everything after the first
 *    mismatch is RETIRED; replacements get fresh ids strictly greater than
 *    any id this lineage has assigned (ids are never reused, segments never
 *    mutated). Consequences:
 *    - extending a trailing word retires it ("cd" + "ef" → fresh "cdef");
 *    - appending text that starts with whitespace retires nothing;
 *    - extending a trailing CJK run retires nothing (each glyph is its own
 *      complete segment, so "日本" + "語" keeps 日/本 and adds 語);
 *    - cluster merges are handled ("🇺" + "🇸" retires 🇺 for a fresh 🇺🇸;
 *      "a\r" + "\nb" retires the \r for a fresh \r\n break).
 *    Because the boundary segment is part of the re-segmented tail, an
 *    append-built lineage stays segment-shape-identical (kind/text/width
 *    sequence; ids differ) to a from-scratch prepare of the concatenated
 *    string — property-tested in test/pretext.
 *
 * A persistent chain of journal nodes (WeakMap-attached, invisible to
 * callers) records, for each append, the first segment index that changed
 * and a parent pointer to the previous version's node. layout() walks the
 * chain to find the first potentially-dirty line AND to prove the prev hint
 * really belongs to this exact lineage branch (a layout built from a
 * different prepare() — or from a sibling branch of the same lineage — is
 * detected by node identity and safely ignored). Losing the chain only
 * costs performance, never correctness.
 */

import { cellWidth, graphemes } from '../shared/width'
import type { Prepared, Segment, SegmentKind } from './types'

interface RawSeg {
  kind: SegmentKind
  text: string
  width: number
}

function isBreakGrapheme(g: string): boolean {
  return g === '\n' || g === '\r' || g === '\r\n' || g === '\u2028' || g === '\u2029' || g === '\u0085'
}

function isSpaceGrapheme(g: string): boolean {
  const cp = g.codePointAt(0)!
  return (
    cp === 0x20 ||
    cp === 0x09 ||
    cp === 0x0b ||
    cp === 0x0c ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x205f ||
    cp === 0x3000
  )
}

/** Segment a text into kind/text/width triples (ids are assigned by callers). */
function segmentText(text: string): RawSeg[] {
  const out: RawSeg[] = []
  let wordText = ''
  let wordWidth = 0
  let spaceText = ''
  let spaceWidth = 0
  const flushWord = (): void => {
    if (wordText !== '') {
      out.push({ kind: 'word', text: wordText, width: wordWidth })
      wordText = ''
      wordWidth = 0
    }
  }
  const flushSpace = (): void => {
    if (spaceText !== '') {
      out.push({ kind: 'space', text: spaceText, width: spaceWidth })
      spaceText = ''
      spaceWidth = 0
    }
  }
  for (const g of graphemes(text)) {
    if (isBreakGrapheme(g)) {
      flushWord()
      flushSpace()
      out.push({ kind: 'break', text: g, width: 0 })
    } else if (isSpaceGrapheme(g)) {
      flushWord()
      spaceText += g
      spaceWidth += cellWidth(g)
    } else {
      flushSpace()
      const w = cellWidth(g)
      if (w === 2) {
        // Wide grapheme: its own breakable word segment (CJK wraps anywhere).
        flushWord()
        out.push({ kind: 'word', text: g, width: 2 })
      } else {
        wordText += g
        wordWidth += w
      }
    }
  }
  flushWord()
  flushSpace()
  return out
}

/**
 * One immutable journal node per Prepared. `dirty` is the first segment
 * index that may differ from the PARENT version's list (Infinity ⇒ no-op
 * append). Node identity doubles as a lineage-branch witness: a node is
 * reachable by parent pointers exactly from its own descendants.
 */
export interface Chain {
  readonly version: number
  readonly dirty: number
  readonly parent: Chain | undefined
}

const chains = new WeakMap<Prepared, Chain>()

/** @internal (used by layout) — journal node of `p`, if this module made it. */
export function chainOf(p: Prepared): Chain | undefined {
  return chains.get(p)
}

/** Expensive pass: segment `text` into stably-identified segments. */
export function prepare(text: string): Prepared {
  const segments: Segment[] = segmentText(text).map((r, i) => ({
    id: i,
    kind: r.kind,
    text: r.text,
    width: r.width,
  }))
  const p: Prepared = { segments, version: 0 }
  chains.set(p, { version: 0, dirty: Infinity, parent: undefined })
  return p
}

/**
 * Incremental pass: extend `p` with `text`, re-segmenting only the tail.
 * See the module header for the exact strategy. Returns a new Prepared
 * (version bumped); `p` itself is never mutated.
 */
export function append(p: Prepared, text: string): Prepared {
  const old = p.segments
  // Tail = trailing run of 'word' segments plus the boundary space/break
  // before it (appends can merge into the boundary — see module header).
  let tailStart = old.length
  while (tailStart > 0 && old[tailStart - 1]!.kind === 'word') tailStart--
  if (tailStart > 0) tailStart--
  let tailText = ''
  for (let i = tailStart; i < old.length; i++) tailText += old[i]!.text
  const raw = segmentText(tailText + text)

  // Longest old-tail prefix that survives re-segmentation keeps its ids.
  const oldTailLen = old.length - tailStart
  let keep = 0
  while (keep < oldTailLen && keep < raw.length) {
    const o = old[tailStart + keep]!
    const n = raw[keep]!
    if (o.kind !== n.kind || o.text !== n.text) break
    keep++
  }

  // Fresh ids start above every id this lineage has assigned so far.
  // Ids grow with segment index by construction, but scan to stay robust.
  let nextId = 0
  for (const s of old) if (s.id >= nextId) nextId = s.id + 1

  const segments: Segment[] = old.slice(0, tailStart + keep)
  for (let k = keep; k < raw.length; k++) {
    const r = raw[k]!
    segments.push({ id: nextId++, kind: r.kind, text: r.text, width: r.width })
  }

  const version = p.version + 1
  const unchanged = keep === oldTailLen && raw.length === keep
  const dirty = unchanged ? Infinity : tailStart + keep
  const next: Prepared = { segments, version }
  // parent === undefined for a foreign Prepared: layouts older than `next`
  // can never be verified against it, so incremental reuse will bail.
  chains.set(next, { version, dirty, parent: chains.get(p) })
  return next
}
