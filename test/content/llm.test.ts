/**
 * LlmProvider tests — fake in-process OpenAI-compatible server (Bun.serve,
 * port 0) plus injected-fetch deterministic byte streams. No live endpoint
 * anywhere; no sim config VALUES (sim types only). Covers the §5.3/§5.4
 * laws: split-frame-safe SSE, sanitizer as the security boundary, the
 * ≥ targetTokens guarantee via mid-chunk scripted padding, instant scripted
 * fallback on server errors, degraded cooldown + auto-retry probe, the
 * enable_thinking 400 retry, env auth header, and prefetch lookahead.
 */

import { describe, expect, test } from 'bun:test'
import type { ChunkSpec } from '../../src/sim/types'
import { LlmProvider, buildMessages } from '../../src/content/llm'
import { characterFor, scriptedPieces } from '../../src/content/scripted'

// ── helpers ──────────────────────────────────────────────────────────────

const spec = (over: Partial<ChunkSpec> = {}): ChunkSpec => ({
  chunkId: 0,
  glyph: 'A',
  theme: 'archive',
  targetTokens: 10,
  seed: 101,
  ...over,
})

/** Drain an entire chunk stream (smoke-style consumer). */
async function drain(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const piece of iter) out.push(piece)
  return out
}

/** Game-style consumer: stops pulling at exactly n pieces (ProseStore.ensure). */
async function drainN(iter: AsyncIterable<string>, n: number): Promise<string[]> {
  const out: string[] = []
  for await (const piece of iter) {
    out.push(piece)
    if (out.length >= n) break
  }
  return out
}

const enc = new TextEncoder()
const frame = (delta: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ id: 'cmpl-test', choices: [{ index: 0, delta }] })}\n\n`
const DONE = 'data: [DONE]\n\n'
const sseFor = (deltas: readonly string[]): string =>
  deltas.map((d) => frame({ content: d })).join('') + DONE

/** Split raw bytes into fixed-size chunks (splits SSE prefixes, JSON tokens, UTF-8, tags). */
function splitBytes(text: string, size: number): Uint8Array[] {
  const bytes = enc.encode(text)
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size))
  return out
}

/** A stream that delivers exactly these byte chunks, one per read. */
function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(chunks[i++]!)
      else c.close()
    },
  })
}

/** fetch stub: every request streams the same SSE bytes, chunked verbatim. */
const fetchChunks = (chunks: readonly Uint8Array[]): typeof fetch =>
  (async (): Promise<Response> =>
    new Response(byteStream(chunks), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })) as unknown as typeof fetch

interface WordRespOpts {
  /** ms between word frames (default 0 = burst). */
  gapMs?: number
  /** Send the words, then hold the connection open forever (stall). */
  hang?: boolean
  /** Called right before the stream closes ([DONE] written). */
  onEnd?: () => void
}

/** OpenAI-style SSE response streaming one word per content delta. */
function wordResponse(words: readonly string[], opts: WordRespOpts = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      try {
        for (const w of words) {
          c.enqueue(enc.encode(frame({ content: `${w} ` })))
          if (opts.gapMs) await Bun.sleep(opts.gapMs)
        }
        if (!opts.hang) {
          c.enqueue(enc.encode(DONE))
          opts.onEnd?.()
          c.close()
        }
      } catch {
        /* client aborted mid-stream — expected in stall tests */
      }
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

interface FakeServer {
  url: string
  /** Parsed POST bodies, in arrival order. */
  posts: Record<string, unknown>[]
  /** authorization header (or null) per request, GETs included, in order. */
  auth: (string | null)[]
  /** start:<seed> markers (POST arrival); tests may push end markers too. */
  events: string[]
  stop(): void
}

/** In-process OpenAI-compatible endpoint on port 0 (GET /models + POST). */
function startServer(
  respond: (post: Record<string, unknown>, n: number) => Response | Promise<Response>,
  events: string[] = [],
): FakeServer {
  const posts: Record<string, unknown>[] = []
  const auth: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      auth.push(req.headers.get('authorization'))
      if (req.method === 'GET') return Response.json({ object: 'list', data: [] })
      const post = (await req.json()) as Record<string, unknown>
      const n = posts.length
      posts.push(post)
      events.push(`start:${String(post.seed)}`)
      return respond(post, n)
    },
  })
  return {
    url: `http://localhost:${server.port}/v1`,
    posts,
    auth,
    events,
    stop: () => server.stop(true),
  }
}

