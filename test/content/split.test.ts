/**
 * splitPieces — CJK-aware reveal-piece splitting (pure core of llm.ts).
 *
 * Laws under test:
 * - Latin/narrow runs stay whole words (space-delimited, trailing space
 *   attached; synthesized at end of stream — scripted's piece shape).
 * - Wide-grapheme (CJK) runs split into 1–2-grapheme pieces so the
 *   1-piece-per-tick reveal flows through spaceless prose.
 * - CJK punctuation clings to the preceding piece and never starts one;
 *   a full wide pair re-splits 1+1 so punctuated pieces stay ≤ 2 graphemes.
 * - Concatenating pieces reproduces the source text (lossless reveal).
 * - Streaming (final=false) emission never contradicts the one-shot split:
 *   feeding any chunking of the text yields the same final piece stream.
 */

import { describe, expect, test } from 'bun:test'
import { splitPieces } from '../../src/content/llm'
import { graphemes } from '../../src/shared/width'

const CLING = ['。', '，', '、', '！', '？']

/** Drive the acceptText/finishWords loop: feed code-point chunks of `sizes`. */
function incremental(text: string, sizes: readonly number[]): string[] {
  const out: string[] = []
  let partial = ''
  const cps = Array.from(text)
  let i = 0
  let k = 0
  while (i < cps.length) {
    const n = Math.max(1, sizes[k++ % sizes.length]!)
    partial += cps.slice(i, i + n).join('')
    i += n
    const { pieces, rest } = splitPieces(partial, false)
    out.push(...pieces)
    partial = rest
  }
  out.push(...splitPieces(partial, true).pieces)
  return out
}

describe('splitPieces · pure CJK', () => {
  const PARA = '夜风掠过秘档库，顾长风按住星盘。警报在塔底化作潮水、他纵身跃入黑暗！谁在喊他的名字？'

  test('a spaceless Chinese paragraph becomes 1–2-grapheme pieces, punctuation attached', () => {
    const { pieces, rest } = splitPieces(PARA, true)
    expect(rest).toBe('')
    expect(pieces.length).toBeGreaterThan(10) // not one giant piece
    for (const p of pieces) {
      expect(graphemes(p).length).toBeLessThanOrEqual(2) // reveal granularity
      expect(CLING.includes(graphemes(p)[0]!)).toBe(false) // never piece-initial
    }
    // punctuation clings: every cling mark sits at the END of its piece
    for (const mark of CLING) {
      for (const p of pieces) {
        if (p.includes(mark)) expect(p.endsWith(mark)).toBe(true)
      }
    }
    expect(pieces.join('')).toBe(PARA) // lossless
  })

  test('even-length run + punct re-splits 1+1 (走了。 → 走|了。)', () => {
    expect(splitPieces('走了。', true).pieces).toEqual(['走', '了。'])
    expect(splitPieces('他走了。', true).pieces).toEqual(['他', '走', '了。'])
    expect(splitPieces('剑。', true).pieces).toEqual(['剑。'])
  })

  test('piece count = graphemes (singles): the targetTokens arithmetic input', () => {
    const run = '星'.repeat(7) + '盘'.repeat(6) // 13 wide graphemes, no punct
    const { pieces } = splitPieces(run, true)
    expect(pieces.length).toBe(13)
    expect(pieces.join('')).toBe(run)
    // singles: a 60–90-字 paragraph yields 60–90 pieces — covers 44–77 targets
    expect(splitPieces('档'.repeat(40), true).pieces.length).toBe(40)
  })
})

describe('splitPieces · Latin and mixed', () => {
  test('Latin keeps whole words with trailing spaces (scripted shape)', () => {
    expect(splitPieces('alpha beta gamma', true).pieces).toEqual(['alpha ', 'beta ', 'gamma '])
    for (const p of splitPieces('alpha beta gamma', true).pieces) {
      expect(p).toMatch(/^\S+ $/)
    }
  })

  test('mixed CJK/Latin: words stay whole, CJK splits, the join is lossless', () => {
    const text = 'Qwen3 引擎在 archive 区轰鸣。'
    const { pieces } = splitPieces(text, true)
    expect(pieces).toEqual(['Qwen3 ', '引', '擎', '在 ', 'archive ', '区', '轰', '鸣。'])
    expect(pieces.join('')).toBe(text)
  })

  test('script boundary without a space stays lossless (no synthesized gaps)', () => {
    const text = '代号OOM启动。'
    const { pieces } = splitPieces(text, true)
    expect(pieces).toEqual(['代', '号', 'OOM', '启', '动。'])
    expect(pieces.join('')).toBe(text)
  })

  test('Latin punctuation rides inside the word; CJK punct seals a word', () => {
    expect(splitPieces("can't stop", true).pieces).toEqual(["can't ", 'stop '])
    expect(splitPieces('好的yes，再来', true).pieces).toEqual(['好', '的', 'yes，', '再', '来'])
  })
})

describe('splitPieces · streaming (final=false)', () => {
  test('withholds an unsettled tail; emitted pieces never change', () => {
    // a bare word with no delimiter is not settled yet
    expect(splitPieces('alp', false)).toEqual({ pieces: [], rest: 'alp' })
    // a space seals the word — settled immediately (old splitter cadence)
    expect(splitPieces('alpha ', false)).toEqual({ pieces: ['alpha '], rest: '' })
    // the newest wide grapheme is held open (its follower decides punct cling)
    expect(splitPieces('夜风', false)).toEqual({ pieces: ['夜'], rest: '风' })
    // closed pair settles once the next run starts; the open run is the tail
    expect(splitPieces('夜风掠过秘', false)).toEqual({ pieces: ['夜', '风', '掠', '过'], rest: '秘' })
    // a punct-sealed piece at the very end is withheld (more punct may chain)
    expect(splitPieces('走了。', false)).toEqual({ pieces: ['走'], rest: '了。' })
  })

  test('any chunking replays the one-shot split exactly (CJK, mixed, Latin)', () => {
    const texts = [
      '夜风掠过秘档库，顾长风按住星盘。警报在塔底化作潮水、他纵身跃入黑暗！',
      'Qwen3 引擎在 archive 区轰鸣。代号OOM启动。',
      'alpha beta gamma delta',
      '走了。再走。又走了！',
    ]
    for (const text of texts) {
      const oneShot = splitPieces(text, true).pieces
      for (const sizes of [[1], [2], [3], [7], [1, 5, 2]]) {
        expect(incremental(text, sizes)).toEqual(oneShot)
      }
      // lossless up to the synthesized trailing space of a final Latin word
      const joined = oneShot.join('')
      expect(joined === text || joined === `${text} `).toBe(true)
    }
  })

  test('whitespace collapse mirrors the sanitizer contract (single spaces)', () => {
    // post-sanitizer text has single spaces; defensively, doubles collapse
    expect(splitPieces('a  b', true).pieces).toEqual(['a ', 'b '])
    expect(splitPieces(' lead', true).pieces).toEqual(['lead '])
    expect(splitPieces('剑。 Then', true).pieces).toEqual(['剑。 ', 'Then '])
  })
})
