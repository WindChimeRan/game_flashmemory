/**
 * positions(before, after): moved / entered / exited per the contract —
 * first-placement rule for sliced segments, unmoved segments omitted,
 * consumed spaces surface as entered/exited when their visibility flips.
 */

import { describe, expect, test } from 'bun:test'
import { append, layout, positions, prepare } from '../../src/pretext'

describe('positions', () => {
  test('identical layouts diff to nothing', () => {
    const p = prepare('alpha beta 日本語')
    const a = layout(p, 9)
    const b = layout(p, 9)
    expect(positions(a, b)).toEqual({ moved: [], entered: [], exited: [] })
  })

  test('append-induced reflow: entered word, exited word and consumed space', () => {
    const p1 = prepare('aa bb cc')
    const before = layout(p1, 8) // one line: aa· ·bb· ·cc exactly 8 cells
    expect(before.lines).toHaveLength(1)
    const p2 = append(p1, 'dd') // retires cc (id 4) for ccdd (id 5)
    const after = layout(p2, 8, before)
    expect(after.lines).toHaveLength(2)
    expect(positions(before, after)).toEqual({
      moved: [],
      entered: [{ segId: 5, toRow: 1, toCol: 0 }],
      exited: [
        // the space before cc is consumed at the new wrap point
        { segId: 3, fromRow: 0, fromCol: 5 },
        // cc itself was retired by the append
        { segId: 4, fromRow: 0, fromCol: 6 },
      ],
    })
  })

  test('width change moves downstream segments in reading order', () => {
    const p = prepare('aa bb cc dd') // ids: aa0 sp1 bb2 sp3 cc4 sp5 dd6
    const wide = layout(p, 11) // single line
    const narrow = layout(p, 5) // "aa bb" / "cc dd"
    expect(positions(wide, narrow)).toEqual({
      moved: [
        { segId: 4, fromRow: 0, fromCol: 6, toRow: 1, toCol: 0 },
        { segId: 5, fromRow: 0, fromCol: 8, toRow: 1, toCol: 2 },
        { segId: 6, fromRow: 0, fromCol: 9, toRow: 1, toCol: 3 },
      ],
      entered: [],
      exited: [{ segId: 3, fromRow: 0, fromCol: 5 }],
    })
  })

  test('sliced segments are represented by their first placement only', () => {
    const p = prepare('yy abcdef') // ids: yy0 sp1 abcdef2
    const sliced = layout(p, 3) // yy / abc / def — abcdef sliced, first at (1,0)
    expect(sliced.lines).toHaveLength(3)
    const wide = layout(p, 20) // yy abcdef on one line, abcdef at (0,3)
    expect(positions(sliced, wide)).toEqual({
      moved: [{ segId: 2, fromRow: 1, fromCol: 0, toRow: 0, toCol: 3 }],
      entered: [{ segId: 1, toRow: 0, toCol: 2 }], // space becomes visible
      exited: [],
    })
  })

  test('a sliced segment whose first placement is unmoved is omitted', () => {
    const p = prepare('abcdefghij')
    const at3 = layout(p, 3) // 4 slice lines, first placement (0,0)
    const at4 = layout(p, 4) // 3 slice lines, first placement (0,0)
    expect(positions(at3, at4)).toEqual({ moved: [], entered: [], exited: [] })
  })

  test('hard-break insertion shifts following lines down', () => {
    const p1 = prepare('one two')
    const before = layout(p1, 3) // "one" / "two"
    const p2 = append(p1, '\nsix') // break boundary: "two" (id 2) is kept
    const after = layout(p2, 3, before)
    // "two" is untouched (break is a whitespace boundary); "six" enters below
    expect(positions(before, after)).toEqual({
      moved: [],
      entered: [{ segId: 4, toRow: 2, toCol: 0 }],
      exited: [],
    })
  })
})