const WORDS12 = [
  'Auric', 'strode', 'the', 'stacks', 'with', 'his',
  'astrolabe', 'high', 'and', 'unafraid', 'tonight', 'onward',
] as const

// ── live streaming against the fake server ───────────────────────────────

describe('LlmProvider · fake server', () => {
  test('happy path: live sanitized words, scripted piece shape, honest request', async () => {
    const srv = startServer(() => wordResponse(WORDS12))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url, model: 'test-model' })
      expect(await provider.probe()).toBe(true)

      const s = spec({ targetTokens: 10 })
      const pieces = await drain(provider.nextChunk(s))
      expect(pieces.length).toBeGreaterThanOrEqual(10)
      expect(pieces.every((p) => /^\S+ $/.test(p))).toBe(true) // scripted's shape
      expect(pieces.join('')).toBe(WORDS12.map((w) => `${w} `).join(''))

      const st = provider.stats()
      expect(st.live).toBe(1)
      expect(st.padded).toBe(0)
      expect(st.fallback).toBe(0)
      expect(st.degraded).toBe(false)

      // request shape: streaming, seeded, capped, thinking disabled
      expect(srv.posts.length).toBe(1)
      const post = srv.posts[0]!
      expect(post.model).toBe('test-model')
      expect(post.stream).toBe(true)
      expect(post.seed).toBe(s.seed)
      expect(typeof post.max_tokens).toBe('number')
      expect(post.chat_template_kwargs).toEqual({ enable_thinking: false })
      const messages = post.messages as { role: string; content: string }[]
      expect(messages[0]!.role).toBe('system')
      expect(messages[1]!.content).toContain(characterFor(s.glyph).name)
      expect(messages[1]!.content).toContain(s.theme)
    } finally {
      srv.stop()
    }
  })

  test('game-style consumer (stops at exactly targetTokens) still counts the chunk live', async () => {
    const srv = startServer(() => wordResponse(WORDS12, { gapMs: 1 }))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url })
      const got = await drainN(provider.nextChunk(spec({ targetTokens: 10 })), 10)
      expect(got.length).toBe(10)
      await Bun.sleep(30) // let the abandoned tail abort settle
      const st = provider.stats()
      expect(st.live).toBe(1)
      expect(st.padded).toBe(0)
      expect(st.degraded).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test('early model stop: scripted padding to exactly targetTokens, not a failure', async () => {
    const srv = startServer(() => wordResponse(['alpha', 'beta', 'gamma', 'delta']))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url })
      const s = spec({ targetTokens: 24 })
      const pieces = await drain(provider.nextChunk(s))
      expect(pieces.length).toBe(24) // 4 live + 20 padded, then stop
      expect(pieces.slice(0, 4)).toEqual(['alpha ', 'beta ', 'gamma ', 'delta '])
      expect(pieces.slice(4)).toEqual([...scriptedPieces(s)].slice(0, 20))
      expect(pieces.every((p) => /^\S+ $/.test(p))).toBe(true)
      const st = provider.stats()
      expect(st.padded).toBe(1)
      expect(st.live).toBe(0)
      expect(st.fallback).toBe(0)
      expect(st.degraded).toBe(false) // graceful stop ≠ endpoint failure
    } finally {
      srv.stop()
    }
  })

  test('HTTP 500: instant full scripted fallback (verbatim), degraded set — no hang', async () => {
    const srv = startServer(() => new Response('{"error":"boom"}', { status: 500 }))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url })
      const s = spec({ targetTokens: 16 })
      const t0 = performance.now()
      const pieces = await drain(provider.nextChunk(s))
      const ms = performance.now() - t0
      expect(ms).toBeLessThan(1500) // way under the 5s first-word budget — no stall wait
      expect(pieces).toEqual([...scriptedPieces(s)]) // exact ScriptedProvider stream
      const st = provider.stats()
      expect(st.fallback).toBe(1)
      expect(st.live).toBe(0)
      expect(st.degraded).toBe(true)
    } finally {
      srv.stop()
    }
  })

  test('400 on chat_template_kwargs: retried once without it, then streams live', async () => {
    const srv = startServer((post) =>
      'chat_template_kwargs' in post
        ? new Response('{"error":{"message":"unexpected keyword argument"}}', { status: 400 })
        : wordResponse(WORDS12),
    )
    try {
      const provider = new LlmProvider({ baseUrl: srv.url })
      const pieces = await drain(provider.nextChunk(spec({ targetTokens: 10 })))
      expect(pieces.length).toBeGreaterThanOrEqual(10)
      expect(pieces[0]).toBe('Auric ')
      expect(srv.posts.length).toBe(2)
      expect('chat_template_kwargs' in srv.posts[0]!).toBe(true)
      expect('chat_template_kwargs' in srv.posts[1]!).toBe(false)
      const st = provider.stats()
      expect(st.live).toBe(1)
      expect(st.degraded).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test('Authorization: Bearer sent when OOM_LLM_API_KEY is set (probe + chat); absent otherwise', async () => {
    const srv = startServer(() => wordResponse(['alpha', 'beta', 'gamma']))
    const saved = process.env.OOM_LLM_API_KEY
    try {
      process.env.OOM_LLM_API_KEY = 'sk-oom-test-key'
      const withKey = new LlmProvider({ baseUrl: srv.url })
      delete process.env.OOM_LLM_API_KEY
      const noKey = new LlmProvider({ baseUrl: srv.url })

      expect(await withKey.probe()).toBe(true)
      await drain(withKey.nextChunk(spec({ targetTokens: 3 })))
      await drain(noKey.nextChunk(spec({ targetTokens: 3 })))

      expect(srv.auth[0]).toBe('Bearer sk-oom-test-key') // GET /models
      expect(srv.auth[1]).toBe('Bearer sk-oom-test-key') // POST /chat/completions
      expect(srv.auth[2]).toBeNull()
    } finally {
      if (saved !== undefined) process.env.OOM_LLM_API_KEY = saved
      else delete process.env.OOM_LLM_API_KEY
      srv.stop()
    }
  })

  test('mid-stream stall: pads from scripted, degrades, cooldown is scripted, probe recovers', async () => {
    const srv = startServer((_post, n) =>
      n === 0
        ? wordResponse(['alpha', 'beta', 'gamma'], { hang: true })
        : wordResponse(WORDS12),
    )
    try {
      const provider = new LlmProvider({
        baseUrl: srv.url,
        firstWordMs: 2000,
        wordWaitMs: 80,
        retryAfterMs: 150,
      })

      // 1) stream stalls → scripted takes over mid-chunk. Only 2 complete
      // words are observable live: the trailing 'gamma' fragment never gets
      // its delimiter (or EOF), so it rightly stays buffered, not displayed.
      const s0 = spec({ chunkId: 0, targetTokens: 12, seed: 11 })
      const pieces0 = await drain(provider.nextChunk(s0))
      expect(pieces0.length).toBe(12)
      expect(pieces0.slice(0, 2)).toEqual(['alpha ', 'beta '])
      expect(pieces0.slice(2)).toEqual([...scriptedPieces(s0)].slice(0, 10))
      expect(provider.degraded).toBe(true)
      expect(provider.stats().padded).toBe(1)

      // 2) within the cooldown: scripted verbatim, no network request
      const s1 = spec({ chunkId: 1, targetTokens: 8, seed: 22 })
      const pieces1 = await drain(provider.nextChunk(s1))
      expect(pieces1).toEqual([...scriptedPieces(s1)])
      expect(srv.posts.length).toBe(1)
      expect(provider.stats().fallback).toBe(1)

      // 3) after the cooldown: auto-retry probes the endpoint and recovers
      await Bun.sleep(250)
      const s2 = spec({ chunkId: 2, targetTokens: 8, seed: 33 })
      const pieces2 = await drain(provider.nextChunk(s2))
      expect(srv.posts.length).toBe(2)
      expect(pieces2.length).toBeGreaterThanOrEqual(8)
      expect(pieces2[0]).toBe('Auric ')
      expect(provider.degraded).toBe(false)
    } finally {
      srv.stop()
    }
  }, 10_000)

  test('lookahead caps concurrent generations; queued chunk starts after the first ends', async () => {
    const events: string[] = []
    const srv = startServer(
      (post) =>
        wordResponse(WORDS12, {
          gapMs: 2,
          onEnd: () => events.push(`end:${String(post.seed)}`),
        }),
      events,
    )
    try {
      const provider = new LlmProvider({ baseUrl: srv.url, lookahead: 1 })
      const sA = spec({ chunkId: 0, seed: 101, targetTokens: 8 })
      const sB = spec({ chunkId: 1, seed: 202, targetTokens: 8 })
      const itA = provider.nextChunk(sA) // takes the only lane
      const itB = provider.nextChunk(sB) // queues behind it
      const [a, b] = await Promise.all([drain(itA), drain(itB)])
      expect(a.length).toBeGreaterThanOrEqual(8)
      expect(b.length).toBeGreaterThanOrEqual(8)
      expect(events).toEqual(['start:101', 'end:101', 'start:202', 'end:202'])
      expect(provider.stats().live).toBe(2)
    } finally {
      srv.stop()
    }
  })

  test('same chunkId + seed replays the cached generation — no second request', async () => {
    const srv = startServer(() => wordResponse(WORDS12))
    try {
      const provider = new LlmProvider({ baseUrl: srv.url })
      const s = spec({ targetTokens: 10 })
      const first = await drain(provider.nextChunk(s))
      const second = await drain(provider.nextChunk(s))
      expect(second).toEqual(first)
      expect(srv.posts.length).toBe(1)
    } finally {
      srv.stop()
    }
  })

  test('probe(): true against the fake server, false once it is gone', async () => {
    const srv = startServer(() => wordResponse(['x']))
    const provider = new LlmProvider({ baseUrl: srv.url })
    expect(await provider.probe()).toBe(true)
    srv.stop()
    expect(await provider.probe(500)).toBe(false)
  })
})

// ── split-frame SSE via injected fetch (deterministic byte boundaries) ────

describe('LlmProvider · split-frame SSE (injected fetch)', () => {
  const stub = { baseUrl: 'http://stub.invalid/v1', model: 'stub' }

  test('frames split at every-N-byte boundaries: mid-prefix, mid-JSON, mid-UTF-8', async () => {
    const deltas = ['Auric ', 'wal', 'ked ', 'the ', 'café ', 'rows ', 'at ', 'night ']
    const sse = sseFor(deltas)
    for (const size of [1, 3, 7]) {
      const provider = new LlmProvider({ ...stub, fetchFn: fetchChunks(splitBytes(sse, size)) })
      const pieces = await drain(provider.nextChunk(spec({ targetTokens: 7 })))
      expect(pieces).toEqual(['Auric ', 'walked ', 'the ', 'café ', 'rows ', 'at ', 'night '])
      expect(provider.stats().live).toBe(1)
    }
  })

  test('think span split across deltas AND byte chunks never leaks', async () => {
    const deltas = [
      '<th', 'ink>the pl', 'an is secret</th', 'ink>Real ',
      'words ', 'flow ', 'here ', 'now ', 'and ', 'on ',
    ]
    const sse = sseFor(deltas)
    for (const size of [2, 5, 64]) {
      const provider = new LlmProvider({ ...stub, fetchFn: fetchChunks(splitBytes(sse, size)) })
      const pieces = await drain(provider.nextChunk(spec({ targetTokens: 7 })))
      expect(pieces).toEqual(['Real ', 'words ', 'flow ', 'here ', 'now ', 'and ', 'on '])
      expect(pieces.join('')).not.toContain('secret')
    }
  })

  test('ANSI / OSC / zero-width hostiles are sanitized before reaching the consumer', async () => {
    const ESC = '\u001b'
    const BEL = '\u0007'
    const ZWSP = '\u200b'
    const LRM = '\u200e'
    const deltas = [
      `${ESC}[2J${ESC}[31mRed`, `${ESC}[0m `, `z${ZWSP}${LRM}w `,
      `${ESC}]0;evil-title${BEL}plain `, 'words ', 'end ', 'now ',
    ]
    const provider = new LlmProvider({
      ...stub,
      fetchFn: fetchChunks(splitBytes(sseFor(deltas), 4)),
    })
    const pieces = await drain(provider.nextChunk(spec({ targetTokens: 6 })))
    expect(pieces).toEqual(['Red ', 'zw ', 'plain ', 'words ', 'end ', 'now '])
    for (const p of pieces.join('')) {
      const c = p.codePointAt(0)!
      expect(c >= 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)).toBe(true)
      expect([0x200b, 0x200e].includes(c)).toBe(false)
    }
  })

  test('protocol edges: CRLF, no-space data:, malformed JSON, reasoning_content, post-[DONE] frames', async () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' +
      ': keep-alive\n\n' +
      'data: {"choices":[{"delta":{"reasoning_content":"hidden thoughts"}}]}\n\n' +
      'data: {oops not json\n\n' +
      'data: {"choices":[{"delta":{"content":"one "}}]}\r\n\r\n' +
      'data:{"choices":[{"delta":{"content":"two "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"three "}}]}\n\n' +
      DONE +
      'data: {"choices":[{"delta":{"content":"LEAK "}}]}\n\n'
    const provider = new LlmProvider({ ...stub, fetchFn: fetchChunks(splitBytes(sse, 9)) })
    const pieces = await drain(provider.nextChunk(spec({ targetTokens: 3 })))
    expect(pieces).toEqual(['one ', 'two ', 'three '])
    expect(pieces.join('')).not.toContain('LEAK') // nothing after [DONE] is processed
    expect(pieces.join('')).not.toContain('hidden') // reasoning_content ignored
    expect(provider.stats().live).toBe(1)
  })

  test('a final word with no trailing delimiter is flushed at [DONE]', async () => {
    const provider = new LlmProvider({
      ...stub,
      fetchFn: fetchChunks(splitBytes(sseFor(['alpha ', 'bet', 'a']), 6)),
    })
    const pieces = await drain(provider.nextChunk(spec({ targetTokens: 2 })))
    expect(pieces).toEqual(['alpha ', 'beta '])
  })
})

