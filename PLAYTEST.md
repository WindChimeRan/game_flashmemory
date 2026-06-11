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
