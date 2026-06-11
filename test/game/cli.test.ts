import { describe, expect, test } from 'bun:test'
import { parseCli, usage } from '../../src/cli'

describe('parseCli', () => {
  test('help variants', () => {
    expect(parseCli([])).toEqual({ cmd: 'help' })
    expect(parseCli(['--help'])).toEqual({ cmd: 'help' })
    expect(parseCli(['-h'])).toEqual({ cmd: 'help' })
    expect(parseCli(['help'])).toEqual({ cmd: 'help' })
  })

  test('play defaults and flags', () => {
    expect(parseCli(['play'])).toEqual({ cmd: 'play', preset: 'default', seed: null })
    expect(parseCli(['play', '--seed', '7'])).toEqual({ cmd: 'play', preset: 'default', seed: 7 })
    expect(parseCli(['play', '--preset', 'inferno', '--seed', '42'])).toEqual({
      cmd: 'play',
      preset: 'inferno',
      seed: 42,
    })
    expect(() => parseCli(['play', '--preset', 'nightmare'])).toThrow(/unknown preset/)
    expect(() => parseCli(['play', '--seed', 'NaN'])).toThrow(/--seed needs a number/)
    expect(() => parseCli(['play', '--bogus'])).toThrow(/unknown flag/)
  })

  test('sim requires --bot; parses rounds/seed/preset/json', () => {
    expect(parseCli(['sim', '--bot', 'recency', '--rounds', '100', '--seed', '42', '--json'])).toEqual({
      cmd: 'sim',
      bot: 'recency',
      rounds: 100,
      seed: 42,
      preset: 'default',
      json: true,
    })
    expect(parseCli(['sim', '--bot', 'oracle'])).toEqual({
      cmd: 'sim',
      bot: 'oracle',
      rounds: 10,
      seed: 1,
      preset: 'default',
      json: false,
    })
    expect(() => parseCli(['sim', '--rounds', '5'])).toThrow(/requires --bot/)
    expect(() => parseCli(['sim', '--bot', 'oracle', '--preset', 'x'])).toThrow(/unknown preset/)
  })

  test('demo file defaulting', () => {
    expect(parseCli(['demo'])).toEqual({ cmd: 'demo', file: 'assets/demo.md' })
    expect(parseCli(['demo', 'README.md'])).toEqual({ cmd: 'demo', file: 'README.md' })
    expect(() => parseCli(['demo', 'a.md', 'b.md'])).toThrow(/at most one/)
  })

  test('gates passes everything through', () => {
    expect(parseCli(['gates'])).toEqual({ cmd: 'gates', rest: [] })
    expect(parseCli(['gates', '--rounds', '10', '--json', 'out.json'])).toEqual({
      cmd: 'gates',
      rest: ['--rounds', '10', '--json', 'out.json'],
    })
  })

  test('unknown command throws', () => {
    expect(() => parseCli(['fight'])).toThrow(/unknown command 'fight'/)
  })

  test('usage names every subcommand', () => {
    const u = usage()
    for (const cmd of ['play', 'sim', 'demo', 'gates']) expect(u).toContain(cmd)
  })
})

describe('cli subprocess smoke', () => {
  test('--help exits 0; unknown command exits 2; sim runs a round', async () => {
    const root = new URL('../../', import.meta.url).pathname
    const run = (args: string[]) =>
      Bun.spawnSync(['bun', 'src/cli.ts', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })

    const help = run(['--help'])
    expect(help.exitCode).toBe(0)
    expect(help.stdout.toString()).toContain('oom play')

    const bad = run(['fight'])
    expect(bad.exitCode).toBe(2)

    const sim = run(['sim', '--bot', 'recency', '--rounds', '2', '--seed', '5'])
    expect(sim.exitCode).toBe(0)
    expect(sim.stdout.toString()).toContain('bot=recency')
    expect(sim.stdout.toString()).toContain('pareto')

    const json = run(['sim', '--bot', 'oracle', '--rounds', '1', '--seed', '5', '--json'])
    expect(json.exitCode).toBe(0)
    const payload = JSON.parse(json.stdout.toString())
    expect(payload.summary.bot).toBe('oracle')
    expect(payload.results.length).toBe(1)

    const badBot = run(['sim', '--bot', 'wat', '--rounds', '1'])
    expect(badBot.exitCode).toBe(2)
  }, 30_000)
})
