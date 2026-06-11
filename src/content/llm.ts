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
 *   arrive, each shaped like scripted's: a single word + trailing space.
 * - Narrative consistency: prompts are built from scripted.ts's per-glyph
 *   character table and per-theme motifs (imported, not duplicated).
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
import { characterFor, motifsFor, scriptedPieces } from './scripted'
import { createSanitizer, type StreamSanitizer } from './sanitize'

export interface LlmProviderOptions {
  /** OpenAI-compatible base, e.g. http://localhost:8000/v1 (env OOM_LLM_BASE_URL). */
  baseUrl?: string
  /** Model id (env OOM_LLM_MODEL). */
  model?: string
  /** Optional bearer token (env OOM_LLM_API_KEY). */
  apiKey?: string
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
  /** Sanitized words produced by the model (before any padding). */
  words: number
  ttfwMs: number | null
  genMs: number | null
}

interface Job {
  readonly spec: ChunkSpec
  readonly sanitizer: StreamSanitizer
  readonly abort: AbortController
  words: string[] // sanitized complete words (no trailing space)
  partial: string // word fragment awaiting its delimiter
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

export class LlmProvider implements ContentProvider {
  readonly baseUrl: string
  readonly model: string

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
      messages: buildMessages(job.spec),
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

  /** Sanitized text → whole words (single space delimited by sanitizer). */
  private acceptText(job: Job, sanitized: string): void {
    if (sanitized === '') return
    job.partial += sanitized
    const parts = job.partial.split(' ')
    job.partial = parts.pop() ?? ''
    let any = false
    for (const w of parts) {
      if (w !== '') {
        job.words.push(w)
        any = true
      }
    }
    if (any) {
      job.lastWordAt = this.now()
      if (job.firstWordAt === null) job.firstWordAt = job.lastWordAt
      this.wake(job)
    }
  }

  private finishWords(job: Job): void {
    this.acceptText(job, job.sanitizer.flush())
    if (job.partial !== '') {
      job.words.push(job.partial)
      job.partial = ''
      job.lastWordAt = this.now()
      if (job.firstWordAt === null) job.firstWordAt = job.lastWordAt
      this.wake(job)
    }
  }

  // ── the chunk stream (consumer side) ────────────────────────────────────

  /**
   * Yield live words instantly as they land in the buffer; on a stall
   * (budgets exceeded) or early stop, finish the chunk from scripted. The
   * piece shape and the ≥ targetTokens guarantee match ScriptedProvider.
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
          yield `${w} `
          continue
        }
        if (job.done) break
        if (this.isStalled(job)) {
          job.abandoned = true
          job.abort.abort()
          this.enterDegraded(`chunk ${spec.chunkId}: stream stalled after ${sent} words — scripted takes over mid-chunk`)
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
      // would tear the generator down before a post-loop count).
      this.stats_.padded++
      let padded = 0
      for (const piece of scriptedPieces(spec)) {
        if (sent >= target) break
        sent++
        padded++
        yield piece
      }
      this.log(`chunk ${spec.chunkId}: model gave ${live}/${target} words — padded +${padded} from scripted`)
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

// ── prompt (spec → messages; §5.4: structured spec, one vivid paragraph) ──

export function buildMessages(spec: ChunkSpec): { role: string; content: string }[] {
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