// ── config & prompt ───────────────────────────────────────────────────────

describe('LlmProvider · env config', () => {
  const KEYS = ['OOM_LLM_BASE_URL', 'OOM_LLM_MODEL', 'OOM_LLM_API_KEY'] as const
  const save = (): (readonly [string, string | undefined])[] => KEYS.map((k) => [k, process.env[k]] as const)
  const restore = (saved: (readonly [string, string | undefined])[]): void => {
    for (const [k, v] of saved) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  }

  test('defaults: http://localhost:8000/v1 + Qwen/Qwen3-0.6B when env is empty', () => {
    const saved = save()
    for (const k of KEYS) delete process.env[k]
    try {
      const p = new LlmProvider()
      expect(p.baseUrl).toBe('http://localhost:8000/v1')
      expect(p.model).toBe('Qwen/Qwen3-0.6B')
    } finally {
      restore(saved)
    }
  })

  test('env vars apply; explicit options beat env; trailing slash trimmed', () => {
    const saved = save()
    try {
      process.env.OOM_LLM_BASE_URL = 'http://example.test:9999/v1/'
      process.env.OOM_LLM_MODEL = 'env-model'
      const p = new LlmProvider()
      expect(p.baseUrl).toBe('http://example.test:9999/v1')
      expect(p.model).toBe('env-model')
      const q = new LlmProvider({ baseUrl: 'http://opt.test/v2', model: 'opt-model' })
      expect(q.baseUrl).toBe('http://opt.test/v2')
      expect(q.model).toBe('opt-model')
    } finally {
      restore(saved)
    }
  })
})

describe('buildMessages', () => {
  test('structured spec → system voice + one-paragraph ask featuring the cast', () => {
    const s = spec({ glyph: 'K', theme: 'engine' })
    const msgs = buildMessages(s)
    expect(msgs.length).toBe(2)
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain('one paragraph')
    expect(msgs[1]!.role).toBe('user')
    const who = characterFor('K')
    expect(msgs[1]!.content).toContain(who.name)
    expect(msgs[1]!.content).toContain(who.prop)
    expect(msgs[1]!.content).toContain('engine')
  })
})
