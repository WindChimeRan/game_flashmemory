# OOM — Player's Guide

*You are the memory of a storyteller who never stops talking.*

No background reading required. This guide teaches the game on its own
terms; if you're curious what research it secretly is, that's at
[the very end](#for-the-curious-the-research-behind-it).

---

## What is this game?

A storyteller narrates an endless tale into a window that can only hold so
many lines. New paragraphs keep arriving. Old paragraphs take up space.
Your job is to decide **what the story keeps in mind** — which memories
stay vivid, which get compressed to a one-line note, and which get filed
away as a single cold tile on a shelf.

The storyteller constantly *calls back* to earlier characters. When a
callback arrives and the memory it needs is vivid, the story flows. When
it needs a memory you filed away — the narrator stumbles, the text
visibly **corrupts and glitches**, and the story's sanity drains.

Two ways to die:

- **OOM (out of memory)** — the incoming story no longer fits in the
  window. Immediate game over.
- **Coherence collapse** — too many failed callbacks. The story falls
  apart.

One way to win: survive the round while missing nothing and *holding as
little as possible*. Minimalism is scored, not just survival.

## Getting started

```bash
git clone <this-repo> && cd game_flashmemory
bun src/cli.ts play --preset chill        # recommended first game
```

- Requires [bun](https://bun.sh) and a terminal of at least **100×30**
  (the game checks and tells you). True-color terminals look best;
  256-color works automatically.
- `--seed N` replays the exact same round — practice a seed, or race a
  friend on one.
- `--preset chill | default | inferno` sets the speed. Difficulty is
  measured in **tokens per second** — how fast the story streams in.
  Chill is the same game with roomier timing everywhere.

## Reading the screen

```
┌─ story ────────────────────────────────┬─ sidebar ──────────┐
│ G ●●● Grist Halloway ▓▓░ 5L            │ OOM default·seed 7 │
│ Rumor moved through the static choir   │ COH ▓▓▓▓▓▓░░  81   │
│ like the hush before the sirens. …     │ PTS 1520  STRK ×3  │
│                                        │ BUS [⇡S 57%] [ ]   │
│ F ·   Fenwick Roe   (one dim line)     │ INCOMING           │
│                                        │  Q R ▓▓░░  2s      │
│▎K ●●  Kestrel Vane  +18/47             │  BOSS in 9s ▓▓▓▓▓  │
│▎the newest paragraph is still being    │ MEM ▓▓▓▓▓░░░  46%  │
│▎written, word by word…                 │ COLD  Q X M T      │
├────────────────────────────────────────┴────────────────────┤
│ j/k·nav  a–z·jump  f·fetch  d·evict  p·pin  ␣·pause  q·quit │
└──────────────────────────────────────────────────────────────┘
```

**A paragraph ("chunk") exists in one of three states:**

| state | looks like | costs | callback value |
|---|---|---|---|
| **expanded** | full prose + header | 4–7 lines | full credit |
| **summary** | one dim header line | 1 line | partial credit |
| **chip** | a letter tile on the COLD shelf | 0 lines | scraps |

**The header of every chunk tells you four things:**

- **The letter badge** (`G`, `F`, `K`…) — which *character* this paragraph
  is about. Callbacks ask for characters by letter. Same letter = same
  character, and any one good chunk of that letter can answer for them.
- **Brightness (heat)** — how strongly the game predicts this character is
  needed *soon*. Badges glow hotter as their moment approaches.
- **Pips `· •• ●●●`** — how *trustworthy* that glow is. Three pips: real.
  One pip: probably bait (see [Distractors](#distractors-and-other-traps)).
- **`▎` left border** — the newest paragraphs, still being written. They
  are protected: you can't touch them until the narrator moves on.

**The sidebar:**

- **MEM** — the memory gauge. This is the OOM death meter. Red zone ≥ 90%.
- **COH** — coherence, your health bar. Failed callbacks drain it; clean
  ones slowly restore it.
- **PTS / STRK** — score and streak multiplier (clean callbacks chain).
- **BUS** — your two transfer slots. Recalling a memory occupies a slot
  until it lands. Both busy = no new fetches.
- **INCOMING** — the telegraph: upcoming callbacks, which letters they
  need, and a shrinking countdown bar. Bosses are marked in red.
- **COLD** — the shelf of filed-away chips, oldest to newest.

## The five rules

1. **The story keeps coming and it takes space.** If the next line doesn't
   fit, you OOM. Making space is your default activity, not an emergency.
2. **Callbacks check your filing.** When an INCOMING wave lands, each
   letter it asks for is graded by the best chunk you hold of that letter:
   expanded = full, summary = partial, chip = scraps, nothing = miss.
3. **Recalling is slow; forgetting is instant.** Evicting (`d`) happens
   immediately. Fetching (`f`) is a *transfer that takes seconds* — and
   the deep recall takes **longer than the warning you get**.
4. **Two transfers at a time, no take-backs.** The bus has two slots, and
   a transfer in flight can't be cancelled or evicted. A wasted fetch
   costs the slot *and* the time.
5. **The score loves minimalists.** Final score multiplies survival ×
   callback quality × *how little memory you used*. Hoarding everything
   expanded is a slow way to lose.

## The golden rule (read this twice)

At default speed:

- A callback warns you **~3 seconds** before it lands.
- A **warm** chunk (summary → expanded) takes **~1.5 seconds**. Fits.
- A **cold** chip (chip → summary → expanded, two fetches back to back)
  takes **~5.5 seconds**. *Does not fit.*

**If INCOMING announces a letter that's still a chip, that callback is
already lost.** The warning is not an alarm — it's a confirmation of
homework you either did or didn't do.

Your real alarm is **heat**: badges start glowing about **9 seconds**
before their moment — exactly enough time for the full cold recall. So the
loop of skilled play is:

> Glow (with pips) → fetch *now*, on faith → telegraph confirms →
> finish the warm step → collect → evict it all again.

React to the glow. Confirm with the telegraph. Never the other way around.

## Controls, and when to use each

| key | what | when |
|---|---|---|
| `j` / `k` (or arrows) | move focus between chunks | choosing eviction victims |
| `a`–`z` | jump focus to that character's chunks | the targeting verb — "INCOMING needs Q" → press `q` |
| `f` | fetch: raise one tier (starts a transfer) | on a trustworthy glow (early!), or to warm-finish a summary when the telegraph confirms |
| `d` | evict: drop one tier (instant) | constantly; whenever MEM climbs and a chunk is cold, dim, and pip-less |
| `p` | pin: protect from your own `d` | after staging chunks for a boss, so a panic evict-spree can't undo it |
| `space` | pause | breathe, read the board — also releases the mouse so you can select/copy the prose |
| `q q` | quit (press twice) | rage |
| mouse | click = focus, wheel = move focus | optional; the keyboard is the skill path |

If a key flashes a message on the bottom bar (`bus full`, `committed`,
`protected`), the game rejected the action and told you why.

## A round, beat by beat

A round is about three minutes and has a rhythm:

**Calm stretches.** Nothing in INCOMING. Evict. Get lean. File finished
paragraphs down to summaries, summaries down to chips. Watch the glow.

**A glow blooms.** Some chip's badge on the COLD shelf brightens with
``●●●``. Press its letter, press `f` (cold leg starts, ~4s), and when it
arrives at summary, `f` again (~1.5s). You've resurrected a memory before
anyone asked for it. That feeling is the game.

**The telegraph confirms.** INCOMING shows the letter you already staged.
Smile. Collect full credit when it lands. Your streak multiplier grows.

**ZEN.** Sometimes the sidebar shows a zen marker: a stretch where *nothing
will be asked*. Strip your memory to the bone — the game pays a running
bonus for every moment you spend lean. Trust it. Evict everything.

**The BOSS.** Marked red, and telegraphed generously early (~12 seconds)
because it needs *several* letters served **expanded** at once — partial
credit won't cut it until you cross most of its demand. Do the math that
the bus forces: three cold recalls through two slots is 8–11 seconds. The
moment the boss appears, start your fetch queue, `p`-pin each staged chunk,
and purge them all after it lands. The boss punishes exactly the lean
style the rest of the game teaches — that swing is intentional.

**A miss.** The incoming text corrupts into glitch-characters for a few
seconds and COH lurches down. The death screen will tell you what you
missed and when you could have acted — the game promises your deaths are
your fault, legibly.

## Distractors and other traps

- **Hot but fake.** Some chunks run hot — and are never, ever asked for.
  The tell: **one pip**. Real demand is corroborated (`●●●`); bait isn't.
  Second tell: their letters never show up in INCOMING, round after round.
  The longer the round runs, the more of these accumulate — late-game
  discipline is ignoring ever-more noise.
- **Hoarding.** "I'll just keep everyone expanded" dies twice: first the
  MEM gauge, then the residency term of your score.
- **Bus gambling.** Two speculative fetches right before a boss means zero
  slots when you need them, and transfers can't be cancelled.
- **Trusting the warning.** One more time: a chip announced in INCOMING is
  a chip lost. Heat is the alarm. The telegraph is the receipt.

Reading the prose is never required — every decision can be made from
badges, glow, pips, and meters. But between waves, the story itself drops
hints about who returns. Players who read get an edge. (The text that
corrupts when you miss? That's the narrator *hallucinating* the memory you
threw away.)

## Your score

In-round, points come from callbacks (× streak) and zen leanness bonuses.
The end screen shows the real verdict, three numbers multiplied:

```
survival  ×  recall  ×  (1 − memory used)
```

…followed by a comparison table. The **FM-DS-V4** row is the research
system this game is based on — it held **13.5%** of memory with
near-perfect recall; consider that the developer's high score. The
**Recency-Only** and **Random-10%** rows are the two naive strategies
("keep only the newest" / "keep a random tenth") — they collapse, and you
can watch them do it yourself:

```bash
bun src/cli.ts sim --bot recency --rounds 20 --seed 42
```

The full bot roster, weakest to strongest: `recency` (the goldfish),
`random-k` (the coin-flipper), `reactive` (pure reflexes — only believes
warnings; note how that caps out), `greedy-heat` (follows the glow but
never plans), `par` (glow + warnings, a solid human), `oracle` (sees the
future; the ceiling). The game's difficulty was tuned until this ladder
held — `bun scripts/gates.ts` re-checks it anytime.

## Live-LLM mode (optional)

The story can be written live by a local language model instead of the
built-in scripted narrator:

```bash
source ~/.venv-vllm-metal/bin/activate && vllm serve Qwen/Qwen3-0.6B --port 8000
bun src/cli.ts play --llm
```

Any OpenAI-compatible server works (`OOM_LLM_BASE_URL`, `OOM_LLM_MODEL`,
`OOM_LLM_API_KEY`). Only the *words* change — the schedule of chunks and
callbacks is decided by the same deterministic director, so seeds stay
fair and the game never waits on the model: if generation stalls, the
scripted narrator takes over mid-sentence and hands back when the model
recovers.

## For the curious: the research behind it

Serving a large language model with a very long context means keeping a
huge "past" loaded in scarce, expensive GPU memory — even though at any
given moment, almost none of it is needed. A 2026 research system called
**FlashMemory** attacked this by training a small *predictor* that watches
the model think and fetches, just in time, only the handful of past
fragments the next few moments will actually need — everything else waits
in cheap, slow storage. It held memory use to 13.5% with *better* accuracy
than keeping everything.

In this game you are that predictor. The three tiers are its storage
hierarchy, the slow fetch is its real transfer latency, the glow is its
prediction signal, the one-pip bait is its measured false-positive
problem, and the boss is the benchmark that genuinely broke it. The paper
([arXiv:2606.09079](https://arxiv.org/abs/2606.09079)) was suspended
mid-flight when its lead left the company; the README's mapping table
shows how each of its findings became a mechanic. This game is the
orphaned idea, kept playable.
