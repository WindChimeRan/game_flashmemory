# PLAYTEST.md — living log

Highest-priority signal per OOM_DESIGN.md §7: human impressions recorded
between build iterations. Bots and gates are proxies; this file is truth.

## Human impressions

_(leave notes here — anything: feel, confusion, fun, frustration)_

## Build/tuning notes (agent)

- 2026-06-10: project start. Stage 0 scaffold; gates not yet runnable.
- 2026-06-10 eve: all four modules built + adversarially verified (364 tests).
  First gates smoke (10 seeds, defaults): **2/6 pass.**

  | bot | surv% | credit | resid | pareto | aps |
  |---|---|---|---|---|---|
  | recency | 57.8 | 0.15 | 0.28 | 0.06 | 0.24 |
  | random-k | 56.9 | 0.15 | 0.37 | 0.05 | 0.23 |
  | greedy-heat | 98.8 | 0.58 | 0.59 | 0.24 | 0.66 |
  | reactive | 100 | 0.89 | 0.47 | 0.48 | 0.81 |
  | oracle | 100 | 0.99 | 0.38 | 0.61 | 0.72 |

  Readings: (1) **Pareto separates the roster correctly** even where survival
  saturates — the skill axis exists; survival-ratio gate formulations break at
  the ceiling (gate 1 sub-condition mathematically unsatisfiable per verifier).
  (2) **Gate 2 fails hard**: blanket warm-hedging too cheap (L_warm 14 ≪
  telegraph 36, viewport fits ~all summaries). Candidate knobs: L_warm ↑,
  telegraph ↓, B ↓, viewport ↓, stdGlyphs ↑, wave cadence ↑. (3) Gate 4: oracle
  lands fetches ~12 ticks early (safety margin) vs 9-tick final-quartile window
  — measure tension on human-like bots instead, or tighten. (4) Gate 5:
  attribution checks viability from TELEGRAPH time; should check from
  heat-warning time (recency deaths are attributable — the heat channel warned
  for ≥ L_cold ticks). Tuning sweep workflow launched to resolve all four.

