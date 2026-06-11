/**
 * Cell-width measurement for terminal text. Pure functions, no state, no I/O.
 *
 * Owned by the integrator — module agents treat this file as READ-ONLY.
 *
 * Policy (documented deviations are deliberate):
 * - East Asian Wide / Fullwidth → 2 cells; Ambiguous → 1 cell (most modern
 *   terminals default to narrow ambiguous; no config knob until needed).
 * - Emoji presentation (ZWJ sequences, VS16, regional-indicator pairs) → 2.
 * - Zero-width: combining marks, ZWJ/ZWNJ, BOM, bidi controls → 0.
 * - C0/C1 controls → 0 (the sanitizer strips them before layout anyway;
 *   returning 0 keeps the function total).
 * - Tabs are NOT expanded here — callers expand tabs before measuring.
 */

let segmenter: Intl.Segmenter | undefined

/** Split a string into grapheme clusters (user-perceived characters). */
export function graphemes(s: string): string[] {
  if (s === '') return []
  segmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' })
  const out: string[] = []
  for (const seg of segmenter.segment(s)) out.push(seg.segment)
  return out
}

// [lo, hi] inclusive code point ranges that occupy 2 cells (EAW W/F, plus
// emoji blocks commonly rendered wide even without VS16).
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo leading consonants
  [0x2e80, 0x303e], // CJK Radicals .. CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compatibility
  [0x3400, 0x4dbf], // CJK Ext A
  [0x4e00, 0x9fff], // CJK Unified
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth signs
  [0x1f300, 0x1f64f], // Misc Symbols & Pictographs, Emoticons
  [0x1f680, 0x1f6ff], // Transport
  [0x1f900, 0x1faff], // Supplemental Symbols, Symbols Ext-A
  [0x20000, 0x2fffd], // CJK Ext B..F
  [0x30000, 0x3fffd], // CJK Ext G
]

// Zero-width code point ranges: combining marks, joiners, format controls.
const ZERO: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x08d3, 0x08ff],
  [0x0900, 0x0902], // Devanagari combining (subset)
  [0x093a, 0x093a],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0e31, 0x0e31], // Thai
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embedding controls
  [0x2060, 0x2064], // word joiner, invisible operators
  [0x20d0, 0x20ff], // Combining Marks for Symbols
  [0xfe00, 0xfe0f], // Variation Selectors (VS16 handled separately)
  [0xfe20, 0xfe2f], // Combining Half Marks
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xe0100, 0xe01ef], // Variation Selectors Supplement
]

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]!
    if (cp < r[0]) hi = mid - 1
    else if (cp > r[1]) lo = mid + 1
    else return true
  }
  return false
}

const ZWJ = 0x200d
const VS16 = 0xfe0f
const RI_LO = 0x1f1e6 // regional indicator A
const RI_HI = 0x1f1ff

/**
 * Cell width of ONE grapheme cluster: 0, 1, or 2.
 * Pass output of graphemes(); behavior on multi-cluster strings is undefined.
 */
export function cellWidth(g: string): 0 | 1 | 2 {
  if (g === '') return 0
  const cps: number[] = []
  for (const ch of g) cps.push(ch.codePointAt(0)!)
  const first = cps[0]!
  // Control chars (C0, DEL, C1) — stripped upstream; width 0 keeps us total.
  if (first < 0x20 || (first >= 0x7f && first < 0xa0)) return 0
  // Emoji-presentation signals anywhere in the cluster → wide.
  for (const cp of cps) {
    if (cp === ZWJ || cp === VS16) return 2
  }
  // Regional indicator pair (flags) → wide.
  if (first >= RI_LO && first <= RI_HI) return 2
  if (inRanges(first, ZERO)) return 0
  if (inRanges(first, WIDE)) return 2
  return 1
}

/** Total cell width of a string (sum over grapheme clusters). */
export function stringWidth(s: string): number {
  let w = 0
  for (const g of graphemes(s)) w += cellWidth(g)
  return w
}
