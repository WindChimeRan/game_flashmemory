/**
 * LlmProvider (Stage 2, OOM_DESIGN.md §5.3–§5.4) — streams chunk prose from
 * an OpenAI-compatible /chat/completions endpoint (vllm-metal first, any
 * compatible server via env/flags).
 *
 * Laws honored:
 * - Two clocks (§5.3): generation runs ahead per chunk into a buffer; the
 *   sim never waits. The chunk stream yields buffered words instantly; when
 *   the network can't keep pace (TTFW / word-gap budgets) it falls back to
 *   ScriptedProvider MID-CHUNK and the provider enters degraded mode with a
 *   timed auto-retry probe. The game never blocks on the LLM.
 * - Sanitization boundary (§5.4): every byte of model output passes through
 *   createSanitizer() (ANSI/C0/C1/zero-width/bidi/think-spans) before it
 *   can reach the layout engine. LLM text is NEVER parsed for game state.
 * - Pillar 4: prose is texture. Every failure path degrades to the exact
 *   deterministic ScriptedProvider stream for the same spec — total
 *   failure reproduces ScriptedProvider verbatim; an early model stop pads
 *   the tail from scripted (logged) so ≥ spec.targetTokens pieces always
 *   arrive. Latin pieces keep scripted's shape (a single word + trailing
 *   space); CJK prose has no spaces, so wide-grapheme runs split into
 *   1–2-grapheme pieces (splitPieces below) so the 1-piece-per-tick reveal
 *   still flows.
 * - Narrative consistency: prompts are built from scripted.ts's per-glyph
 *   character table and per-theme motifs (imported, not duplicated). In zh
 *   mode (lang: 'zh' / --llm-lang zh / OOM_LLM_LANG) prompts ask for one
 *   Chinese serial paragraph featuring a parallel Chinese cast (CAST_ZH).
 *   HONESTY NOTE: scripted fallback/padding is English-only for now — a zh
 *   chunk that stalls or stops early is padded with ENGLISH scripted prose.
 *   Accepted and flagged; the fallback narrator has no zh voice yet.
 *
 * Buffer-ahead: `lookahead` (default 2) caps concurrent generations. The
 * game calls nextChunk in spawn order; jobs beyond the cap queue FIFO in an
 * internal prefetch queue keyed by chunkId (a restart with the same seed
 * reuses the cached generation instead of re-asking the model).
 *
 * Qwen3 note: the model emits `<think>…</think>` by default. Requests carry
 * the vLLM extension `chat_template_kwargs: {enable_thinking: false}`; if
 * the server 400s on it, the request is retried once WITHOUT the field, and
 * the sanitizer strips any think spans regardless (belt and suspenders).
 * `delta.reasoning_content` (reasoning-parser servers) is ignored entirely.
 *
 * Wall-clock note: D4's no-wall-clock rule is what keeps sim + scripted
 * deterministic; this provider is the explicitly non-deterministic stage-2
 * texture layer, so its pacing budgets use an injectable now() (stubbed in
 * tests; scripted fallback stays bit-identical to ScriptedProvider).
 */

import type { ChunkSpec } from '../sim/types'
import type { ContentProvider } from './types'
import { characterFor, motifsFor, scriptedPieces, type Character } from './scripted'
import { createSanitizer, type StreamSanitizer } from './sanitize'
import { cellWidth, graphemes } from '../shared/width'

/** Story language for prompts + character names ('en' default). */
export type LlmLang = 'en' | 'zh'