- 2026-06-10 night: tuning + gate-formulation pass applied (80-point sweep,
  4 knobs × telegraph × viewport; analyst report in workflow log). **5/6 at
  100 seeds.**

  **Config change (DEFAULTS):** `viewportLines 34→26`, `telegraphStd 36→28` —
  the minimal 2-knob diff from the sweep. Rationale: telegraphStd↓ is the
  clean anti-reactive lever (cuts telegraph-reaction credit, oracle flat);
  viewportLines↓ trims hedge capacity and drags recency under 0.6×oracle.
  Best commitment separation in the sweep (oracle/reactive ≈ 1.5 on pareto)
  with (b) recency-trap, (c) decision-density and (d) near-miss all in band
  simultaneously. L_warm stays 14: the sweep showed raising it is BACKWARDS
  (hurts greedy ~6× more than reactive — reactive hedges before the
  telegraph so L_warm barely prices it). waveGap is a non-lever; B 2→1 buys
  nothing at vp26. Presets rebalanced on the same axes: chill vp 30 / tg 34,
  inferno vp 24 / tg 24 (all pass validateConfig; §4.3 laws hold for
  tg ∈ {24, 28, 34} with L_warm 14, L_cold 54).

  **Gate formulation amendments — pending human review** (each marked
  'formulation fix, see PLAYTEST.md' in code):
  - Gates 1+2 (scripts/gates.ts): per pairwise comparison, when BOTH bots'
    mean survival ≥ 0.95 (saturation) the SAME §7 ratio thresholds apply to
    mean pareto instead of survival; below saturation the original survival
    ratios are untouched. Fixes the ceiling pathology flagged above —
    thresholds themselves unchanged.
  - Gate 4 (scripts/gates.ts): near-miss tension measured on reactive +
    greedy-heat resolved waves instead of oracle's (oracle's deliberate
    ~12-tick early-landing safety margin made it the wrong tension probe).
    Band [0.2, 0.4] unchanged.
  - Gate 5 (src/sim/attribution.ts + a 3-line additive hook in sim.ts step 5
    /death site): collapse legibility now has a second sufficient condition —
    judged from HEAT-WARNING time: if every demanded glyph not served
    expanded at landing showed heat ≥ 0.5 at least a full cold chain
    (L_c2s+1+L_warm = 55 ticks) before the wave landed (within heatHorizon),
    an attentive player could have started the cold chain in time ⇒ legible
    ('heat warned for N ticks'). Telegraph-time viability remains the other
    sufficient condition. Deterministic at heatNoise 0: horizon 90 warns
    ≥0.5 for exactly 50 ticks (< 55 ⇒ illegible for first-demand glyphs);
    in live play repeat demands + per-chunk noise push real warnings to
    58–72 ticks, which is what makes greedy/reactive deaths attributable.

  Full run `bun scripts/gates.ts --rounds 100 --seed 1000`:

  ```
  bot              surv%   credit    resid   pareto      aps       legible%
  recency           56.9     0.15     0.37     0.06     0.24    89 (89/100)
  random-k          58.3     0.16     0.46     0.05     0.27    92 (92/100)
  greedy-heat       95.6     0.55     0.60     0.21     0.68     98 (42/43)
  reactive          98.9     0.71     0.49     0.36     0.89      90 (9/10)
  oracle           100.0     1.00     0.45     0.55     0.61        — (0/0)

  Gate 1 recency-trap      PASS — recency/oracle=0.57 [surv] (need ≤0.60 ok); oracle≫greedy 0.55 vs 0.21 [pareto] (≥1.15× ok); greedy≫recency 0.96 vs 0.57 [surv] (≥1.15× ok); |recency−random|=0.01 [surv] (≤0.10 ok)
  Gate 2 commitment        FAIL — reactive/oracle=0.65 [pareto] (need ≤0.70 ok); reactive<greedy 0.36 vs 0.21 [pareto] (FAIL)
  Gate 3 decision-density  PASS — oracle aps=0.61 (need 0.30..1.00)
  Gate 4 near-miss         PASS — late-window arrivals (reactive+greedy) 693/2081=0.33 (need 0.20..0.40)
  Gate 5 death-legibility  PASS — legible 51/53=0.96 (need ≥0.90)
  Gate 6 session-shape     PASS — greedy median 1800 ticks = 180s (need 120..240s)

  ALL GATES: FAIL (5/6)
  ```

  Robustness probe (50 rounds, seed 2000): gates 3–6 replicate (aps 0.61,
  near-miss 0.32, legible 0.96, median 180 s) and gate 2(a) holds at 0.67 —
  but greedy's mean survival lands at 0.9497 there vs 0.9560 on the main
  block, straddling the 0.95 saturation trigger and flipping gate 1(b)
  between metrics (pareto → PASS at seed 1000, survival → FAIL at 2000).
  Note for the human review of the amendments: `oracle ≥ 1.15×greedy` on
  survival is already unsatisfiable whenever greedy > 1/1.15 ≈ 0.870 (oracle
  caps at 1.0), so [0.87, 0.95) is a dead band where neither formulation can
  pass; if the fallback is accepted, consider triggering it at the
  unsatisfiability bound rather than 0.95. Not changed unilaterally — the
  0.95 trigger is implemented as specified.

  **Remaining failure — gate 2(b) "reactive clearly below greedy", escalated
  as a MECHANIC issue, not a tuning one.** Sub-condition (a) now passes
  (reactive/oracle 0.65 ≤ 0.70 on the saturated-pareto fallback), but
  reactive ends ABOVE greedy on pareto (0.36 vs 0.21) at every one of the
  80 swept knob points (best gap −0.152; reactive survival never dips below
  0.98 in the region, so the survival letter is equally unreachable). No
  nearby knob fixes this: blanket warm-hedging needs a price the current
  rules don't charge — candidate mechanics for the next iteration: warm
  slots costing viewport/actions while parked, missCost on hedged-but-wrong
  glyphs, or hedge-decay. Knob iterations were deliberately NOT spent on
  this (analyst sweep shows the region is flat); the five passing gates are
  left undisturbed.

