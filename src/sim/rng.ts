/**
 * Deterministic PRNG (ARCHITECTURE.md D4): mulberry32 streams, fork via
 * string-hash mixing, Box-Muller gaussian. No Date.now / Math.random.
 */

import type { Rng } from './types'

/** FNV-1a over a string → uint32. Used for fork labels. */
export function hashStr(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Avalanche mix of two uint32s (murmur3 finalizer flavored). */
export function mix32(a: number, b: number): number {
  let x = ((a >>> 0) ^ Math.imul(b >>> 0, 0x9e3779b1)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

/** mulberry32-backed Rng. fork(label) derives a child from (current state, label) without advancing the parent. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const rng: Rng = {
    next,
    int(lo: number, hi: number): number {
      if (hi <= lo) return lo
      const v = lo + Math.floor(next() * (hi - lo + 1))
      return v > hi ? hi : v
    },
    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new Error('Rng.pick: empty array')
      return arr[rng.int(0, arr.length - 1)] as T
    },
    fork(label: string): Rng {
      return makeRng(mix32(s, hashStr(label)))
    },
  }
  return rng
}

/** Standard normal via Box-Muller (2 uniform draws per call, cos branch). */
export function gaussian(rng: Rng): number {
  const u1 = 1 - rng.next() // (0, 1] — log-safe
  const u2 = rng.next()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}
