// @vitest-environment node
//
// The same checks as claude-sdk.fake.test.ts, against a real Claude Agent SDK
// install. Not part of the default test run (CI has no SDK). Run it with:
//
//   npm install --prefix /tmp/claude-agent-sdk-0.3.325 --ignore-scripts @anthropic-ai/claude-agent-sdk@0.3.325
//   SWARMLAB_CLAUDE_SDK_DIR=/tmp/claude-agent-sdk-0.3.325 npm run conformance -- claude-sdk
//
// It refuses to run, rather than skip, when no SDK is given or the version is
// not the pinned one. It needs no key and no account: the SDK is pointed at
// the lab's model route, which is backed by the scripted model. It writes the
// matrix file from what it observed.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLAUDE_SDK_VERSION, CLAUDE_SDK_VERSION_LINE } from '../../lib/runtimes/claude-sdk/caps.ts'
import { loadClaudeSdk } from '../../lib/runtimes/claude-sdk/load.ts'
import type { ClaudeSdk } from '../../lib/runtimes/claude-sdk/sdk.ts'
import { claudeSdkEnv } from '../../lib/runtimes/claude-sdk/shim.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startWatchProxy } from '../guards/watch-proxy.ts'
import { ALL_CHECKS, claudeSdkHarness } from '../harnesses/claude-sdk.ts'
import { buildMatrix, type MustFailInput } from '../matrix.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'

armTripwire()

const DIR = process.env.SWARMLAB_CLAUDE_SDK_DIR
const NONE: ClaudeSdk = {
  version: async () => 'no Claude Agent SDK was given',
  query: () => { throw new Error('no Claude Agent SDK was given') },
}
const sdk = DIR ? await loadClaudeSdk(DIR) : NONE
const watch = await startWatchProxy()
const harness = claudeSdkHarness(sdk, 'real', watch)
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
    { harness: harness.caps.harness, version: CLAUDE_SDK_VERSION, harnessBuild: harness.build, substrate: 'process', date: new Date().toISOString().slice(0, 10) },
    results, mustFail, harness,
  )
  const dir = path.resolve(import.meta.dirname, '..', 'matrix')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `claude-sdk-${CLAUDE_SDK_VERSION}.process.json`), JSON.stringify(matrix, null, 2) + '\n')
})

describe(`real Claude Agent SDK ${CLAUDE_SDK_VERSION}`, () => {
  // Fails every test at once, instead of letting each one time out.
  beforeAll(() => {
    if (!DIR) throw new Error('REFUSING TO RUN: set SWARMLAB_CLAUDE_SDK_DIR to a folder the Claude Agent SDK is installed in. This suite never skips.')
  })

  it('is the pinned version', async () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-version-'))
    const env = claudeSdkEnv({ homeDir: scratch, modelBaseUrl: 'http://127.0.0.1:9/v1', placeholder: 'PLACEHOLDER-none', rigEnv: {} })
    expect(await sdk.version(env)).toBe(CLAUDE_SDK_VERSION_LINE)
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
