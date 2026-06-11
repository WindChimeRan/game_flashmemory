# OOM

> A terminal arcade game where an LLM streams an endless story into a fixed
> viewport, and **you are the KV-cache eviction & prefetch policy**.
> Tetris, except the falling blocks are context, and the loss condition is OOM.

![gameplay](assets/play.gif)

You are the **Memory Indexer** for a language model that never stops talking.
Paragraphs stream in wearing **glyph badges** and **heat**. Every so often a
**query wave** lands, demanding glyphs: if the matching chunks are resident
and expanded, the story flows; if you evicted them, the narrator
*hallucinates* — the text visibly corrupts and your coherence drops. Run out
of viewport: **OOM, game over.**

The catch: fetching from cold is *slow* — slower than the telegraph that
warns you. **You cannot react your way out; you must predict.** Evict
ruthlessly, prefetch on faith, and keep residency low: the score is
`survival × recall × (1 − avg residency)` — the same Pareto the
serving-systems research it's based on optimizes.

## The game in 60 seconds

Every paragraph is about a **character** (its letter badge) and lives in
one of three states: **expanded** (full prose, costs lines), **summary**
(one dim line), or **chip** (a tile on the cold shelf, costs nothing).
`f` raises a chunk one state; `d` drops it one, instantly.

- The story streams in and takes space. When it no longer fits: **OOM,
  game over**. Evicting is your resting activity, not your emergency one.
- **Callbacks** land periodically, asking for characters by letter:
  expanded answers fully, summary partially, chip barely, absent = miss.
  Misses corrupt the text and drain coherence; empty coherence = game over.
- **Fetching is slow, forgetting is instant** — and a cold recall (~5.5s)
  takes *longer than the warning* (~3s). A chip announced in the INCOMING
  panel is a chip already lost.
- So play the **heat**: badges glow ~9 seconds before their moment. Glow
  with `●●●` pips = fetch now, on faith. One-pip glow = bait; that
  character is never coming. The telegraph is your receipt, not your alarm.
- Two transfer slots, no cancels, and the boss demands several characters
  *expanded* at once — start its queue the moment it's telegraphed.

Keys: `j/k` focus · letters jump to a character · `f` fetch · `d` evict ·
`p` pin · `space` pause · `q q` quit. Full manual with screen anatomy,
strategy, and the bot ladder: **[GUIDE.md](GUIDE.md)**.

## Quickstart

```bash
git clone <this-repo> && cd game_flashmemory
bun src/cli.ts play --preset chill     # first game (zero deps; needs bun + a 100×30 terminal)
```

`--preset chill|default|inferno` sets speed — difficulty is measured in
tokens per second. `--seed N` replays an identical round.

## Live-LLM mode (vllm-metal)

The story can be written live by a local model on Apple Silicon via
[vllm-metal](https://github.com/vllm-project/vllm-metal):

```bash
curl -fsSL https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh | bash
source ~/.venv-vllm-metal/bin/activate && vllm serve Qwen/Qwen3-0.6B --port 8000
bun src/cli.ts play --llm      # OOM_LLM_BASE_URL / OOM_LLM_MODEL to point elsewhere
```

Any OpenAI-compatible endpoint works (`OOM_LLM_BASE_URL`, `OOM_LLM_MODEL`,
`OOM_LLM_API_KEY`). The LLM is texture, never truth: a deterministic
director owns all game state, the model only writes the prose, and the game
falls back to the scripted narrator mid-chunk if generation ever stalls.
The install path above is verified end-to-end from a clean machine profile
(installer → dev wheel → server → completions).

Two full rounds, played by the built-in `par` bot (`--pilot par`, honestly
labeled on screen), story written live by Qwen3-0.6B — same seed, so the
*game* is identical and only the story's language changes:

**English** (`play --llm --pilot par --seed 7`):

![live LLM round, English](assets/play-llm-en.gif)

**Chinese** (`play --llm --llm-lang zh --pilot par --seed 7`) — the layout
engine wraps width-2 CJK mid-paragraph, and the cast gets Chinese names
(顾长风, 沈雁回, …). When the 0.6B model under-delivers on length, you'll
see brief English tails — that's the scripted safety net padding the chunk
mid-stream, by design:

![live LLM round, Chinese](assets/play-llm-zh.gif)

## The research it plays

The mechanics port **FlashMemory-DeepSeek-V4: Lightning Index Ultra-Long
Context via Lookahead Sparse Attention**
([arXiv:2606.09079](https://arxiv.org/abs/2606.09079)) — a Tencent AI Lab /
HKUST(GZ) / Tsinghua technical report on serving million-token contexts by
*predicting* which KV chunks the next τ=64 tokens need and fetching only
those from a CPU cold pool (13.5% average residency, +0.6% accuracy):

| paper | game |
|---|---|
| Memory Indexer, lookahead window | you |
| CPU cold pool / compressed tiers | chip rail / summary / expanded |
| τ-periodic batched fetches | transfer latency + bandwidth slots |
| Recency-Only & Random-10% baselines (collapse) | `RecencyBot` & `RandomKBot` (collapse on cue) |
| MRCR dense-memory breakdown (§3.3.2) | boss waves |
| context-independent queries (§3.3.1) | zen stretches |
| sigmoid false-positive leakage (§3.3.1) | distractor inflation |
| 2× length-generalization cliff (§3.3.3) | endless-mode heat rot |
| τ=64 & threshold 0.5 "remain untested" (§2.4) | the difficulty presets are that ablation |

The paper was suspended mid-flight when the project lead left Tencent — the
report literally documents "preliminary breakthroughs" with an email asking
for compute sponsorship. This game is a small playable monument to an
orphaned idea: the parts they published, you can now lose to.

**Fun is measured, not assumed**: bot players mirroring the paper's
baselines run headless behind quality gates (`bun scripts/gates.ts`) —
skill-gap, commitment (reaction must lose to prediction), decision density,
near-miss tension, death legibility, session shape.

```bash
bun src/cli.ts sim --bot oracle --rounds 100 --json   # headless bot runs
bun src/cli.ts demo                                    # layout-engine demo reel
```

## Under the hood

TypeScript on Bun, **zero runtime dependencies**, no TUI framework. Two
hand-rolled engines (see [ARCHITECTURE.md](ARCHITECTURE.md)):

- **`src/pretext`** — a terminal port of the
  [Pretext](https://github.com/chenglou/pretext) layout philosophy
  (chenglou): prepare/layout split, stable segment IDs, incremental
  re-layout, diffable positions → FLIP-tweened text reflow. The fold/unfold
  animation *is* the cache transfer.
- **`src/term`** — cell-grid diff renderer wrapped in DEC 2026 synchronized
  updates, SGR mouse, crash-safe terminal restore.

The deterministic sim (`src/sim`), bot roster (`src/bots`), and design history
([OOM_DESIGN.md](OOM_DESIGN.md), [PLAYTEST.md](PLAYTEST.md)) document the
rest, including every tuning decision and the gates that enforced them.

## Credits

- **FlashMemory-DeepSeek-V4** (Yan Wang et al., 2026) — the blueprint:
  https://arxiv.org/abs/2606.09079
- **Pretext** by [@chenglou](https://github.com/chenglou) — the layout
  architecture this game's engine is an homage to.
- Built with [Claude Code](https://claude.com/claude-code).

MIT — see [LICENSE](LICENSE).
