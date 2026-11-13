// @vitest-environment node
//
// The same checks as pi.fake.test.ts, against a real Pi install. Not part of
// the default test run (CI has no Pi). Run it with:
//
//   SWARMLAB_PI_BIN=/path/to/pi npm run conformance
//
// It refuses to run, rather than skip, when no Pi is given or the version is
// not the pinned one. It writes the matrix file from what it observed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { piEnv } from '../../lib/runtimes/pi/shim.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { buildMatrix, type MustFailInput } from '../matrix.ts'
import { CHECKS, runChecks, type CheckResult } from './checks.ts'

armTripwire()

const PI = process.env.SWARMLAB_PI_BIN
const MUST_FAIL: Record<string, string[]> = {
  'ignores-verdicts': ['C4', 'C5', 'C13'],
  'leaks-env': ['C8p'],
  'chatty': ['C1', 'C3'],
}

const results: CheckResult[] = []
const mustFail: Record<string, MustFailInput> = {}
let versionOk = false

afterAll(() => {
  expect(tripwireAttempts()).toEqual([])
  // Only a complete run against the pinned version may write the matrix.
  if (!versionOk || results.length !== CHECKS.length || Object.keys(mustFail).length !== Object.keys(MUST_FAIL).length) return
  const matrix = buildMatrix(
    { harness: 'pi', version: PI_VERSION, harnessBuild: 'real', substrate: 'process', date: new Date().toISOString().slice(0, 10) },
    results, mustFail,
  )
  const dir = path.resolve(import.meta.dirname, '..', 'matrix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `pi-${PI_VERSION}.process.json`), JSON.stringify(matrix, null, 2) + '\n')
})

describe(`real Pi ${PI_VERSION}`, () => {
  // Fails every test at once, instead of letting each one time out.
  beforeAll(() => {
    if (!PI) throw new Error('REFUSING TO RUN: set SWARMLAB_PI_BIN to a Pi binary. This suite never skips.')
  })

  it('is the pinned version', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-version-'))
    const version = execFileSync(PI!, ['--version'], { env: piEnv({ agentDir: scratch, homeDir: scratch }) as NodeJS.ProcessEnv }).toString().trim()
    expect(version).toBe(PI_VERSION)
    versionOk = true
  })

  it.each(CHECKS.map((c) => [c.id, c.title] as const))('%s %s', async (id) => {
    const [result] = await runChecks({ shim: 'pi', piCommand: [PI!] }, [id])
    results.push(result)
    expect(result.detail).toBe('ok')
  }, 30_000)

  it.each(Object.entries(MUST_FAIL))('must-fail: %s', async (shim, red) => {
    const got = await runChecks({ shim: shim as never, piCommand: [PI!] })
    const failed = got.filter((r) => !r.pass).map((r) => r.id)
    mustFail[shim] = { mustFail: red, failed }
    for (const id of red) expect(failed, `${shim} must fail ${id}`).toContain(id)
  }, 120_000)
})
