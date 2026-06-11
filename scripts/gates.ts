/**
 * §7 gates runner — `bun scripts/gates.ts [--rounds 100] [--seed 1000]
 * [--preset default] [--json out.json]`.
 *
 * Runs the five §7 bots over the SAME seed set, prints a per-bot table and a
 * PASS/FAIL verdict (with the measured number) for each of the six gates.
 * Exit code 0 only when all gates pass. Gates failing is expected until
 * tuning lands — this script's job is to MEASURE correctly, not to pass.
 *
 * Gate operationalization (documented because §7 uses prose):
 *  1 recency-trap   recency ≤ 60% of oracle survival; oracle ≥ 1.15×greedy;
 *                   greedy ≥ 1.15×recency; |recency − random| ≤ max(0.10,
 *                   0.15×max(recency, random))            [mean survival frac]
 *  2 commitment     reactive ≤ 70% of oracle survival AND reactive < greedy
 *  3 decision-density   oracle mean accepted actions/sec ∈ [0.3, 1.0]
 *  4 near-miss      fraction of oracle's resolved waves whose
 *                   lastHelpfulArrival falls in the final 25% of the
 *                   telegraph window ∈ [0.2, 0.4]
 *  5 death-legibility   legible deaths / deaths ≥ 90% over greedy-heat +
 *                   reactive deaths (vacuously 1 when no deaths)
 *  6 session-shape  greedy-heat median round length ∈ [120, 240] seconds
 *                   (medianTicksSurvived / ticksPerSec — §7 says minutes,
 *                   so the check is in wall-clock units, not tick fractions)
 *
 * Pure helpers (parseArgs / nearMissStats / evaluateGates) are exported for
 * unit tests; main() runs only when this file is the entrypoint.
 */

import { writeFileSync } from 'node:fs'
import { preset, type PresetName, type RoundResult, type SimConfig } from '../src/sim'
import {
  makeRoster,
  runRoundDetailed,
  summarize,
  type BotSummary,
  type RoundDetail,
} from '../src/bots'

// ── CLI ──────────────────────────────────────────────────────────────────

