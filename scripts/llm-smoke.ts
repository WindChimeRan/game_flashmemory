#!/usr/bin/env bun
/**
 * llm-smoke — MANUAL smoke for LlmProvider against a live endpoint.
 * Not part of `bun test` (lives in scripts/; LLM mode is non-deterministic).
 *
 * Usage:
 *   bun scripts/llm-smoke.ts [--url http://localhost:8000/v1] [--model M]
 *   (env OOM_LLM_BASE_URL / OOM_LLM_MODEL / OOM_LLM_API_KEY also apply)
 *
 * Requests 3 chunks for fixed specs, prints the sanitized prose, TTFW,
 * total time and tokens/s (SSE content deltas ≈ tokens on vLLM).
 */

import { LlmProvider } from '../src/content/llm'
import type { ChunkSpec } from '../src/sim/types'

function wrap(text: string, width: number): string {
  const words = text.split(' ')
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const cand = cur === '' ? w : `${cur} ${w}`
    if (cand.length <= width) cur = cand
    else {
      if (cur !== '') lines.push(cur)
      cur = w
    }
  }
  if (cur !== '') lines.push(cur)
  return lines.map((l) => `   ${l}`).join('\n')
}

const args = process.argv.slice(2)
let url: string | undefined
let model: string | undefined
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url') url = args[++i]
  else if (args[i] === '--model') model = args[++i]
  else {
    console.error(`unknown flag '${args[i]}' (use --url, --model)`)
    process.exit(2)
  }
}

const SPECS: ChunkSpec[] = [
  { chunkId: 0, glyph: 'A', theme: 'archive', targetTokens: 60, seed: 101 },
  { chunkId: 1, glyph: 'K', theme: 'engine', targetTokens: 60, seed: 202 },
  { chunkId: 2, glyph: 'Z', theme: 'storm', targetTokens: 60, seed: 303 },
]

const provider = new LlmProvider({ baseUrl: url, model, log: (m) => console.error(`  [llm] ${m}`) })
console.log(`endpoint  ${provider.baseUrl}`)
console.log(`model     ${provider.model}`)
const reachable = await provider.probe(2000)
console.log(`probe     ${reachable ? 'live' : 'UNREACHABLE (will degrade to scripted)'}`)

for (const spec of SPECS) {
  const t0 = performance.now()
  let tFirst: number | null = null
  const pieces: string[] = []
  for await (const piece of provider.nextChunk(spec)) {
    if (tFirst === null) tFirst = performance.now()
    pieces.push(piece)
  }
  const t1 = performance.now()
  const info = provider.inspect(spec.chunkId)
  console.log(`\n── chunk ${spec.chunkId} · glyph ${spec.glyph} · theme ${spec.theme} ${'─'.repeat(40)}`)
  console.log(wrap(pieces.join('').trimEnd(), 76))
  const ttfw = tFirst !== null ? `${(tFirst - t0).toFixed(0)}ms` : '—'
  let gen = 'no live generation'
  if (info && info.genMs !== null && info.genMs > 0) {
    gen = `${info.deltas} deltas · ${((info.deltas * 1000) / info.genMs).toFixed(1)} tok/s · ${info.words} live words`
  }
  console.log(`   pieces ${pieces.length} · ttfw ${ttfw} · total ${(t1 - t0).toFixed(0)}ms · ${gen}`)
}

const s = provider.stats()
console.log(`\nstats: ${s.live} live · ${s.padded} padded · ${s.fallback} scripted · degraded=${s.degraded}`)
process.exitCode = s.live + s.padded === SPECS.length ? 0 : 1