- 2026-06-10 late night: **summary-tier decay implemented** (the accepted
  design response to the gate-2(b) escalation above). **Mechanic addition
  pending human review — `summaryTTL=Infinity` restores frozen v1.1
  behavior exactly,** and that is the shipped default (rationale below).

  **Mechanic** (`SimConfig.summaryTTL`, sim tick step −1): a chunk sitting
  at SUMMARY tier unused for more than `summaryTTL` ticks drops back to
  chip at the START of a tick (before actions), emitting a
  `TickEvents.decayed` event; the live counter is exposed as
  `ChunkView.summaryAgeTicks` and is part of `stateHash` (determinism law).
  "Used" (counter resets): arrival at summary (transfer completion), the
  chunk's glyph demanded by a LANDING wave, or the chunk being the target
  of an accepted up/down. Decay ignores pin and mid-transfer chunks never
  decay (in-flight is committed, both directions). Paper-faithful: an
  unused prefetch does not persist past the next trigger window — parked
  compressed chunks the indexer never re-selects fall back to the cold
  pool. validateConfig: `summaryTTL > telegraphStd` (a reaction-hedge made
  at telegraph must survive to the landing) and `summaryTTL > L_warm + 2`;
  design intent is anti-blanket pressure from `summaryTTL < typical wave
  gap`, so a standing hedge wall costs recurring actions + bus time.
  Decay-awareness threaded through the frozen-structure consumers:
  director feasibility (`greedyClearable` models candidate decay/resets),
  telegraph viability (gate 5: a warm plan that would start after its
  summary's decay tick is modeled as a cold restart), OracleBot staging
  (deadline-aware JIT: releases a slack-rich warm leg before its summary
  decays UNLESS a post-decay cold restart still fits with margin — it was
  NOT decay-safe as previously assumed; mid-chain summaries could park past
  TTL under JIT), and ReactiveBot (decay-correct futility + seamless
  re-hedge: a replacement leg starts one L_c2s before a hedge dies).
  **Spec refinement, flagged for review:** the pin ACTION does not reset
  the counter (the spec's literal "any accepted player action" would let a
  1-action pin toggle refresh a summary for free every TTL ticks —
  re-enabling near-free blanket hedging, the exact loophole the spec's own
  "decay ignores pin" clause closes; same principle applied to both).
  23 new tests (decay timing edges, all reset conditions, pin/rejection
  non-resets, mid-transfer immunity both directions, demand-landing reset
  end-to-end, determinism + replay equality at finite TTL, finite≡Infinity
  control, hash counter coverage, validateConfig laws, bot decay probes).

  **Strongest-reactive escalation (affects how all gate-2 numbers read):**
  while A/B-ing wall-maintenance variants for the decay era, a strictly
  stronger member of the reactive family surfaced: `hedgeHeat 0.45`
  (old default 0.3). It hedges on the heat ramp ~56 ticks before a landing,
  so its chip→summary leg arrives just AFTER the telegraph and is expanded
  immediately — a JIT stager that parks summaries for ~1–2 ticks. Pareto
  0.45 vs 0.36 (both seed blocks, both metrics' tiebreaks; 0.45–0.48 is a
  plateau, 0.50 falls off the L_warm cliff). Per §7 ("the strongest member
  of the reactive family, not the weakest... if a stronger reactive variant
  is ever found, *it* becomes the gate bot") it is now the fielded default.
  Consequences: (1) gate 2(a)'s previous PASS (0.65) was an artifact of a
  sub-strongest bot — against the real adversary it reads 0.82 and FAILS;
  (2) because this bot parks ~nothing at summary, **summary-tier decay
  cannot price it at any legal TTL** (`summaryTTL > telegraphStd` is
  precisely the law that guarantees a use-immediately hedge survives).
  Decay does what it was designed to do — standing walls now churn and
  noise-hedges expire — but the strongest reactive play never built a
  standing wall in the first place; it rides the 90-tick heat horizon.
  §7's own designated corrective for a stronger reactive variant is
  `L_warm` pricing — left untouched here (outside the accepted design
  response; candidate for the next iteration alongside heat-horizon /
  heat-noise shaping, which bound how early a reactive player can time
  cold legs without future knowledge).

  **summaryTTL mini-sweep** (50 seeds @4000 ×5 bots, strongest reactive
  fielded, frozen gate formulations; gaps are reactive−greedy pareto):

  | TTL | greedy surv | greedy pareto | reactive pareto | 2(b) gap | gates |
  |---|---|---|---|---|---|
  | 40 | 0.966 | 0.217 | 0.438 | +0.221 | 5/6 (G5 margin 0.92) |
  | 55 | 0.957 | 0.208 | 0.438 | +0.230 | 5/6 |
  | 70 | 0.954 | 0.208 | 0.437 | +0.229 | 5/6 |
  | 90 | 0.959 | 0.206 | 0.438 | +0.232 | 5/6 |
  | ∞  | 0.965 | 0.204 | 0.441 | +0.237 | 5/6 |

  Confirmation at 100 rounds @1000 (the gate block): TTL 40 and 55 push
  greedy survival into gate 1's saturation dead band (0.939 / 0.945 < 0.95
  ⇒ G1+G2 flip to survival ratios ⇒ **4/6**); TTL 70/90 keep 5/6 and shave
  the 2(b) gap 0.242 → 0.234/0.230, but spend gate 5's margin (legible
  0.98 → 0.91; one more illegible greedy death fails it on another block)
  and sit on gate 4's 0.40 ceiling (0.396 vs 0.393). Decay helps GREEDY
  (garbage-collects its cooling summaries, reopens wave eligibility —
  credit 0.534→0.555, resid 0.606→0.594 at TTL 40) yet also feeds it more
  waves to miss, which is what desaturates its survival at low TTL.

  **Decision (protocol step 4): no finite value reaches 6/6; the best
  finite candidate (90) improves gate 2(b) by ~5% of the needed distance
  while regressing gate 5's measured margin and gate 1's saturation
  margin — `DEFAULTS.summaryTTL = Infinity` (mechanic dormant, fully
  implemented and tested; flip one knob to activate, 90 is the best
  finite candidate).**

  Full run `bun scripts/gates.ts --rounds 100 --seed 1000` (shipped
  defaults: summaryTTL ∞, reactive hedgeHeat 0.45):

  ```
  bot              surv%   credit    resid   pareto      aps       legible%
  recency           56.9     0.15     0.37     0.06     0.24    89 (89/100)
  random-k          58.3     0.16     0.46     0.05     0.27    92 (92/100)
  greedy-heat       95.6     0.55     0.60     0.21     0.68     98 (42/43)
  reactive         100.0     0.87     0.49     0.45     0.72        — (0/0)
  oracle           100.0     1.00     0.45     0.55     0.61        — (0/0)

  Gate 1 recency-trap      PASS — recency/oracle=0.57 [surv] (need ≤0.60 ok); oracle≫greedy 0.55 vs 0.21 [pareto] (≥1.15× ok); greedy≫recency 0.96 vs 0.57 [surv] (≥1.15× ok); |recency−random|=0.01 [surv] (≤0.10 ok)
  Gate 2 commitment        FAIL — reactive/oracle=0.82 [pareto] (need ≤0.70 FAIL); reactive<greedy 0.45 vs 0.21 [pareto] (FAIL)
  Gate 3 decision-density  PASS — oracle aps=0.61 (need 0.30..1.00)
  Gate 4 near-miss         PASS — late-window arrivals (reactive+greedy) 831/2114=0.39 (need 0.20..0.40)
  Gate 5 death-legibility  PASS — legible 42/43=0.98 (need ≥0.90)
  Gate 6 session-shape     PASS — greedy median 1800 ticks = 180s (need 120..240s)

  ALL GATES: FAIL (5/6)
  ```

  Robustness probe (50 rounds @2000, ∞ and 90 alike): G3–6 hold (near-miss
  0.396, legible 0.96, median 180 s); gate 1 sits in its known dead band
  there (greedy surv 0.948/0.943 < 0.95 — the pre-existing instability
  flagged in the previous entry, not a decay effect). Residual watch
  items: (1) gate 4 now reads 0.39–0.40 with the strongest reactive
  fielded (its JIT arrivals are mostly late-window — arguably the tension
  the gate wants, but one block from the ceiling); (2) gate 5 greedy
  legibility dips to ~0.91 whenever decay is active at TTL ≤ 90; (3)
  oracle decay-safety holds (credit 0.994 at TTL 55 vs 0.995 at ∞, 100
  rounds). Bot threshold retunes for greedy-heat were measured (evictAt /
  upHeat grids): every pareto-improving retune drops its survival below
  the 0.95 saturation bound and breaks gate 1 — kept at evictAt 0.7 /
  upHeat 0.55, documented here instead of changed.

