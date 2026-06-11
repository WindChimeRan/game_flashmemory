# OOM — Design Doc

> **Working title:** `OOM` (alternatives if you prefer: `coldpool`, `evictd`, `swapd`). Your call.
>
> **One-line pitch:** A terminal arcade game where an LLM streams an endless story into a fixed viewport, and *you are the KV-cache eviction & prefetch policy*. Tetris, except the falling blocks are context, and the loss condition is OOM.
>
> **How to read this doc:** §3 (Design Pillars) and §7 (Measuring Fun) are law. Everything else is advisory — improvise freely within the pillars. When in doubt, choose whatever makes the 20-second demo GIF better.
>
> **v1.1 (post-review):** added §4.3 Commitment Structure (law-adjacent — v1 made prediction optional; this makes it necessary), rebuilt §4.4–4.6 with tuning numbers mined from the paper's §2.4 and §3.3, and added the ReactiveBot commitment gate to §7.

This is a long-horizon task. The human will check in occasionally and play builds between your iterations. Work in stages (§6), ping-ponging between them as needed. Take your time; quality and fun over speed.

---

## 1. The Pitch

You are the Memory Indexer for a language model that never stops talking. Story text streams into a fixed-height viewport — your "context window." Paragraphs are **chunks**, each wearing a **glyph badge** (the entity it's about) and a **heat level**. Every τ tokens, a **query wave** arrives demanding certain glyphs: if the matching chunks are resident and expanded, the story flows on; if you evicted them, the narrator *hallucinates* — the text visibly glitches and corrupts, and your coherence meter drops.

You survive by playing prediction, not reaction: **evict** what won't be needed (paragraph collapses into a one-cell chip — animated reflow), **prefetch/expand** what will be (chip unfolds back into prose — animated reflow). Run out of viewport: **OOM, game over.** Miss too many recalls: coherence collapse, game over.

Rounds are 2–4 minutes. Score is a Pareto readout straight from the research it's based on: `survival × recall × (1 − avg residency)` — reward for keeping *little* in memory while never missing a recall.

The whole thing doubles as a playable visualization of how lookahead-sparse-attention serving actually works.

---

## 2. Background & Required Reading

### 2.1 The mechanical blueprint: FlashMemory / Lookahead Sparse Attention

- Paper: **FlashMemory-DeepSeek-V4: Lightning Index Ultra-Long Context via Lookahead Sparse Attention** — https://arxiv.org/abs/2606.09079 (PDF: https://arxiv.org/pdf/2606.09079, v2 June 2026)

What you need from it (read at least the intro, §2.1, §3.1–3.3):

- A **Memory Indexer** triggers every **τ = 64 decoding steps**, predicts which historical KV chunks the *upcoming* window needs, and fetches only those from a CPU cold pool into GPU memory (threshold-based, sigmoid score ≥ 0.5 — not top-k). Result: ~13.5% average residency at equal-or-better accuracy. **The player plays this role.**
- Their control baselines — **Recency-Only** and **Random-10%** — collapse completely on tasks needing global context. These become your **bot players** (§7), and the collapse is your proof the game rewards skill.
- Their failure modes and back-half diagnostics map directly to mechanisms: the **MRCR dense-memory breakdown** (§3.3.2) → boss waves; **context-independent queries** → zen rounds; **leakage accumulation** (§3.3.1) → the distractor fairness model; the **oracle sweeps** (§3.3.2) → the boss-calibration method; the **2× length-generalization cliff** (§3.3.3) → late-run heat degradation; **OR-mode 3-layer routing** (§2.4) → the assist co-pilot. See §4.4–4.6.

Credit the paper prominently in the README. (Poignant detail worth a line there: the project was suspended mid-flight when the lead left Tencent — this game is a small playable monument to an orphaned idea.)

### 2.2 The layout philosophy: Pretext

- Repo: https://github.com/chenglou/pretext
- npm: https://www.npmjs.com/package/@chenglou/pretext
- Official demos: https://chenglou.me/pretext/ · community demos: https://somnai-dreams.github.io/pretext-demos/
- Reflow-as-mechanic browser games (prior art for the *feel*): https://pretext.lol/ (Text Invaders, Text Pong, Text MDR)
- Ecosystem list: https://github.com/bluedusk/awesome-pretext
- ASCII game example: https://github.com/cocktailpeanut/asciisnake

**Important:** Pretext is a *browser* library (Canvas font metrics, proportional text). You cannot use it directly in a terminal, and you don't need its performance story (terminal layout was never slow). What you borrow is its **architecture**:

1. **prepare/layout split** — expensive segmentation & width measurement once; layout as cheap pure arithmetic thereafter.
2. **Cursor-based incremental layout** — re-layout only from the last dirty line as tokens stream; stable scroll anchoring; no flicker.
3. **Diffable positions** — layout is a pure function over stably-identified segments, so you know where every word *was* and *will be* → tween words between positions. This is FLIP animation on a character grid (FLIP concept: https://aerotwist.com/blog/flip-your-animations/).
4. (Stretch) **Variable-width line routing** — text flowing around an exclusion rectangle, something mainstream TUI frameworks can't do.

In the terminal, "measurement" means the Unicode width problem (CJK double-width, emoji ZWJ sequences, the eternally-broken wcwidth) — background reading: https://github.com/jquast/wcwidth. Useful libs: https://github.com/sindresorhus/string-width (JS/TS), https://github.com/unicode-rs/unicode-width + https://github.com/unicode-rs/unicode-segmentation (Rust). In TS, `Intl.Segmenter` (built into Node ≥ 16 / Bun) handles grapheme clustering.

### 2.3 The model backend (Stage 2)

- **vllm-metal** — Apple Silicon Metal backend for vLLM (this is the human's own project; the game is partly a showcase for it): https://github.com/vllm-project/vllm-metal
- vLLM OpenAI-compatible serving docs: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html

The game talks to a generic OpenAI-compatible `/v1/chat/completions` streaming endpoint via env config, so plain vLLM / llama.cpp / Ollama users can also play. A small instruct model (1–8B class, e.g. Qwen or Llama 3.2 sized) is plenty.

### 2.4 Misc references

- Demo GIF tooling: https://github.com/charmbracelet/vhs · https://asciinema.org
- Stretch-goal inspiration (public SSH play server): https://github.com/zachlatta/sshtron
- Optional content corpus (Stage 1 chunk library): https://huggingface.co/datasets/roneneldan/TinyStories (or any public story corpus you judge better)
- TUI frameworks, if you want one: https://github.com/sst/opentui (TS) · https://github.com/vadimdemedes/ink (TS/React) · https://github.com/ratatui/ratatui + https://github.com/crossterm-rs/crossterm (Rust)

---

## 3. Design Pillars — LAW

1. **Reflow is load-bearing.** The expand/collapse/squeeze animations of live text *are* the game's visual identity. Litmus test: if a build would look the same re-skinned with sprites in Unity, the direction is wrong.
2. **Text is material; glyphs are information.** The player must NEVER need to read prose under time pressure. All game-critical state lives in glanceable channels: badges, heat/brightness, countdowns, meters. Prose is texture and reward, optional reading between waves. Cognitive load target: Tetris/Snake — full state visible at a glance, ~one decision per beat.
3. **The player is the indexer.** The core skill is *lookahead prediction* (prefetch before demand), not pure reaction. Eviction alone is housekeeping; prediction is the game. Enforced mechanically by §4.3 — a pillar without an enforcing mechanism is a wish.
4. **The LLM is texture, never truth.** A deterministic game director owns all state, schedules all chunks and waves; the LLM only *realizes prose* from structured specs. The game must be 100% playable and fun with the LLM off.
5. **Fun is measured, not assumed.** You can't feel fun; the bots and metrics in §7 are your senses. Gate stage progress on them, plus the human's PLAYTEST.md notes.

---

## 4. Game Design (loose — improvise within the pillars)

### 4.1 Objects

- **Viewport** — fixed line budget (the context window). Visually a framed column; a memory-pressure gauge tracks fill.
- **Chunk** — a paragraph with: `glyph` (entity badge), `heat` (decaying predicted relevance — rendered as brightness), `tier`, `age`. Tiers mirror the paper's compression hierarchy:
  - **Expanded** — full prose (≈ full KV)
  - **Summary** — one dim line (≈ compressed chunk)
  - **Chip** — single badge cell in a "cold shelf" rail (≈ 128:1 HCA / CPU cold pool)
  - Tier changes are *the* signature animation: text folding/unfolding with downstream words tweening to their new positions.
- **Query wave** — telegraphed `T` beats ahead: shows 1–4 required glyphs + countdown bar. On landing: expanded = full credit, summary = partial, chip = scraps, absent = **MISS**.
- **Miss effect** — engine-side cosmetic corruption of the incoming stream (character substitution, flicker — zalgo-lite), coherence meter drops. Cheap, reliable, no LLM needed for the effect itself.

**Spatial model — deliberately UNFROZEN (first question Stage 1 must settle with real play).** Working default to build against, evidence to overturn: **no free scrolling**; incoming text lands expanded in a **protected strip** (the paper's non-offloadable last-8K analog — the newest chunks can't be tier-downed while streaming), then ages into player-managed territory; chips live on a rail at line-cost zero; **OOM = admission failure** (the next streamed line doesn't fit the viewport budget). The incoming stream is gravity.

### 4.2 Verbs (keep it to ~4–5 keys; exact bindings your call)

Navigate chunk focus · **evict** (tier down) · **prefetch/expand** (begins a tier-up *transfer* — see §4.3) · **pin** (protect from auto-pressure) · maybe one panic "compact-all" with a long cooldown. If you add mouse support, fine, but keyboard-only must be complete.

### 4.3 Commitment structure — what makes prediction *necessary* (law-adjacent)

v1 of this doc ported the indexer's job but not its cost structure, leaving a hole: with instant actions and visible telegraphs, optimal play is whack-a-mole — wait for the telegraph, tap the shown glyphs, win. That kills Pillar 3. Prediction must be forced by mechanics, not requested by a pillar. Defaults below; tune the numbers freely, keep the structure:

- **Fetch latency by tier.** Tier-ups are *transfers*, not toggles: chip→expanded takes `L_cold` beats, summary→expanded takes `L_warm` < `L_cold`, and the unfold animation IS the transfer (CPU cold pool → GPU, diegetically). **Hard rule: `L_cold` > standard-wave telegraph length.** A cold chunk demanded by a standard wave can only arrive in time if the fetch started *before* the telegraph existed — i.e., from prediction (heat trends, glyph history, story sense).
- **Bandwidth budget.** At most `B` transfers in flight simultaneously (and/or per τ-window). Last-second reactive bursts are physically impossible; plans must be staged across beats.
- **In-flight is committed.** Transfers can't be cancelled (or refund only partially). Wrong predictions burn real time and bandwidth — the paper's wasted-fetch cost, made tactile.
- **Optional "faithful mode":** actions queue and execute only on τ boundaries — the paper's literal trigger discipline. Ship it as a modifier, not the default; arcade responsiveness and Pillar 2 outrank fidelity. Test the feel before promoting it.
- Telegraphs stay (they're legibility, Pillar 2) — but they may only *confirm* predictions, never substitute for them.

### 4.4 Wave archetypes — now with numbers (mined from the paper's §3.3)

Define every wave by a **golden set** `G` (required chunks) and a **sufficiency curve** (credit as a function of the fraction of `G` resident-and-expanded at landing). This is the paper's oracle-sweep vocabulary: §3.3.2 found most benchmarks fully recover with 10–25% of golden chunks resident, while MRCR still degrades even at 50%.

- **Standard** — `|G|` = 1–2, guaranteed minimum age, and **cold at telegraph time** (so the §4.3 latency rule bites). Full credit only at full `G`; both the RecencyBot and the ReactiveBot must fail these.
- **MRCR boss** — `|G|` large and scattered across history; credit ramps along the sufficiency curve, full credit only at ≥ ~50% of `G`; telegraphed several τ-windows early. Forces multi-beat staging under the bandwidth cap.
- **No-context zen** — `G = ∅` for a stretch; optimal play is aggressive eviction; bonus scales toward the **O(1) residency floor the paper aimed for and missed** (§3.3.1) — beat the sigmoid gate.
- **Distractor inflation** — fairness model = the paper's **leakage**: distractor *count* grows with absolute history length even as the fraction stays small (they measured ~2.5× absolute inflation going 125K→500K). Rules: distractor heat is *real* heat (no fake UI), but distractor glyphs never appear in telegraphs, and the director caps the global ratio. The fair counterplay is disciplined eviction on absence of evidence.

**Calibration tool (the gem in the paper's back half — use it):** tune archetypes via **oracle sweeps**: run `OracleBot` under capped residency budgets (10% / 25% / 50%) per archetype; a wave's *measured difficulty* is the minimum budget at which the oracle still clears it. Targets: standard ≤ 10–25%, boss ≈ 50%. Boss tuning becomes a number instead of a vibe.

### 4.5 Difficulty, pacing & the 2× cliff

- **Headline knob: `display_tok_s`** — the visible streaming rate. Marketing line: *"difficulty is measured in tokens per second."* (Stretch mode: sync it to the real generation rate of your endpoint — a literal hardware-flex difficulty.)
- Secondary knobs: τ (wave interval), telegraph length, `L_cold` / `L_warm` / `B` (§4.3), viewport budget, glyph alphabet size, distractor rate, heat-decay rate.
- **The 2× cliff (run structure / endless doom clock), from §3.3.3:** the paper's indexer generalizes to exactly 2× its training context, beyond which selection collapses toward random. In-game: each run has a `calibration_length`; while total story history < 2× it, heat is honest. Past the cliff, the heat channel degrades — visible static, decaying signal-to-noise, *irreversibly* (their word). Early run: trust the UI. Late run: trust your own memory of glyph history. Endless mode thus ends by signal rot rather than an arbitrary speed wall; presets move the cliff.
- A round still ramps within itself; provide named presets (chill / default / inferno) and a daily seed.

### 4.6 Assist — the OR-mode co-pilot (from the paper's §2.4)

The paper's production system unions the fetch decisions of three layer-indexers (OR-mode routing across layers 10/12/20) as a robust safety net. Port it as the assist mechanic: an optional **auto-indexer** that auto-starts transfers for anything *it* scores ≥ 0.5, OR'd with the player's actions. It will save your recalls — and every save inflates residency, dragging your Pareto score down: a safety net that taxes exactly the thing you're scored on, which is the paper's own trade-off. Easy mode: assist on. Score attack: assist off ("pure run"). Optional flourish: render heat as up to three consensus pips (three voters) instead of a single brightness scalar — only if it stays glanceable; Pillar 2 outranks fidelity.

### 4.7 Legibility rules

- Badges are single-cell **ASCII letters or box-drawing glyphs + color**, never emoji (terminal width hell). Redundant-code color with the letter (colorblind-safe).
- Minimum terminal size check with a friendly message; degrade gracefully on 256-color terminals; detect truecolor.

---

## 5. Technical Architecture (loose)

### 5.1 `pretext-tui` — the layout engine (build as a reusable, separately-testable module)

This is the durable artifact even beyond the game. API sketch (adapt freely):

- `prepare(text) -> Prepared` — grapheme segmentation, per-segment cell widths (CJK = 2; configurable handling of ambiguous-width), word-break opportunities, **stable segment IDs**. Cached; this is the only "expensive" pass.
- `layout(prepared, width, fromCursor?) -> lines` — pure arithmetic line breaking; **incremental**: on streaming append or local edit, re-layout only from the last stable line.
- `positions(layoutA, layoutB) -> diff` — per-segment (row, col) before/after, feeding FLIP tweens.
- Stretch: `layoutNextLineRange`-style iterator with per-line width, enabling flow around an exclusion rect (a sprite or HUD island — a showcase level later).

**Renderer:** double-buffered cell grid → diff → minimal ANSI writes. Never reprint the full screen per frame (flicker is death, especially over SSH). Target smooth 30–60 fps at 200×50 locally.

**Tests are mandatory here:** golden tests for wrapping with CJK, emoji, ZWJ sequences, combining marks (the game avoids emoji, but the lib must not crash on them); fuzz with random Unicode; property test: re-layout from scratch ≡ incremental layout.

### 5.2 Stack — your call, decide once and justify briefly in README

Default lean: **TypeScript on Bun or Node ≥ 20** (keeps the Pretext homage; `Intl.Segmenter` built in; easy npm distribution) with a **hand-rolled ANSI renderer** — note that Ink's React reconciler fights cell-level FLIP animation, so raw ANSI or OpenTUI is likely a better fit than Ink. **Rust + Ratatui/crossterm** is equally legitimate if you judge it better (unicode-width/-segmentation crates are excellent); Ratatui's Paragraph won't do diffable layout, so you'd still hand-roll the engine either way.

### 5.3 Game core

- **Deterministic simulation**: seeded RNG, fixed-tick update, fully replayable. Rendering is a pure view of sim state — this enables headless bot runs (§7).
- **Director**: schedules chunk spawns and waves to satisfy archetype constraints (e.g., min-age guarantees for required glyphs). Owns all truth. **Feasibility invariant (law):** every spawned wave must be Oracle-clearable under the active `(L_cold, L_warm, B, telegraph)` and the sim state at spawn time — validated constructively when the wave is scheduled (push the land tick, shrink `G`, or reroll until feasible). Gate #5 audits death legibility statistically; this invariant prevents the unwinnable-chart class at the source.
- **ContentProvider interface** (the stage-1/stage-2 seam):

```ts
interface ContentProvider {
  // Director decides WHAT (entity glyph, theme, length hint);
  // provider only decides the WORDS, streamed token-ish.
  nextChunk(spec: ChunkSpec): AsyncIterable<string>;
}
```

- **Two clocks, decoupled**: generation runs ahead into a buffer; display drains at `display_tok_s`. The game NEVER blocks on the LLM. On buffer underrun, transparently fall back to ScriptedProvider mid-chunk.

### 5.4 LLM integration (Stage 2)

- Generic OpenAI-compatible streaming endpoint; config via env (`OOM_LLM_BASE_URL`, `OOM_LLM_MODEL`, optional `OOM_LLM_API_KEY`). Document a vllm-metal quickstart in the README and an "any OpenAI-compatible server" fallback.
- Prompting: structured spec → one vivid 40–80-token paragraph that features the entity; modest temperature; stop sequences; hard token cap.
- **Never parse LLM output for game state.** Sanitize the stream (strip control chars / ANSI / zero-width trickery, normalize whitespace); the layout engine must survive arbitrary text.
- Optional later: a "misremember" prompt variant for misses — but keep the engine-side glitch as the reliable default.

### 5.5 HuggingFace datasets (optional)

For Stage 1 content quality, consider pre-chopping a public story corpus (e.g., TinyStories, link in §2.4) into an entity-tagged chunk library via an offline script, checked in as a small JSON pack — so scripted mode reads like a story, not lorem ipsum. Skip it if handwritten template chunks are good enough; your call.

---

## 6. Stages — expect to ping-pong, that's the intended workflow

**Stage 0 — Engine + harness.**
`pretext-tui` lib, test suite, and a demo binary: stream a markdown file into a viewport with live resize reflow and a toy expand/collapse animation.
*Exit:* tests green; visibly smooth, zero flicker at 200×50.

**Stage 1 — Find the fun (no LLM).**
Full game on ScriptedProvider, seeded. Headless `sim` mode for bots. Tune archetypes and knobs against §7 gates. Record a GIF (vhs/asciinema).
*Exit:* all §7 gates pass over 100 seeded rounds, and a ≤ 20-second GIF makes the core mechanic legible with no sound and no explanation.

**Stage 2 — Live LLM.**
LlmProvider + buffering + sanitation against a vllm-metal / OpenAI-compatible endpoint. Play full sessions.
*Working rule:* whenever live play surfaces something (latency hitch, weird tokens, pacing drift, un-fun pattern) — **reproduce it as a scripted Stage-1 case, fix it there, add a regression test, then return.** And vice versa: balance ideas born in Stage 1 get sanity-checked live. This back-and-forth is the loop, not a detour.

**Stage 3 — Polish & stretch (pick what excites you).**
CRT/theme skins · replays + daily seed · `ssh play.oom.example` public server (sshtron-style) · the flow-around-sprite showcase level · "hardware flex" mode (display rate = real tok/s) · score-screen Pareto table styled like the paper's Table 1.

---

## 7. Measuring Fun — LAW (you can't feel it; these are your senses)

Implement bot policies mirroring the paper's controls, running headless on seeds:

- `RecencyBot` — keeps only the newest chunks (paper's Recency-Only)
- `RandomKBot` — keeps a random k% (paper's Random-10%)
- `GreedyHeatBot` — acts on current heat only, no lookahead
- `ReactiveBot` — the **strongest member of the reactive family, not the weakest** (a gate certifies only against the adversary you actually field): hedges plausible chunks at summary tier as viewport budget allows, then expands exactly the telegraphed glyphs as fast as bandwidth allows (warm-hedging whack-a-mole). If a stronger reactive variant is ever found, *it* becomes the gate bot; `L_warm` pricing is the corrective knob.
- `OracleBot` — sees future waves (skill ceiling); also runnable under capped residency budgets for the §4.4 calibration sweeps

**Gates (hold across 100 seeded rounds at default difficulty before Stage 1 exits):**

1. **Skill gap:** Oracle ≫ GreedyHeat ≫ Recency ≈ Random. If RecencyBot reaches > 60% of Oracle's survival, your waves have a recency trap — redesign them (this is the exact failure the paper's baselines expose).
2. **Commitment check (the v1.1 gate):** ReactiveBot ≤ ~70% of Oracle's survival, and clearly below GreedyHeat. If ReactiveBot approaches Oracle, the commitment structure is broken — fix `L_cold` vs. telegraph length and `B` (§4.3) before tuning anything else.
3. **Decision density:** ~0.3–1.0 *meaningful* actions/sec mid-game (log per-beat optimal-action counts).
4. **Near-miss tension:** 20–40% of waves resolved in the final 25% of their telegraph window (with §4.3 latency, "resolved" means the transfer *lands* in that window).
5. **Death legibility:** ≥ 90% of losses attributable, in the logs, to a player-visible mistake within the prior ~10 seconds. No "what killed me?"
6. **Session shape:** median round 2–4 minutes.

These are proxies, not truth. Keep a `PLAYTEST.md`: your notes per tuning change, and a section where the human leaves impressions between your iterations — treat those notes as the highest-priority signal.

---

## 8. Fixed vs. Yours

**Fixed:** the five pillars (§3) · player-as-indexer concept · glyphs-not-prose legibility · stage gating on §7 · playable fully offline · paper + Pretext credited in README.

**Yours:** name · stack · exact keys/verbs · visual theme · wave math & scoring formula details · dataset use or not · animation easing · file layout · everything else not nailed down. Decide, note the decision in `ARCHITECTURE.md`, move on — don't wait on the human for anything in this list.

---

## 9. Repo Expectations

- `README.md` — pitch, the GIF up top, quickstart in ≤ 3 commands, LLM-mode docs (vllm-metal first, generic endpoint second), credits & links (paper, Pretext, this doc).
- CLI: `oom play [--preset inferno] [--seed N] [--llm]` and `oom sim --bot recency --rounds 100 --seed 42 --json`.
- `ARCHITECTURE.md` (brief, decisions + diagrams-in-ASCII welcome) · `PLAYTEST.md` (living log) · config file + env vars · CI running engine tests + headless bot gates.
- License: your call (default MIT).

Have fun with it — that's the whole point.