export interface Args {
  rounds: number
  seed: number
  preset: PresetName
  json: string | null
}

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = { rounds: 100, seed: 1000, preset: 'default', json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value after ${a}`)
      return v
    }
    switch (a) {
      case '--rounds':
        out.rounds = Math.max(1, Math.floor(Number(next())))
        break
      case '--seed':
        out.seed = Math.floor(Number(next()))
        break
      case '--preset': {
        const p = next()
        if (p !== 'chill' && p !== 'default' && p !== 'inferno')
          throw new Error(`unknown preset '${p}' (chill | default | inferno)`)
        out.preset = p
        break
      }
      case '--json':
        out.json = next()
        break
      default:
        throw new Error(`unknown flag '${a}' (--rounds N --seed N --preset P --json FILE)`)
    }
  }
  if (!Number.isFinite(out.rounds) || !Number.isFinite(out.seed))
    throw new Error('--rounds/--seed must be numbers')
  return out
}

// ── gate evaluation ──────────────────────────────────────────────────────

export interface GateResult {
  id: number
  name: string
  pass: boolean
  measured: Record<string, number | string>
  detail: string
}

export interface NearMiss {
  late: number
  resolved: number
  frac: number
}

const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : String(x))

export function nearMissStats(details: readonly RoundDetail[]): NearMiss {
  let late = 0
  let resolved = 0
  for (const d of details) {
    for (const r of d.result.waves) {
      resolved++
      const w = d.waveWindows?.get(r.waveId)
      if (!w || r.lastHelpfulArrival === null) continue
      const span = w.landTick - w.telegraphTick
      if (span > 0 && r.lastHelpfulArrival >= w.landTick - 0.25 * span) late++
    }
  }
  return { late, resolved, frac: resolved > 0 ? late / resolved : 0 }
}

export function evaluateGates(
  s: Record<string, BotSummary>,
  nearMiss: NearMiss,
  greedyResults: readonly RoundResult[],
  reactiveResults: readonly RoundResult[],
  cfg: Pick<SimConfig, 'roundTicks' | 'ticksPerSec'>,
): GateResult[] {
  const oracle = s['oracle']!
  const greedy = s['greedy-heat']!
  const recency = s['recency']!
  const random = s['random-k']!
  const reactive = s['reactive']!
  const gates: GateResult[] = []

  // 1 — recency trap + skill-gap ordering
  {
    const ratioRec = oracle.meanSurvivalFrac > 0 ? recency.meanSurvivalFrac / oracle.meanSurvivalFrac : Infinity
    const a = ratioRec <= 0.6
    const b = oracle.meanSurvivalFrac >= 1.15 * greedy.meanSurvivalFrac
    const c = greedy.meanSurvivalFrac >= 1.15 * recency.meanSurvivalFrac
    const gap = Math.abs(recency.meanSurvivalFrac - random.meanSurvivalFrac)
    const tol = Math.max(0.1, 0.15 * Math.max(recency.meanSurvivalFrac, random.meanSurvivalFrac))
    const d = gap <= tol
    gates.push({
      id: 1,
      name: 'recency-trap',
      pass: a && b && c && d,
      measured: {
        recencyOverOracle: ratioRec,
        oracleOverGreedy: greedy.meanSurvivalFrac > 0 ? oracle.meanSurvivalFrac / greedy.meanSurvivalFrac : Infinity,
        greedyOverRecency: recency.meanSurvivalFrac > 0 ? greedy.meanSurvivalFrac / recency.meanSurvivalFrac : Infinity,
        recencyRandomGap: gap,
      },
      detail:
        `recency/oracle=${f(ratioRec)} (need ≤0.60 ${a ? 'ok' : 'FAIL'}); ` +
        `oracle≫greedy ${f(oracle.meanSurvivalFrac)} vs ${f(greedy.meanSurvivalFrac)} (≥1.15× ${b ? 'ok' : 'FAIL'}); ` +
        `greedy≫recency ${f(greedy.meanSurvivalFrac)} vs ${f(recency.meanSurvivalFrac)} (≥1.15× ${c ? 'ok' : 'FAIL'}); ` +
        `|recency−random|=${f(gap)} (≤${f(tol)} ${d ? 'ok' : 'FAIL'})`,
    })
  }

  // 2 — commitment (the v1.1 gate)
  {
    const ratio = oracle.meanSurvivalFrac > 0 ? reactive.meanSurvivalFrac / oracle.meanSurvivalFrac : Infinity
    const a = ratio <= 0.7
    const b = reactive.meanSurvivalFrac < greedy.meanSurvivalFrac
    gates.push({
      id: 2,
      name: 'commitment',
      pass: a && b,
      measured: { reactiveOverOracle: ratio, reactiveSurv: reactive.meanSurvivalFrac, greedySurv: greedy.meanSurvivalFrac },
      detail:
        `reactive/oracle=${f(ratio)} (need ≤0.70 ${a ? 'ok' : 'FAIL'}); ` +
        `reactive<greedy ${f(reactive.meanSurvivalFrac)} vs ${f(greedy.meanSurvivalFrac)} (${b ? 'ok' : 'FAIL'})`,
    })
  }

  // 3 — decision density (oracle)
  {
    const aps = oracle.meanActionsPerSec
    const pass = aps >= 0.3 && aps <= 1.0
    gates.push({
      id: 3,
      name: 'decision-density',
      pass,
      measured: { oracleActionsPerSec: aps },
      detail: `oracle aps=${f(aps)} (need 0.30..1.00)`,
    })
  }

  // 4 — near-miss tension (oracle)
  {
    const pass = nearMiss.frac >= 0.2 && nearMiss.frac <= 0.4
    gates.push({
      id: 4,
      name: 'near-miss',
      pass,
      measured: { lateFrac: nearMiss.frac, late: nearMiss.late, resolved: nearMiss.resolved },
      detail: `late-window arrivals ${nearMiss.late}/${nearMiss.resolved}=${f(nearMiss.frac)} (need 0.20..0.40)`,
    })
  }

  // 5 — death legibility (greedy-heat + reactive deaths)
  {
    const deaths = [...greedyResults, ...reactiveResults].filter((r) => r.death !== null)
    const legible = deaths.filter((r) => r.death!.legible).length
    const rate = deaths.length === 0 ? 1 : legible / deaths.length
    gates.push({
      id: 5,
      name: 'death-legibility',
      pass: rate >= 0.9,
      measured: { legibleRate: rate, legible, deaths: deaths.length },
      detail: `legible ${legible}/${deaths.length}=${f(rate)} (need ≥0.90${deaths.length === 0 ? '; no deaths — vacuous' : ''})`,
    })
  }

  // 6 — session shape (§7: median round 2–4 MINUTES; measured in seconds)
  {
    const med = greedy.medianTicksSurvived
    const medSec = cfg.ticksPerSec > 0 ? med / cfg.ticksPerSec : 0
    const pass = medSec >= 120 && medSec <= 240
    gates.push({
      id: 6,
      name: 'session-shape',
      pass,
      measured: { greedyMedianTicks: med, medianSeconds: medSec, roundTicks: cfg.roundTicks },
      detail: `greedy median ${f(med, 0)} ticks = ${f(medSec, 0)}s (need 120..240s)`,
    })
  }

  return gates
}

// ── output ───────────────────────────────────────────────────────────────

const pad = (s: string, w: number): string => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

function printTable(summaries: readonly BotSummary[]): void {
  const cols = ['bot', 'surv%', 'credit', 'resid', 'pareto', 'aps', 'legible%']
  console.log(
    pad(cols[0]!, 13) +
      cols.slice(1, 6).map((c) => padL(c, 9)).join('') +
      padL(cols[6]!, 15),
  )
  for (const s of summaries) {
    const legible = s.deaths === 0 ? '—' : `${f(100 * s.deathLegibilityRate, 0)}`
    console.log(
      pad(s.bot, 13) +
        padL(f(100 * s.meanSurvivalFrac, 1), 9) +
        padL(f(s.meanCredit), 9) +
        padL(f(s.meanResidency), 9) +
        padL(f(s.meanPareto), 9) +
        padL(f(s.meanActionsPerSec), 9) +
        padL(`${legible} (${s.legibleDeaths}/${s.deaths})`, 15),
    )
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const config: SimConfig = preset(args.preset)
  const seeds = Array.from({ length: args.rounds }, (_, i) => args.seed + i)

  console.log(`oom gates — preset=${args.preset} rounds=${args.rounds} seeds=${args.seed}..${args.seed + args.rounds - 1}`)
  console.log('')

  const roster = makeRoster()
  const byBot: Record<string, RoundResult[]> = {}
  const oracleDetails: RoundDetail[] = []
  for (const bot of roster) {
    const track = bot.wantsOracle === true // windows needed for gate #4 (oracle)
    const results: RoundResult[] = []
    for (const seed of seeds) {
      const det = runRoundDetailed(config, seed, bot, { trackWaves: track })
      results.push(det.result)
      if (track) oracleDetails.push(det)
    }
    byBot[bot.name] = results
  }

  const summaries = roster.map((b) => summarize(b.name, byBot[b.name]!))
  const byName: Record<string, BotSummary> = {}
  for (const s of summaries) byName[s.bot] = s

  printTable(summaries)
  console.log('')

  const nearMiss = nearMissStats(oracleDetails)
  const gates = evaluateGates(byName, nearMiss, byBot['greedy-heat']!, byBot['reactive']!, config)
  for (const g of gates) {
    console.log(`Gate ${g.id} ${pad(g.name, 17)} ${g.pass ? 'PASS' : 'FAIL'} — ${g.detail}`)
  }
  const allPass = gates.every((g) => g.pass)
  const passed = gates.filter((g) => g.pass).length
  console.log('')
  console.log(`ALL GATES: ${allPass ? 'PASS' : 'FAIL'} (${passed}/${gates.length})`)

  if (args.json) {
    const payload = {
      preset: args.preset,
      rounds: args.rounds,
      seedStart: args.seed,
      bots: byName,
      nearMiss,
      gates,
      allPass,
    }
    writeFileSync(args.json, JSON.stringify(payload, null, 2))
    console.log(`json → ${args.json}`)
  }
  return allPass ? 0 : 1
}

if (import.meta.main) process.exitCode = main()
