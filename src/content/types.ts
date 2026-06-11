/**
 * content — the stage-1/stage-2 seam (OOM_DESIGN.md §5.3).
 *
 * OWNED BY THE INTEGRATOR — implementation work must not edit this file.
 *
 * The director decides WHAT (ChunkSpec); a provider only decides the
 * WORDS. Sim state never depends on prose: providers feed the game/UI
 * layer only. Pillar 4: the game must be 100% playable with the LLM off.
 */

import type { ChunkSpec } from '../sim/types'

export interface ContentProvider {
  /**
   * Stream the prose for one chunk as token-ish pieces (words or small
   * word groups, whitespace included by the producer). Must yield at
   * least spec.targetTokens pieces; the consumer stops pulling at the
   * spec'd count. ScriptedProvider must be fully deterministic from
   * spec.seed.
   */
  nextChunk(spec: ChunkSpec): AsyncIterable<string>
}

/**
 * Stage-2 LlmProvider contract (implemented later): OpenAI-compatible
 * streaming endpoint via env (OOM_LLM_BASE_URL, OOM_LLM_MODEL,
 * OOM_LLM_API_KEY). Generation runs AHEAD into a buffer; display drains
 * at ticksPerSec; on underrun the game falls back to ScriptedProvider
 * mid-chunk without blocking (§5.3 "two clocks"). All LLM text passes
 * through sanitize() — strip control chars, ANSI, zero-width tricks;
 * never parsed for game state (§5.4).
 */
export const CONTENT_CONTRACT_VERSION = 1
