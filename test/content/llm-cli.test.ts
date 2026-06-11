/**
 * CLI parsing for LLM mode (--llm / --llm-url / --llm-model). Kept in its
 * own file: importing src/cli pulls in the sim/bots/game graph, and the
 * core provider suite (llm.test.ts) must stay decoupled from it.
 */

import { describe, expect, test } from 'bun:test'
import { parseCli, usage } from '../../src/cli'

describe('parseCli · llm mode', () => {
  test('--llm enables llm mode with env-default url/model', () => {
    expect(parseCli(['play', '--llm'])).toEqual({
      cmd: 'play',
      preset: 'default',
      seed: null,
      warp: 0,
      llm: { url: null, model: null },
    })
  })

  test('--llm-url / --llm-model imply --llm and carry their values', () => {
    expect(parseCli(['play', '--llm-url', 'http://h:1/v1'])).toEqual({
      cmd: 'play',
      preset: 'default',
      seed: null,
      warp: 0,
      llm: { url: 'http://h:1/v1', model: null },
    })
    expect(parseCli(['play', '--seed', '7', '--llm-model', 'M', '--llm-url', 'U'])).toEqual({
      cmd: 'play',
      preset: 'default',
      seed: 7,
      warp: 0,
      llm: { url: 'U', model: 'M' },
    })
  })

  test('plain play carries no llm options at all', () => {
    expect('llm' in parseCli(['play'])).toBe(false)
  })

  test('missing values are usage errors', () => {
    expect(() => parseCli(['play', '--llm-url'])).toThrow(/--llm-url needs a value/)
    expect(() => parseCli(['play', '--llm-model'])).toThrow(/--llm-model needs a value/)
  })

  test('usage documents llm mode and its env vars', () => {
    const u = usage()
    expect(u).toContain('--llm')
    expect(u).toContain('OOM_LLM_BASE_URL')
    expect(u).toContain('OOM_LLM_MODEL')
    expect(u).toContain('OOM_LLM_API_KEY')
  })
})
