/**
 * Perf sanity — log only, no timing assertions (the suite must stay green
 * on slow machines). Builds a ~10k-word document, then measures prepare,
 * full layout, one streaming append, incremental re-layout vs from-scratch
 * re-layout. The only assertion is the equivalence of the two re-layouts.
 */

import { expect, test } from 'bun:test'
import { append, layout, prepare } from '../../src/pretext'
import { int, mulberry32 } from './helpers'

test('perf sanity: ~10k-word document (log only)', () => {
  const rng = mulberry32(0xbeef)
  let doc = ''
  for (let i = 0; i < 10_000; i++) {
    const n = int(rng, 3, 9)
    let w = ''
    for (let k = 0; k < n; k++) w += String.fromCharCode(97 + int(rng, 0, 25))
    doc += (i === 0 ? '' : i % 120 === 0 ? '\n\n' : ' ') + w
  }
  const t0 = performance.now()
  const p = prepare(doc)
  const t1 = performance.now()
  const lay = layout(p, 80)
  const t2 = performance.now()
  const p2 = append(p, ' lorem ipsum dolor sit amet')
  const t3 = performance.now()
  const inc = layout(p2, 80, lay)
  const t4 = performance.now()
  const scratch = layout(p2, 80)
  const t5 = performance.now()
  console.log(
    `[pretext perf] 10k words → ${p.segments.length} segments, ${lay.lines.length} lines @ width 80 | ` +
      `prepare ${(t1 - t0).toFixed(2)}ms · layout ${(t2 - t1).toFixed(2)}ms · ` +
      `append ${(t3 - t2).toFixed(3)}ms · incremental re-layout ${(t4 - t3).toFixed(3)}ms · ` +
      `from-scratch re-layout ${(t5 - t4).toFixed(2)}ms`
  )
  expect(inc).toEqual(scratch)
})