- 2026-06-11: **reactive doctrine split — the gate-2 adversary is now
  HEAT-BLIND; the heat+telegraph hybrid is promoted to ParBot.**
  (Formulation amendment pending human review, same review track as the
  gate formulation fixes above.)

  **Doctrine + rationale.** Gate #2 exists to falsify "telegraphs alone
  suffice" (§4.3's whack-a-mole hole). The strongest reactive from the TTL
  experiment (hedgeHeat 0.45) timed cold legs off the heat ramp ~56 ticks
  before a landing — pre-telegraph. That is prediction, not reaction, and
  no parking price can touch it because it parks nothing. Two information
  channels (heat + telegraph) beating one (greedy's heat-only) is
  information theory, not a commitment-structure flaw — so that bot is not
  evidence about gate #2's question. Therefore: a reactive-family bot may
  read telegraphs and public non-predictive state (tiers, transfers,
  viewport pressure, bus, chunk ages, decay counters, rules constants via
  configure()) and NEVER chunk.heat / chunk.pips; blind hedging (summary
  walls built from no predictive signal) is allowed. Enforced mechanically,
  not by review: test/bots/heatblind.test.ts wraps every ChunkView in a
  Proxy that throws on heat/pips access and runs ReactiveBot full rounds
  against it (all wall policies + a finite-TTL round; proxied rounds are
  hash-identical to plain rounds; GreedyHeat/Par trip the probe on tick 1,
  so it is not vacuous). The hybrid lives on as **ParBot ('par')** — the
  mechanical par for human play (heat + telegraphs, no future knowledge),
  shown in the table between greedy-heat and oracle, and it replaces the
  old reactive in gate #4's near-miss measurement set (par + greedy = the
  human-like set). It is NOT a gate-2 adversary. Roster and gates table now
  field six bots; the port preserved its strength exactly (pareto 0.441 /
  0.447 on the 4000/2000 blocks vs 0.438–0.441 documented above).

  **A/B — blind-hedge variants, 50 seeds @4000 (replicated @2000, second
  number where it differs):**

  | variant | surv | credit | resid | pareto | waves/round | deaths |
  |---|---|---|---|---|---|---|
  | none (pure telegraph) | 0.58/0.56 | 0.16 | 0.37 | 0.060/0.056 | 6.1 | 50/50 collapse |
  | uniform wall (1 summary/glyph) | 1.00 | 0.73/0.80 | 0.63 | 0.270/0.298 | 1.9 | 0 |
  | recency wall K=6 | 0.77/0.78 | 0.23 | 0.52 | 0.087/0.086 | 6.5 | 50/50 collapse |
  | recency wall K=8 | 0.91/0.90 | 0.29 | 0.59 | 0.108/0.107 | 6.2 | 36/38 collapse |
  | **eligible wall (fielded)** | 1.00 | 0.77/0.78 | 0.60 | **0.308/0.317** | 2.0 | 0 |
  | eligible, lead 20 | 1.00 | 0.77/0.78 | 0.60 | 0.308/0.317 | 1.9 | 0 |
  | greedy-heat (ref) | 0.97/0.95 | 0.53/0.55 | 0.61 | 0.204/0.207 | 9.3 | 20/25 |
  | par (ref) | 1.00 | 0.86/0.87 | 0.49 | 0.441/0.447 | 11.5 | 0 |
  | oracle (ref) | 1.00 | 1.00 | 0.45 | 0.550 | 13.4 | 0 |

  'eligible' = keep one live summary per glyph unless the glyph already has
  a non-summary blocker (expanded / in-flight chunk) or its youngest chunk
  is < stdMinAge − 50 (ineligible by age anyway); maintained almost
  entirely by FREE tier-downs as chunks leave the protected strip, with
  cold up-legs only as repair. Fielded as the ReactiveBot default.

  **Finding 1 — the commitment structure did its job.** Pure-telegraph
  reaction (wall 'none') dies on every seed (pareto 0.06): reaction had to
  become prediction to compete. The old reactive's strength came entirely
  from the heat channel, i.e. from predicting — exactly what gate #2 was
  built to force. Partial walls (recency K) die too: coverage gaps leak
  waves that land on chips.

  **Finding 2 — the strongest blind reactive wins by WAVE SUPPRESSION, a
  real mechanic problem (gate 2(b) still fails; not massaged).** The
  full walls don't predict anything — they exploit two rules interacting:
  (a) standard-wave eligibility (director.tryStandard) requires EVERY chunk
  of a glyph to be chip-tier, idle, and aged ≥ stdMinAge, so one standing
  summary per glyph vetoes the entire std wave stream (the director defers
  forever: ~1.9 resolved waves/round vs greedy's 9.3 — what's left is the
  boss, which accepts any tier and is cleared reactively from the wall
  since L_warm 14 < telegraphBoss 120); and (b) meanCredit's denominator
  is RESOLVED waves only (sim.result), so suppressed waves vanish from the
  recall term instead of counting against it — survival saturates, credit
  reads 0.77–0.80 off ~2 waves, pareto 0.31–0.33 > greedy's 0.21. This is
  a different hole than the 2026-06-10 escalation (that was heat-timed
  JIT; this is game-denial). Candidate mechanics for the next iteration,
  deliberately NOT implemented here: make std eligibility non-vetoable by
  player tier state (e.g. age-only eligibility with the telegraph window
  extended when the glyph is warm), and/or charge scheduled-but-suppressed
  wave slots into the credit denominator so denying the game stops being
  free. §7's L_warm corrective does not touch it (the wall pays L_c2s once
  and L_warm only at telegraphs).

  Full run `bun scripts/gates.ts --rounds 100 --seed 1000` (shipped
  defaults; reactive = heat-blind eligible wall, par = promoted hybrid):

  ```
  bot              surv%   credit    resid   pareto      aps       legible%
  recency           56.9     0.15     0.37     0.06     0.24    89 (89/100)
  random-k          58.3     0.16     0.46     0.05     0.27    92 (92/100)
  greedy-heat       95.6     0.55     0.60     0.21     0.68     98 (42/43)
  reactive         100.0     0.82     0.59     0.33     0.30        — (0/0)
  par              100.0     0.87     0.49     0.45     0.72        — (0/0)
  oracle           100.0     1.00     0.45     0.55     0.61        — (0/0)

  Gate 1 recency-trap      PASS — recency/oracle=0.57 [surv] (need ≤0.60 ok); oracle≫greedy 0.55 vs 0.21 [pareto] (≥1.15× ok); greedy≫recency 0.96 vs 0.57 [surv] (≥1.15× ok); |recency−random|=0.01 [surv] (≤0.10 ok)
  Gate 2 commitment        FAIL — reactive/oracle=0.61 [pareto] (need ≤0.70 ok); reactive<greedy 0.33 vs 0.21 [pareto] (FAIL)
  Gate 3 decision-density  PASS — oracle aps=0.61 (need 0.30..1.00)
  Gate 4 near-miss         PASS — late-window arrivals (par+greedy) 831/2114=0.39 (need 0.20..0.40)
  Gate 5 death-legibility  PASS — legible 42/43=0.98 (need ≥0.90)
  Gate 6 session-shape     PASS — greedy median 1800 ticks = 180s (need 120..240s)

  ALL GATES: FAIL (5/6)
  ```

  Gate 2(a) now PASSES against the true blind adversary (0.61, and 0.58 on
  the probe block — the previous 0.82 read was the par-class hybrid, which
  was never the right bot for this gate). Gate 2(b) is the suppression
  finding above.

  Robustness probe (50 rounds @2000): 4/6 — gate 2(b) fails there on the
  mixed-saturation survival path (reactive 1.00 vs greedy 0.948), same
  conclusion; gate 1 sits in its known pre-existing dead band (greedy surv
  0.948 < 0.95, flagged 2026-06-10 — not a doctrine effect); gates 3–6
  hold (aps 0.61, near-miss 0.396 — still riding the 0.40 ceiling exactly
  as before since par's behavior ≡ the old reactive's, legible 0.96,
  median 180 s). Residual watch items: (1) gate 5's death pool is now
  greedy-only (the blind reactive is deathless) — if a future blind
  variant dies, note that heat-warning attribution judges a heat-blind
  player against a channel the doctrine says reactive bots don't read;
  worth a look in the same human review. (2) gate 4's measurement set
  change (par for old-reactive) is numerically a no-op by construction,
  but the set is now doctrine-defined rather than incidental.