export interface LlmProviderOptions {
  /** OpenAI-compatible base, e.g. http://localhost:8000/v1 (env OOM_LLM_BASE_URL). */
  baseUrl?: string
  /** Model id (env OOM_LLM_MODEL). */
  model?: string
  /** Optional bearer token (env OOM_LLM_API_KEY). */
  apiKey?: string
  /**
   * Story language (env OOM_LLM_LANG; default 'en'). 'zh' prompts for one
   * Chinese serial paragraph per chunk and switches the cast to CAST_ZH.
   * Scripted fallback/padding stays English (no zh narrator yet — flagged).
   */
  lang?: LlmLang
  /** Max concurrent chunk generations (prefetch lanes). Default 2. */
  lookahead?: number
  /** Sampling temperature. Default 0.8 (§5.4: modest). */
  temperature?: number
  /** Hard max_tokens cap per request. Default 160 (≈ a 40–80-word paragraph). */
  maxTokens?: number
  /** Grace before first word arrives (TTFW) → mid-chunk fallback. Default 5000ms. */
  firstWordMs?: number
  /** Max mid-stream gap between words → mid-chunk fallback. Default 1200ms. */
  wordWaitMs?: number
  /** Max wait in the prefetch queue before fallback. Default 15000ms. */
  queueGraceMs?: number
  /** Degraded-mode cooldown before auto-retry probes. Default 4000ms. */
  retryAfterMs?: number
  /** Hard abort for one generation request. Default 30000ms. */
  jobTimeoutMs?: number
  /** Event sink (also kept in an internal ring; NEVER writes to the TTY itself). */
  log?: (msg: string) => void
  /** Injection points for tests. */
  fetchFn?: typeof fetch
  now?: () => number
}

export interface LlmStats {
  /** Chunks fully served from live model output. */
  live: number
  /** Chunks that started live and were padded from scripted. */
  padded: number
  /** Chunks served entirely from scripted (error / degraded cooldown). */
  fallback: number
  degraded: boolean
  events: readonly string[]
}

export interface LlmJobInfo {
  /** Non-empty content deltas received (≈ tokens for vLLM). */
  deltas: number
  /** Sanitized reveal pieces produced by the model (before any padding). */
  words: number
  ttfwMs: number | null
  genMs: number | null
}

interface Job {
  readonly spec: ChunkSpec
  readonly sanitizer: StreamSanitizer
  readonly abort: AbortController
  words: string[] // sanitized settled pieces, whitespace included (splitPieces)
  partial: string // unsettled tail awaiting more text (splitPieces rest)
  deltas: number
  started: boolean
  done: boolean
  failed: boolean
  abandoned: boolean // consumer gave up / intentional abort — not an error
  enqueuedAt: number
  startedAt: number
  firstWordAt: number | null
  lastWordAt: number | null
  doneAt: number | null
  notify: (() => void) | null
}

const EVENTS_MAX = 100
const JOBS_MAX = 256

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── CJK-aware piece splitting (pure) ─────────────────────────────────────

/** CJK punctuation that clings to the piece before it (never starts one). */
const CLING_PUNCT = new Set([
  '。', '，', '、', '！', '？', '；', '：', '…',
  '”', '’', '）', '」', '』', '】', '》', '〉',
])

export interface PieceSplit {
  /** Settled reveal pieces, whitespace included (Latin words carry ' '). */
  pieces: string[]
  /** Unsettled tail — re-feed as `rest + nextDelta`. Empty when final. */
  rest: string
}

/**
 * Split sanitized prose (single-space whitespace, see sanitize.ts) into
 * reveal pieces:
 * - whitespace-delimited Latin/narrow runs stay whole words, trailing
 *   space attached (synthesized at end of stream — scripted's shape);
 * - whitespace-free runs of wide graphemes (CJK prose) split into pieces
 *   of 1–2 graphemes (graphemes() + cellWidth(g) === 2);
 * - CJK punctuation (。，、！？…) clings to the preceding piece; a full
 *   2-grapheme piece re-splits 1+1 so punctuated pieces stay ≤ 2 graphemes.
 *
 * Streaming (`final = false`) keeps the unsettled tail in `rest` — the
 * open run, or a closed last piece that punctuation could still cling to
 * (one not sealed by a space) — so a re-split of `rest + delta` never
 * contradicts already-emitted pieces. Space-sealed pieces emit at the same
 * cadence the old word splitter had.
 */
