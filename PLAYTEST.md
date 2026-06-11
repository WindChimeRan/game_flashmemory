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
