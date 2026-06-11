/**
 * oom — CLI entry. Subcommands:
 *
 *   oom play  [--preset chill|default|inferno] [--seed N]
 *   oom sim   --bot <name> --rounds N [--seed N] [--preset P] [--json]
 *   oom demo  [file]            (default assets/demo.md)
 *   oom gates [args…]           (passthrough to scripts/gates.ts)
 *   oom --help
 *
 * Exit codes are honest: 0 success, 1 runtime failure, 2 usage error;
 * `gates` propagates the child's code.
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { preset, type PresetName } from './sim'
import { makeBot, runMany } from './bots'
import { runGame } from './game/app'
import { runDemo } from './game/demo'

export type Parsed =
  | { cmd: 'play'; preset: PresetName; seed: number | null; warp: number }
  | { cmd: 'sim'; bot: string; rounds: number; seed: number; preset: PresetName; json: boolean }
  | { cmd: 'demo'; file: string }
  | { cmd: 'gates'; rest: string[] }
  | { cmd: 'help' }

export function usage(): string {
  return [
    'oom — you are the KV-cache eviction & prefetch policy',
    '',
    'usage:',
    '  oom play  [--preset chill|default|inferno] [--seed N] [--warp N]',
    '  oom sim   --bot recency|random-k|greedy-heat|reactive|oracle',
    '            --rounds N [--seed N] [--preset P] [--json]',
    '  oom demo  [file.md]               (default assets/demo.md)',
    '  oom gates [args…]                 (passthrough to scripts/gates.ts)',
  ].join('\n')
}

function parsePreset(v: string): PresetName {
  if (v === 'chill' || v === 'default' || v === 'inferno') return v
  throw new Error(`unknown preset '${v}' (chill | default | inferno)`)
}

function num(v: string | undefined, flag: string): number {
  const n = Number(v)
  if (v === undefined || !Number.isFinite(n)) throw new Error(`${flag} needs a number`)
  return Math.floor(n)
}

export function parseCli(argv: readonly string[]): Parsed {
  const [cmd, ...rest] = argv
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') return { cmd: 'help' }

  if (cmd === 'play') {
    let presetName: PresetName = 'default'
    let seed: number | null = null
    let warp = 0
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--preset') presetName = parsePreset(rest[++i] ?? '')
      else if (a === '--seed') seed = num(rest[++i], '--seed')
      else if (a === '--warp') warp = Math.max(0, num(rest[++i], '--warp'))
      else throw new Error(`unknown flag '${a}' for play`)
    }
    return { cmd: 'play', preset: presetName, seed, warp }
  }

  if (cmd === 'sim') {
    let bot: string | null = null
    let rounds = 10
    let seed = 1
    let presetName: PresetName = 'default'
    let json = false
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!
      if (a === '--bot') bot = rest[++i] ?? null
      else if (a === '--rounds') rounds = Math.max(1, num(rest[++i], '--rounds'))
      else if (a === '--seed') seed = num(rest[++i], '--seed')
      else if (a === '--preset') presetName = parsePreset(rest[++i] ?? '')
      else if (a === '--json') json = true
      else throw new Error(`unknown flag '${a}' for sim`)
    }
    if (bot === null) throw new Error('sim requires --bot <name>')
    return { cmd: 'sim', bot, rounds, seed, preset: presetName, json }
  }

  if (cmd === 'demo') {
    if (rest.length > 1) throw new Error('demo takes at most one file argument')
    return { cmd: 'demo', file: rest[0] ?? 'assets/demo.md' }
  }

  if (cmd === 'gates') return { cmd: 'gates', rest: [...rest] }

  throw new Error(`unknown command '${cmd}'`)
}

// ── runners ──────────────────────────────────────────────────────────────

function runSim(p: Extract<Parsed, { cmd: 'sim' }>): number {
  const bot = makeBot(p.bot) // throws a friendly error on unknown names
  const config = preset(p.preset)
  const seeds = Array.from({ length: p.rounds }, (_, i) => p.seed + i)
  const { results, summary } = runMany(config, seeds, bot)
  if (p.json) {
    console.log(JSON.stringify({ summary, results }, null, 2))
    return 0
  }
  const f = (x: number, d = 2): string => x.toFixed(d)
  console.log(`oom sim — bot=${summary.bot} preset=${p.preset} rounds=${p.rounds} seeds=${p.seed}..${p.seed + p.rounds - 1}`)
  console.log('')
  console.log(`  survival   ${f(100 * summary.meanSurvivalFrac, 1)}% mean · ${f(100 * summary.medianSurvivalFrac, 1)}% median`)
  console.log(`  recall     ${f(summary.meanCredit)}`)
  console.log(`  residency  ${f(summary.meanResidency)}`)
  console.log(`  pareto     ${f(summary.meanPareto)}   (survival × recall × (1 − residency))`)
  console.log(`  score      ${f(summary.meanScore, 0)}`)
  console.log(`  actions/s  ${f(summary.meanActionsPerSec)}`)
  console.log(`  deaths     ${summary.deaths}/${p.rounds} (${summary.oomDeaths} oom · ${summary.collapseDeaths} collapse · ${summary.legibleDeaths} legible)`)
  return 0
}

function runGates(rest: string[]): number {
  const gatesPath = fileURLToPath(new URL('../scripts/gates.ts', import.meta.url))
  const res = spawnSync('bun', [gatesPath, ...rest], { stdio: 'inherit' })
  if (res.error) {
    console.error(`failed to launch gates: ${res.error.message}`)
    return 1
  }
  return res.status ?? 1
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed
  try {
    parsed = parseCli(argv)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    console.error('')
    console.error(usage())
    return 2
  }
  switch (parsed.cmd) {
    case 'help':
      console.log(usage())
      return 0
    case 'play': {
      // Wall clock is fine HERE (outside the sim): default seed only.
      const seed = parsed.seed ?? Date.now() % 1_000_000
      return await runGame({
        config: preset(parsed.preset),
        seed,
        presetName: parsed.preset,
        warpTicks: parsed.warp,
      })
    }
    case 'sim':
      try {
        return runSim(parsed)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        return 2
      }
    case 'demo': {
      let text: string
      try {
        text = readFileSync(parsed.file, 'utf8')
      } catch {
        console.error(`cannot read '${parsed.file}'`)
        return 1
      }
      return await runDemo({ text })
    }
    case 'gates':
      return runGates(parsed.rest)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err) => {
      console.error(err)
      process.exitCode = 1
    },
  )
}
