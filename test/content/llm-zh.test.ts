/**
 * zh story-language tests — prompt selection, the parallel Chinese cast
 * (nameFor plumbing), env OOM_LLM_LANG, and CJK prose streaming end to end
 * through the provider (fake in-process server; no live endpoint).
 *
 * Honest limitation under test too: scripted fallback/padding stays
 * ENGLISH in zh mode (the fallback narrator has no zh voice yet).
 */

import { describe, expect, test } from 'bun:test'
import type { ChunkSpec } from '../../src/sim/types'
import { LlmProvider, buildMessages, characterZhFor } from '../../src/content/llm'
import { characterFor, scriptedPieces } from '../../src/content/scripted'
import { graphemes } from '../../src/shared/width'

const spec = (over: Partial<ChunkSpec> = {}): ChunkSpec => ({
  chunkId: 0,
  glyph: 'A',
  theme: 'archive',
  targetTokens: 8,
  seed: 101,
  ...over,
})

async function drain(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const piece of iter) out.push(piece)
  return out
}

const enc = new TextEncoder()
const frame = (content: string): string =>
  `data: ${JSON.stringify({ id: 'cmpl-zh', choices: [{ index: 0, delta: { content } }] })}\n\n`
const DONE = 'data: [DONE]\n\n'

/** OpenAI-style SSE response streaming raw text deltas (CJK has no spaces). */
function textResponse(deltas: readonly string[]): Response {
  const body = deltas.map(frame).join('') + DONE
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(body))
        c.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

interface FakeServer {
  url: string
  posts: Record<string, unknown>[]
  stop(): void
}

function startServer(respond: () => Response): FakeServer {
  const posts: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === 'GET') return Response.json({ object: 'list', data: [] })
      posts.push((await req.json()) as Record<string, unknown>)
      return respond()
    },
  })
  return { url: `http://localhost:${server.port}/v1`, posts, stop: () => server.stop(true) }
}

// 8 CJK pieces: 夜风|掠过|秘档|库，|顾长|风按|住星|盘。
const ZH_TEXT = '夜风掠过秘档库，顾长风按住星盘。'
const ZH_DELTAS = ['夜风掠过', '秘档库，', '顾长风按住', '星盘。'] as const

describe('LlmProvider · zh mode', () => {
  test('zh prompt: Chinese serial ask featuring the zh cast (request body captured)', async () => {
    const srv = startServer(() => textResponse(ZH_DELTAS))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url, lang: 'zh' })
      expect(provider.lang).toBe('zh')
      const s = spec({ glyph: 'A', theme: 'archive', targetTokens: 8 })
      await drain(provider.nextChunk(s))

      expect(srv.posts.length).toBe(1)
      const messages = srv.posts[0]!.messages as { role: string; content: string }[]
      expect(messages[0]!.role).toBe('system')
      expect(messages[0]!.content).toContain('中文') // asks for Chinese prose
      expect(messages[0]!.content).toContain('40到80字') // 40–80 token paragraph
      expect(messages[1]!.role).toBe('user')
      expect(messages[1]!.content).toContain(characterZhFor('A').name) // 顾长风
      expect(messages[1]!.content).toContain('秘档库') // zh theme flavor
      expect(messages[1]!.content).not.toContain(characterFor('A').name) // no English cast
    } finally {
      srv.stop()
    }
  })

  test('CJK prose streams as 1–2-grapheme pieces; count feeds targetTokens', async () => {
    const srv = startServer(() => textResponse(ZH_DELTAS))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url, lang: 'zh' })
      const pieces = await drain(provider.nextChunk(spec({ targetTokens: 8 })))
      expect(pieces).toEqual(['夜风', '掠过', '秘档', '库，', '顾长', '风按', '住星', '盘。'])
      for (const p of pieces) expect(graphemes(p).length).toBeLessThanOrEqual(2)
      expect(pieces.join('')).toBe(ZH_TEXT) // lossless, no synthetic spaces
      const st = provider.stats()
      expect(st.live).toBe(1) // 8 pieces ≥ targetTokens 8 — fully live
      expect(st.padded).toBe(0)
    } finally {
      srv.stop()
    }
  })

  test('early stop pads from scripted — ENGLISH padding, flagged as accepted', async () => {
    const srv = startServer(() => textResponse(ZH_DELTAS))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url, lang: 'zh' })
      const s = spec({ targetTokens: 14 })
      const pieces = await drain(provider.nextChunk(s))
      expect(pieces.length).toBe(14) // 8 live CJK + 6 padded
      expect(pieces.slice(0, 8).join('')).toBe(ZH_TEXT)
      expect(pieces.slice(8)).toEqual([...scriptedPieces(s)].slice(0, 6)) // English scripted
      expect(provider.stats().padded).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test('en mode prompt is unchanged (default + explicit)', () => {
    const s = spec({ glyph: 'K', theme: 'engine' })
    expect(buildMessages(s)).toEqual(buildMessages(s, 'en'))
    const en = buildMessages(s, 'en')
    expect(en[1]!.content).toContain(characterFor('K').name)
    const zh = buildMessages(s, 'zh')
    expect(zh[1]!.content).toContain(characterZhFor('K').name)
    expect(zh[0]!.content).not.toContain('paragraph') // fully Chinese system voice
  })
})

describe('LlmProvider · nameFor (story-language cast seam)', () => {
  test('zh provider serves the Chinese cast; en provider matches scripted', () => {
    const zh = new LlmProvider({ baseUrl: 'http://stub.invalid/v1', lang: 'zh' })
    const en = new LlmProvider({ baseUrl: 'http://stub.invalid/v1', lang: 'en' })
    expect(zh.nameFor('A')).toBe(characterZhFor('A').name)
    expect(zh.nameFor('A')).toBe('顾长风')
    expect(en.nameFor('A')).toBe(characterFor('A').name)
    expect(en.nameFor('A')).toBe('Auric Vayle')
    // total + deterministic over the alphabet (10 zh names cover 26 glyphs)
    for (const g of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(zh.nameFor(g)).toBe(zh.nameFor(g))
      expect(zh.nameFor(g).length).toBeGreaterThan(0)
      expect(zh.nameFor(g)).toBe(characterZhFor(g).name)
    }
    expect(characterZhFor('K').name).toBe(characterZhFor('A').name) // K = (10 % 10) → slot 0
    expect(characterZhFor('?').name).toBe('无名客') // unknown glyph: deterministic stranger
  })
})

describe('LlmProvider · OOM_LLM_LANG env', () => {
  test('env selects zh; explicit option beats env; default is en', () => {
    const saved = process.env.OOM_LLM_LANG
    try {
      delete process.env.OOM_LLM_LANG
      expect(new LlmProvider({ baseUrl: 'http://stub.invalid/v1' }).lang).toBe('en')
      process.env.OOM_LLM_LANG = 'zh'
      expect(new LlmProvider({ baseUrl: 'http://stub.invalid/v1' }).lang).toBe('zh')
      expect(new LlmProvider({ baseUrl: 'http://stub.invalid/v1', lang: 'en' }).lang).toBe('en')
      process.env.OOM_LLM_LANG = 'klingon' // unknown → en (never crashes)
      expect(new LlmProvider({ baseUrl: 'http://stub.invalid/v1' }).lang).toBe('en')
    } finally {
      if (saved !== undefined) process.env.OOM_LLM_LANG = saved
      else delete process.env.OOM_LLM_LANG
    }
  })
})
