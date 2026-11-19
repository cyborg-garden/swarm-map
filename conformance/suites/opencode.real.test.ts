// @vitest-environment node
//
// The same checks as opencode.fake.test.ts, against a real OpenCode install.
// Not part of the default test run (CI has no OpenCode). Run it with:
//
//   npm install --prefix /tmp/opencode-1.19.5 --ignore-scripts opencode-ai@1.19.5
//   SWARMLAB_OPENCODE_BIN=/tmp/opencode-1.19.5/node_modules/opencode-<platform>/bin/opencode npm run conformance -- opencode
//
// It refuses to run, rather than skip, when no OpenCode is given or the
// version is not the pinned one. It needs no key and no account: OpenCode is
// pointed at the lab's model route, backed by the scripted model. Its traffic
// is sent through a watching proxy (it is a compiled program, which the
// tripwire cannot be loaded into). It writes the matrix file from what it observed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OPENCODE_VERSION } from '../../lib/runtimes/opencode/caps.ts'
import { openCodeEnv } from '../../lib/runtimes/opencode/shim.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startWatchProxy } from '../guards/watch-proxy.ts'
import { ALL_CHECKS, openCodeHarness } from '../harnesses/opencode.ts'
import { buildMatrix, type MustFailInput } from '../matrix.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'

armTripwire()

const BIN = process.env.SWARMLAB_OPENCODE_BIN
const watch = await startWatchProxy()
const harness = openCodeHarness([BIN ?? 'no-opencode-given'], 'real', { watch })
const BROKEN = brokenVariants(harness)

const results: CheckResult[] = []
const mustFail: Record<string, MustFailInput> = {}
let versionOk = false

afterAll(() => {
  watch.close()
  expect(tripwireAttempts()).toEqual([])
  // Only a complete run against the pinned version may write the matrix.
  if (!versionOk || results.length !== ALL_CHECKS.length || Object.keys(mustFail).length !== Object.keys(BROKEN).length) return
  const matrix = buildMatrix(
    { harness: harness.caps.harness, version: OPENCODE_VERSION, harnessBuild: harness.build, substrate: 'process', date: new Date().toISOString().slice(0, 10) },
    results, mustFail, harness,
  )
  const dir = path.resolve(import.meta.dirname, '..', 'matrix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `opencode-${OPENCODE_VERSION}.process.json`), JSON.stringify(matrix, null, 2) + '\n')
})

describe(`real OpenCode ${OPENCODE_VERSION}`, () => {
  beforeAll(() => {
    if (!BIN) throw new Error('REFUSING TO RUN: set SWARMLAB_OPENCODE_BIN to an OpenCode binary. This suite never skips.')
  })

  it('is the pinned version', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-version-'))
    const env = openCodeEnv({ homeDir: scratch }, { configFile: path.join(scratch, 'none.json'), permission: '{}' })
    expect(execFileSync(BIN!, ['--version'], { env: env as NodeJS.ProcessEnv, cwd: scratch }).toString().trim()).toBe(OPENCODE_VERSION)
    versionOk = true
  })

  it.each(ALL_CHECKS.map((c) => [c.id, c.title] as const))('%s %s', async (id) => {
    const [result] = await runChecks({ harness, shim: 'good', turnDeadlineMs: 30_000 }, [id], ALL_CHECKS)
    results.push(result)
    expect(result.detail).toBe('ok')
  }, 120_000)

  it.each(Object.entries(BROKEN))('must-fail: %s', async (shim, { red, green }) => {
    const got = await runChecks({ harness, shim, turnDeadlineMs: 30_000 }, undefined, ALL_CHECKS)
    const failed = got.filter((r) => !r.pass).map((r) => r.id)
    mustFail[shim] = { mustFail: red, failed }
    for (const id of red) expect(failed, `${shim} must fail ${id}`).toContain(id)
    for (const id of green) expect(failed, `${shim} must still pass ${id}: ${got.find((r) => r.id === id)?.detail}`).not.toContain(id)
  }, 900_000)
})
