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

The catch (§4.3 of the design): fetching from cold is *slow* — slower than
the telegraph that warns you. **You cannot react your way out; you must
predict.** Evict ruthlessly, prefetch on faith, and keep residency low: the
score is `survival × recall × (1 − avg residency)` — the same Pareto the
serving-systems research it's based on optimizes.

## Quickstart

```bash
git clone <this-repo> && cd game_flashmemory
bun src/cli.ts play            # arcade mode, scripted story (zero deps)
```

`bun src/cli.ts play --preset chill|default|inferno --seed N` · pause with
`space` · `j/k` focus · `f` prefetch · `d` evict · `p` pin · letters jump to
glyphs. Difficulty is measured in tokens per second.

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