export function splitPieces(text: string, final: boolean): PieceSplit {
  const pieces: string[] = []
  let run: string[] = [] // graphemes of the piece under construction
  let latin = false // run is a narrow word: closes on space / punct / CJK

  const close = (extra = ''): void => {
    if (run.length > 0 || extra !== '') pieces.push(run.join('') + extra)
    run = []
    latin = false
  }
  /** Append to the latest closed piece (cling) — never across a space. */
  const clingTo = (s: string): boolean => {
    const last = pieces.length - 1
    if (last < 0 || pieces[last]!.endsWith(' ')) return false
    pieces[last]! += s
    return true
  }

  for (const g of graphemes(text)) {
    if (g === ' ') {
      if (run.length > 0) close(' ')
      else if (!clingTo(' ')) {
        /* leading space: dropped (sanitizer trims; defensive) */
      }
      continue
    }
    if (CLING_PUNCT.has(g)) {
      if (latin && run.length > 0) {
        run.push(g)
        close()
      } else if (run.length === 2) {
        // a held wide pair re-splits 1+1 so the punctuated piece stays ≤ 2
        pieces.push(run[0]!)
        pieces.push(run[1]! + g)
        run = []
        latin = false
      } else if (run.length === 1) {
        run.push(g)
        close()
      } else if (!clingTo(g)) {
        close(g) // degenerate: leading punctuation stands alone
      }
      continue
    }
    if (cellWidth(g) === 2) {
      if (latin && run.length > 0) close() // word→CJK boundary (no space in source)
      latin = false
      if (run.length === 2) close() // wide pair held until its follower decides
      run.push(g)
      continue
    }
    // narrow non-space: a Latin-ish word grows until whitespace
    if (!latin && run.length > 0) close() // CJK→word boundary
    latin = true
    run.push(g)
  }

  if (final) {
    if (run.length > 0) close(latin ? ' ' : '') // last Latin word gets its space
    return { pieces, rest: '' }
  }
  if (run.length > 0) return { pieces, rest: run.join('') } // open run = the tail
  const last = pieces.length > 0 ? pieces[pieces.length - 1]! : ''
  if (last !== '' && !last.endsWith(' ')) {
    return { pieces: pieces.slice(0, -1), rest: last } // punct could still cling
  }
  return { pieces, rest: '' }
}

export class LlmProvider implements ContentProvider {
  readonly baseUrl: string
  readonly model: string
  readonly lang: LlmLang

  private readonly apiKey: string | undefined
  private readonly lookahead: number
  private readonly temperature: number
  private readonly maxTokens: number
  private readonly firstWordMs: number
  private readonly wordWaitMs: number
  private readonly queueGraceMs: number
  private readonly retryAfterMs: number
  private readonly jobTimeoutMs: number
  private readonly onLog: ((msg: string) => void) | null
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly pollMs: number

  private readonly jobs = new Map<number, Job>()
  private readonly waitQueue: Job[] = []
  private active = 0
  private degradedSince: number | null = null
  private nextProbeAt = 0
  private readonly events: string[] = []
  private readonly stats_ = { live: 0, padded: 0, fallback: 0 }

  constructor(opts: LlmProviderOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : {}
    this.baseUrl = (opts.baseUrl ?? env.OOM_LLM_BASE_URL ?? 'http://localhost:8000/v1').replace(/\/+$/, '')
    this.model = opts.model ?? env.OOM_LLM_MODEL ?? 'Qwen/Qwen3-0.6B'
    this.lang = opts.lang ?? (env.OOM_LLM_LANG === 'zh' ? 'zh' : 'en')
    this.apiKey = opts.apiKey ?? env.OOM_LLM_API_KEY
    this.lookahead = Math.max(1, Math.floor(opts.lookahead ?? 2))
    this.temperature = opts.temperature ?? 0.8
    this.maxTokens = Math.max(16, Math.floor(opts.maxTokens ?? 160))
    this.firstWordMs = opts.firstWordMs ?? 5000
    this.wordWaitMs = opts.wordWaitMs ?? 1200
    this.queueGraceMs = opts.queueGraceMs ?? 15000
    this.retryAfterMs = opts.retryAfterMs ?? 4000
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 30000
    this.onLog = opts.log ?? null
    this.fetchFn = opts.fetchFn ?? fetch
    this.now = opts.now ?? (() => performance.now())
    this.pollMs = Math.min(100, Math.max(5, Math.floor(Math.min(this.firstWordMs, this.wordWaitMs) / 4)))
  }

