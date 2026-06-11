# OOM — Architecture Decisions

Decision log. Brief by design; rationale lives in OOM_DESIGN.md §10 and the
design-review transcript.

## D1. Stack

- **TypeScript on Bun** (1.3.x), Node ≥ 20 compatible. `bun test` for tests,
  `bunx tsc --noEmit` for typecheck, `bun build --compile` for single-file
  binaries later.
- **Zero runtime dependencies.** Only language/runtime builtins
  (`Intl.Segmenter` for graphemes). Dev deps: typescript, @types/node,
  bun-types. This is a hard rule — it keeps the npm package honest and
  avoids agent-parallel package.json conflicts.
- **No TUI framework.** The layout+render engine is the deliverable
  (`pretext-tui`); frameworks (ink/opentui/ratatui) own exactly that layer.
  Hand-rolled term layer instead (~600 lines, fully testable).

## D2. Module map & dependency law

```
src/shared/    pure utils owned by the integrator (width.ts) — read-only to agents
src/pretext/   layout engine: prepare/layout/positions (pure, no I/O)
src/term/      terminal: cell grid, diff renderer, ANSI, input, lifecycle
src/sim/       deterministic game core (pure logic, NO imports from term/pretext/game)
src/bots/      bot policies + headless runner + gates (imports sim only)
src/content/   ContentProvider: scripted (stage 1), llm (stage 2)
src/game/      composition root: screen, HUD, animations (imports everything)
src/cli.ts     oom play | oom sim | oom demo | oom gates
test/<module>/ mirrors src
scripts/       gates runner, tuning sweeps, vhs tapes
```

Allowed imports: `game → {sim, bots, pretext, term, content, shared}`;
`bots → sim`; `content → sim (types only)`; `pretext`, `term`, `sim` import
nothing outside themselves **except `src/shared/`** (shared is the width
authority — never duplicate its tables). Contracts in
`src/<mod>/types.ts` and everything in `src/shared/` are owned by the
integrator (do not edit in module work; work around locally + report).

## D3. Time model

1 tick = 1 displayed token. `display_tok_s` maps ticks to wall clock
(default 10/s). All sim durations (latencies, telegraphs, τ) are in ticks.
The render loop is decoupled: sim ticks at `display_tok_s`, renderer draws
at up to 30–60 fps, tweening between sim states.

## D4. Determinism

Seeded PRNG (mulberry32 streams per subsystem: director / heat / content).
No Date.now / Math.random anywhere in sim or content. Replay = seed +
action log. Property test: same seed + same actions ⇒ identical state hash
every tick.

## D5. Terminal protocol (reimplemented from public specs — xterm ctlseqs)

- Alt screen 1049; synchronized output DEC 2026 (BSU/ESU) wrapping every
  frame; double-buffered cell-grid diff → minimal ANSI writes; never
  reprint full screen except on resize/first frame.
- Input: raw mode; CSI/SS3 key parsing; SGR mouse (1006) with modes
  1000+1002 (click/drag) and 1004 (focus → auto-pause). Mode 1003 (hover)
  deferred. Wheel events surface as rebindable key events (wheel-as-keys).
- Kitty keyboard protocol: recorded as NOT needed (tap-based verbs).
- Crash-safe restore: cleanup (mouse off → show cursor → alt-screen exit)
  registered on exit/SIGINT/SIGTERM/uncaught — and idempotent.
- Backpressure: track stdout write completion; drop frames, never queue
  more than one frame deep.
- Colors: truecolor when COLORTERM says so, else 256-color quantization.
  Glyph badges are ASCII letters + color (redundant coding, colorblind-safe
  palette). No emoji anywhere in game UI.
- Min size check (100×30) with a friendly message.

## D6. Reference policy

`~/workspace/claude-code` = field guide only (mode tables, lifecycle
ordering, SGR parse shape, wheel-as-keys idea). No license file present ⇒
no code reuse. Everything reimplemented from public terminal specs.

## D7. Floating numbers

ALL gameplay numbers live in `src/sim/config.ts` (single source of truth,
presets chill/default/inferno) and are unfrozen until §7 gates pass over
100 seeded rounds. Tuning sweeps write results to PLAYTEST.md.
