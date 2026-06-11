/**
 * Smoke: the gates CLI runs end-to-end on 10 rounds, prints the table and
 * all six gate verdicts, writes valid JSON, and its exit code matches the
 * allPass verdict. (Gates themselves are ALLOWED to fail — tuning comes
 * later; this asserts the measurement machinery, not the outcome.)
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '../..')

describe('scripts/gates.ts end-to-end', () => {
  test('10 rounds: table + 6 verdicts + valid JSON + exit code semantics', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oom-gates-'))
    const jsonPath = join(dir, 'out.json')
    try {
      const proc = Bun.spawnSync({
        cmd: ['bun', 'scripts/gates.ts', '--rounds', '10', '--seed', '4000', '--json', jsonPath],
        cwd: REPO,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = proc.stdout.toString()
      const err = proc.stderr.toString()

      // Ran to completion (0 = all gates pass, 1 = some fail; anything else = crash).
      expect([0, 1]).toContain(proc.exitCode)
      expect(err).toBe('')

      // Table + verdicts present.
      for (const bot of ['recency', 'random-k', 'greedy-heat', 'reactive', 'oracle']) {
        expect(out).toContain(bot)
      }
      for (let g = 1; g <= 6; g++) expect(out).toContain(`Gate ${g} `)
      expect(out).toMatch(/ALL GATES: (PASS|FAIL) \(\d\/6\)/)

      // JSON payload shape.
      const payload = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
        preset: string
        rounds: number
        seedStart: number
        bots: Record<string, { rounds: number; meanSurvivalFrac: number }>
        nearMiss: { late: number; resolved: number; frac: number }
        gates: { id: number; name: string; pass: boolean; detail: string }[]
        allPass: boolean
      }
      expect(payload.preset).toBe('default')
      expect(payload.rounds).toBe(10)
      expect(payload.seedStart).toBe(4000)
      expect(Object.keys(payload.bots).sort()).toEqual(
        ['greedy-heat', 'oracle', 'random-k', 'reactive', 'recency'].sort(),
      )
      for (const b of Object.values(payload.bots)) {
        expect(b.rounds).toBe(10)
        expect(b.meanSurvivalFrac).toBeGreaterThanOrEqual(0)
        expect(b.meanSurvivalFrac).toBeLessThanOrEqual(1)
      }
      expect(payload.gates.length).toBe(6)
      expect(payload.gates.map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6])
      for (const g of payload.gates) expect(typeof g.pass).toBe('boolean')
      expect(typeof payload.allPass).toBe('boolean')
      expect(payload.allPass).toBe(payload.gates.every((g) => g.pass))
      expect(proc.exitCode).toBe(payload.allPass ? 0 : 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120000)

  test('bad flag exits non-zero with an error', () => {
    const proc = Bun.spawnSync({
      cmd: ['bun', 'scripts/gates.ts', '--bogus'],
      cwd: REPO,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(proc.exitCode).not.toBe(0)
  })
})