  get degraded(): boolean {
    return this.degradedSince !== null
  }

  stats(): LlmStats {
    return { ...this.stats_, degraded: this.degraded, events: [...this.events] }
  }

  /** Per-chunk generation info (smoke/debug; null if never attempted live). */
  inspect(chunkId: number): LlmJobInfo | null {
    const job = this.jobs.get(chunkId)
    if (!job) return null
    return {
      deltas: job.deltas,
      words: job.words.length,
      ttfwMs: job.firstWordAt !== null ? job.firstWordAt - job.startedAt : null,
      genMs: job.doneAt !== null && job.started ? job.doneAt - job.startedAt : null,
    }
  }

  /** Quick reachability check of `${baseUrl}/models` (CLI status line). */
  async probe(timeoutMs = 1500): Promise<boolean> {
    try {
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), timeoutMs)
      ;(t as unknown as { unref?: () => void }).unref?.()
      const res = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: this.headers(false),
        signal: ac.signal,
      })
      clearTimeout(t)
      return res.ok
    } catch {
      return false
    }
  }

  nextChunk(spec: ChunkSpec): AsyncIterable<string> {
    const job = this.acquireJob(spec)
    if (job === null) return this.scriptedStream(spec)
    return this.streamJob(job)
  }

  /** ContentProvider.nameFor — chunk headers match the story language. */
  nameFor(glyph: string): string {
    return (this.lang === 'zh' ? characterZhFor(glyph) : characterFor(glyph)).name
  }

  // ── job lifecycle ───────────────────────────────────────────────────────

  /** Sync: reuse cache / honor degraded cooldown / enqueue a generation. */
  private acquireJob(spec: ChunkSpec): Job | null {
    const cached = this.jobs.get(spec.chunkId)
    if (cached && cached.spec.seed === spec.seed && cached.spec.targetTokens === spec.targetTokens) {
      return cached // restart with the same seed replays the cached stream
    }
    if (cached) {
      cached.abandoned = true
      cached.abort.abort()
      this.jobs.delete(spec.chunkId)
    }
    const now = this.now()
    if (this.degradedSince !== null) {
      if (now < this.nextProbeAt) {
        this.stats_.fallback++
        this.log(`chunk ${spec.chunkId}: degraded — scripted prose (auto-retry pending)`)
        return null
      }
      this.nextProbeAt = now + this.retryAfterMs // re-arm so failures don't hammer
      this.log(`chunk ${spec.chunkId}: degraded — probing the endpoint again`)
    }
    const job: Job = {
      spec,
      sanitizer: createSanitizer(),
      abort: new AbortController(),
      words: [],
      partial: '',
      deltas: 0,
      started: false,
      done: false,
      failed: false,
      abandoned: false,
      enqueuedAt: now,
      startedAt: now,
      firstWordAt: null,
      lastWordAt: null,
      doneAt: null,
      notify: null,
    }
    this.jobs.set(spec.chunkId, job)
    this.evictOldJobs()
    if (this.active < this.lookahead) this.startJob(job)
    else this.waitQueue.push(job)
    return job
  }

  private startJob(job: Job): void {
    if (job.abandoned) {
      job.done = true
      this.wake(job)
      return
    }
    this.active++
    job.started = true
    void this.runJob(job)
  }

  private releaseSlot(): void {
    this.active--
    while (this.active < this.lookahead) {
      const next = this.waitQueue.shift()
      if (!next) return
      this.startJob(next)
      if (next.started) return // took the slot; abandoned ones loop again
    }
  }

  private evictOldJobs(): void {
    if (this.jobs.size <= JOBS_MAX) return
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= JOBS_MAX) return
      if (job.done) this.jobs.delete(id)
    }
  }

  /** The network side: request → SSE → sanitizer → word buffer. */
  private async runJob(job: Job): Promise<void> {
    job.startedAt = this.now()
    const timer = setTimeout(() => job.abort.abort(), this.jobTimeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
    try {
      let res = await this.request(job, true)
      if (res.status === 400) {
        // vLLM extension chat_template_kwargs may be rejected by other
        // servers — retry once without it (sanitizer still strips thinks).
        this.log(`chunk ${job.spec.chunkId}: 400 with chat_template_kwargs — retrying without`)
        void res.body?.cancel().catch(() => {})
        res = await this.request(job, false)
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {})
        throw new Error(`HTTP ${res.status}`)
      }
      if (!res.body) throw new Error('response has no body')
      await this.consumeSse(res.body, job)
      this.finishWords(job)
      if (job.words.length > 0 && this.degradedSince !== null) {
        this.degradedSince = null
        this.log('endpoint recovered — live prose resumed')
      }
    } catch (err) {
      if (!job.abandoned) {
        job.failed = true
        this.enterDegraded(`chunk ${job.spec.chunkId}: ${errMsg(err)}`)
      }
    } finally {
      clearTimeout(timer)
      job.done = true
      job.doneAt = this.now()
      this.wake(job)
      this.releaseSlot()
    }
  }

  private headers(post: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (post) h['content-type'] = 'application/json'
    if (this.apiKey !== undefined && this.apiKey !== '') h['authorization'] = `Bearer ${this.apiKey}`
    return h
  }

  private request(job: Job, withTemplateKwargs: boolean): Promise<Response> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: buildMessages(job.spec, this.lang),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
      stream: true,
      seed: job.spec.seed >>> 0,
      stop: ['\n\n'],
    }
    if (withTemplateKwargs) body['chat_template_kwargs'] = { enable_thinking: false }
    return this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal: job.abort.signal,
    })
  }

  /** Split-chunk-safe SSE line parser (zero deps). */
  private async consumeSse(body: ReadableStream<Uint8Array>, job: Job): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (this.handleSseLine(line, job)) return
        }
      }
      buf += decoder.decode()
      if (buf !== '') this.handleSseLine(buf, job)
    } finally {
      // [DONE] returns early with the connection possibly still open —
      // cancel (no-op after natural end) so the response never lingers.
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** Returns true on the [DONE] sentinel. */
  private handleSseLine(rawLine: string, job: Job): boolean {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith('data:')) return false
    const payload = line.slice(5).trim()
    if (payload === '') return false
    if (payload === '[DONE]') return true
    let content = ''
    try {
      const obj = JSON.parse(payload) as {
        choices?: { delta?: { content?: unknown } }[]
      }
      const c = obj.choices?.[0]?.delta?.content
      if (typeof c === 'string') content = c
      // delta.reasoning_content (servers with a reasoning parser) is
      // deliberately ignored — think-text never reaches the screen.
    } catch {
      return false // malformed frame: skip, never crash the stream
    }
    if (content !== '') {
      job.deltas++
      this.acceptText(job, job.sanitizer.push(content))
    }
    return false
  }

  /** Sanitized text → settled reveal pieces (splitPieces; CJK-aware). */
  private acceptText(job: Job, sanitized: string): void {
    if (sanitized === '') return
    const { pieces, rest } = splitPieces(job.partial + sanitized, false)
    job.partial = rest
    this.pushPieces(job, pieces)
  }

  private finishWords(job: Job): void {
    const { pieces } = splitPieces(job.partial + job.sanitizer.flush(), true)
    job.partial = ''
    this.pushPieces(job, pieces)
  }

  private pushPieces(job: Job, pieces: readonly string[]): void {
    if (pieces.length === 0) return
    job.words.push(...pieces)
    job.lastWordAt = this.now()
    if (job.firstWordAt === null) job.firstWordAt = job.lastWordAt
    this.wake(job)
  }

  // ── the chunk stream (consumer side) ────────────────────────────────────

  /**
   * Yield live pieces instantly as they land in the buffer; on a stall
   * (budgets exceeded) or early stop, finish the chunk from scripted. The
   * ≥ targetTokens guarantee matches ScriptedProvider; pieces arrive
   * whitespace-included (Latin: word + trailing space, scripted's shape;
   * CJK: 1–2 graphemes, no artificial spaces).
   */
  private async *streamJob(job: Job): AsyncGenerator<string, void, undefined> {
    const spec = job.spec
    const target = Math.max(1, spec.targetTokens)
    let sent = 0
    try {
      let i = 0
      for (;;) {
        if (i < job.words.length) {
          const w = job.words[i++]!
          sent++
          // Stats are counted AT the target-th yield: the game stops
          // pulling exactly there, which tears this generator down at the
          // yield — code after the loop never runs for a consumed chunk.
          if (sent === target) this.stats_.live++
          yield w
          continue
        }
        if (job.done) break
        if (this.isStalled(job)) {
          job.abandoned = true
          job.abort.abort()
          this.enterDegraded(`chunk ${spec.chunkId}: stream stalled after ${sent} pieces — scripted takes over mid-chunk`)
          break
        }
        await this.waitProgress(job)
      }

      const live = sent
      if (live >= target) return // counted at the target-th live yield
      if (live === 0) {
        // nothing usable arrived: serve the exact ScriptedProvider stream
        this.stats_.fallback++
        this.log(`chunk ${spec.chunkId}: no live words — full scripted fallback`)
        yield* scriptedPieces(spec)
        return
      }
      // partial chunk: pad seamlessly from scripted for the same spec
      // (counted up front — the consumer stops pulling at target, which
      // would tear the generator down before a post-loop count). NOTE:
      // scripted padding is English even in zh mode (no zh narrator yet).
      this.stats_.padded++
      let padded = 0
      for (const piece of scriptedPieces(spec)) {
        if (sent >= target) break
        sent++
        padded++
        yield piece
      }
      this.log(`chunk ${spec.chunkId}: model gave ${live}/${target} pieces — padded +${padded} from scripted`)
    } finally {
      if (!job.done) {
        job.abandoned = true // consumer left early — stop the network side
        job.abort.abort()
      }
    }
  }

  /** Degraded cooldown path: identical to ScriptedProvider for this spec. */
  private async *scriptedStream(spec: ChunkSpec): AsyncGenerator<string, void, undefined> {
    yield* scriptedPieces(spec)
  }

  private isStalled(job: Job): boolean {
    const now = this.now()
    if (!job.started) return now - job.enqueuedAt > this.queueGraceMs
    if (job.words.length === 0) return now - job.startedAt > this.firstWordMs
    return now - (job.lastWordAt ?? job.startedAt) > this.wordWaitMs
  }

  /** Resolve on new progress (wake) or after one poll interval. */
  private waitProgress(job: Job): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (job.notify === wake) job.notify = null
        resolve()
      }, this.pollMs)
      ;(t as unknown as { unref?: () => void }).unref?.()
      const wake = (): void => {
        clearTimeout(t)
        resolve()
      }
      job.notify = wake
    })
  }

  private wake(job: Job): void {
    const n = job.notify
    job.notify = null
    if (n) n()
  }

  private enterDegraded(reason: string): void {
    this.log(reason)
    if (this.degradedSince === null) this.degradedSince = this.now()
    this.nextProbeAt = this.now() + this.retryAfterMs
  }

  private log(msg: string): void {
    this.events.push(msg)
    if (this.events.length > EVENTS_MAX) this.events.shift()
    this.onLog?.(msg)
  }
}

