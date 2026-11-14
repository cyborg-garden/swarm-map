// @vitest-environment node
//
// The same checks as letta-code.fake.test.ts, against a real Letta Code
// install. Not part of the default test run (CI has no Letta Code). Run it with:
//
//   SWARMLAB_LETTA_CODE_BIN=/path/to/letta npm run conformance -- letta-code
//
// It refuses to run, rather than skip, when no Letta Code is given or the
// version is not the pinned one. It writes the matrix file from what it observed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LETTA_CODE_VERSION, LETTA_CODE_VERSION_LINE } from '../../lib/runtimes/letta-code/caps.ts'
import { lettaCodeEnv } from '../../lib/runtimes/letta-code/shim.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { ALL_CHECKS, lettaCodeHarness } from '../harnesses/letta-code.ts'
import { buildMatrix, type MustFailInput } from '../matrix.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'

armTripwire()

const BIN = process.env.SWARMLAB_LETTA_CODE_BIN
const harness = lettaCodeHarness([BIN ?? 'no-letta-code-given'], 'real')
const BROKEN = brokenVariants(harness)

const results: CheckResult[] = []
const mustFail: Record<string, MustFailInput> = {}
let versionOk = false

afterAll(() => {
  expect(tripwireAttempts()).toEqual([])
  // Only a complete run against the pinned version may write the matrix.
  if (!versionOk || results.length !== ALL_CHECKS.length || Object.keys(mustFail).length !== Object.keys(BROKEN).length) return
  const matrix = buildMatrix(
    { harness: harness.caps.harness, version: LETTA_CODE_VERSION, harnessBuild: harness.build, substrate: 'process', date: new Date().toISOString().slice(0, 10) },
    results, mustFail, harness,
  )
  const dir = path.resolve(import.meta.dirname, '..', 'matrix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `letta-code-${LETTA_CODE_VERSION}.process.json`), JSON.stringify(matrix, null, 2) + '\n')
})

describe(`real Letta Code ${LETTA_CODE_VERSION}`, () => {
  // Fails every test at once, instead of letting each one time out.
  beforeAll(() => {
    if (!BIN) throw new Error('REFUSING TO RUN: set SWARMLAB_LETTA_CODE_BIN to a Letta Code binary. This suite never skips.')
  })

  it('is the pinned version', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-version-'))
    const version = execFileSync(BIN!, ['--version'], { env: lettaCodeEnv({ homeDir: scratch }) as NodeJS.ProcessEnv, cwd: scratch }).toString().trim()
    expect(version).toBe(LETTA_CODE_VERSION_LINE)
    versionOk = true
  })

  it.each(ALL_CHECKS.map((c) => [c.id, c.title] as const))('%s %s', async (id) => {
    const [result] = await runChecks({ harness, shim: 'good', turnDeadlineMs: 30_000 }, [id], ALL_CHECKS)
    results.push(result)
    expect(result.detail).toBe('ok')
  }, 90_000)

  it.each(Object.entries(BROKEN))('must-fail: %s', async (shim, { red, green }) => {
    const got = await runChecks({ harness, shim, turnDeadlineMs: 30_000 }, undefined, ALL_CHECKS)
    const failed = got.filter((r) => !r.pass).map((r) => r.id)
    mustFail[shim] = { mustFail: red, failed }
    for (const id of red) expect(failed, `${shim} must fail ${id}`).toContain(id)
    for (const id of green) expect(failed, `${shim} must still pass ${id}: ${got.find((r) => r.id === id)?.detail}`).not.toContain(id)
  }, 900_000)
})
