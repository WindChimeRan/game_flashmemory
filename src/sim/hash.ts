/**
 * FNV-1a 32-bit incremental hasher over int values — stateHash() backbone.
 * Each value is uint32-coerced and folded as 4 little-endian bytes.
 */

export const FNV_INIT = 0x811c9dc5

export function fnvInt(h: number, v: number): number {
  let x = v >>> 0
  for (let i = 0; i < 4; i++) {
    h = (h ^ (x & 0xff)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
    x >>>= 8
  }
  return h >>> 0
}

const F64 = new Float64Array(1)
const U32 = new Uint32Array(F64.buffer)

/** Fold a float64's exact bit pattern (both 32-bit halves) into the hash. */
export function fnvFloat(h: number, v: number): number {
  F64[0] = v
  h = fnvInt(h, U32[0]!)
  return fnvInt(h, U32[1]!)
}