// ── the zh cast (wuxia/sci-fi serial regulars, parallel to scripted CAST) ─

/** 10 recurring zh characters; glyph A–Z maps onto them deterministically. */
const CAST_ZH: readonly Character[] = [
  { name: '顾长风', title: '残骸打捞船长', prop: '一枚黄铜星盘' },
  { name: '沈雁回', title: '引擎巫师', prop: '她的线圈重锤' },
  { name: '楚天阙', title: '走私僧', prop: '一把伪造的圣物钥匙' },
  { name: '苏挽星', title: '虚空信使', prop: '一只封缄的急件箱' },
  { name: '萧夜阑', title: '遗物外科医师', prop: '一柄玻璃骨锯' },
  { name: '白浅墨', title: '风暴领航员', prop: '一只开裂的气压计' },
  { name: '凌虚子', title: '信号修士', prop: '一支银质音叉' },
  { name: '洛繁霜', title: '星图窃贼', prop: '一管自蘸墨的羽笔' },
  { name: '燕惊鸿', title: '赏金档案官', prop: '一座磁石罗盘' },
  { name: '墨千机', title: '夜测绘师', prop: '一架黑曜石经纬仪' },
]

/** zh character for a glyph (total: unknown glyphs get a deterministic stranger). */
export function characterZhFor(glyph: string): Character {
  const key = glyph.length > 0 ? glyph[0]!.toUpperCase() : '?'
  const code = key.charCodeAt(0)
  if (code >= 65 && code <= 90) return CAST_ZH[(code - 65) % CAST_ZH.length]!
  return { name: '无名客', title: '陌路人', prop: '一枚无铭的信物' }
}

