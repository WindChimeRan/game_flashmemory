/**
 * Tiny shared numeric helpers (internal to src/sim).
 */

/**
 * Number of glyphs that must be expanded to satisfy a sufficiency fraction:
 * the smallest k with k/n ≥ frac, floored at 1. The 1e-9 slack mirrors
 * waveCredit's comparison so fp artifacts in `frac · n` (e.g. 0.1+0.2 → 3.0…04
 * for n=10) can never demand one glyph more than credit actually requires.
 */
export function needCount(frac: number, n: number): number {
  return Math.max(1, Math.ceil(frac * n - 1e-9))
}