/** Director themes in zh (prompt flavor only; falls back to the raw word). */
const THEME_ZH: Record<string, string> = {
  archive: '秘档库',
  harbor: '锈水码头',
  signal: '信号塔',
  orchard: '嫁接果园',
  engine: '引擎舱',
  letters: '密信驿路',
  frontier: '边荒拓地',
  relic: '遗物圣所',
  market: '夜市黑集',
  storm: '风暴前线',
}

// ── prompt (spec → messages; §5.4: structured spec, one vivid paragraph) ──

export function buildMessages(spec: ChunkSpec, lang: LlmLang = 'en'): { role: string; content: string }[] {
  if (lang === 'zh') {
    const who = characterZhFor(spec.glyph)
    const theme = THEME_ZH[spec.theme] ?? spec.theme
    return [
      {
        role: 'system',
        content:
          '你是连载小说《OOM》的叙述者——一部永不完结的科幻武侠通俗连载。文风浓烈、紧凑、具体可感;短句铿锵;每段结尾都悬着钩子。' +
          '只回复一段40到80字的中文正文。不要标题、不要列表、不要引号包裹、不要表情符号、不要任何解说。',
      },
      {
        role: 'user',
        content:
          `续写连载的下一段。本段主角:${who.name},${who.title},随身带着${who.prop}。场景:${theme}。` +
          '只写一段中文,40到80字,生动浓烈,以悬念收尾。',
      },
    ]
  }
  const who = characterFor(spec.glyph)
  const motifs = motifsFor(spec.theme)
  const m = motifs.slice(0, 3).join('; ')
  return [
    {
      role: 'system',
      content:
        'You narrate OOM, an endless pulp science-fantasy serial. Style: vivid, breathless, concrete; short punchy sentences; cliffhanger energy. ' +
        'Reply with exactly one paragraph of 40-80 words. No headings, no lists, no quotes around the text, no emoji, no commentary.',
    },
    {
      role: 'user',
      content:
        `Write the next paragraph of the serial. Feature ${who.name}, ${who.title}, carrying ${who.prop}. ` +
        `Theme "${spec.theme}" — weave in motifs such as ${m}. One paragraph, 40-80 words, pulpy and vivid.`,
    },
  ]
}
