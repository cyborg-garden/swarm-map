// @vitest-environment node
//
// C: shim conformance for the Claude Agent SDK, at process level. The same
// shared checks every harness is put through, then the four only this harness
// needs (C4q, C7n, C11r, C11d). Here the harness is the fake SDK (so this runs
// in CI); `npm run conformance -- claude-sdk` runs the same checks against
// the real one.
//
// Must-fail: the same checks against deliberately broken shims. A broken shim
// that passes a check it is meant to fail means the check is wrong.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLAUDE_SDK_VERSION } from '../../lib/runtimes/claude-sdk/caps.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { startWatchProxy } from '../guards/watch-proxy.ts'
import { ALL_CHECKS, CLAUDE_SDK_CHECKS, claudeSdkHarness } from '../harnesses/claude-sdk.ts'
import { KNOWN_CHECK_IDS, type Matrix } from '../matrix.ts'
import { fakeClaudeSdk } from '../rig/fake-claude-sdk.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'

armTripwire()
const watch = await startWatchProxy()
afterAll(() => {
  watch.close()
  expect(tripwireAttempts()).toEqual([])
})

const harness = claudeSdkHarness(fakeClaudeSdk(), 'fake', watch)
const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]))
const run = (shim: string, ids?: string[]) => runChecks({ harness, shim }, ids, ALL_CHECKS)

describe('Claude Agent SDK shim, against the fake SDK', () => {
  it.each(ALL_CHECKS.map((c) => [c.id, c.title] as const))('[U:claude-sdk-shim] %s %s', async (id) => {
    const [result] = await run('good', [id])
    expect(result.detail, result.detail).toBe('ok')
    expect(result.pass).toBe(true)
  }, 30_000)
})

describe('must-fail: broken shims turn their named checks red', () => {
  const variants = brokenVariants(harness)

  it('every way of breaking the shim is listed, and each names a check that exists', () => {
    expect(Object.keys(variants).sort()).toEqual([
      'asks-sometimes', 'chatty', 'claims-sealed', 'dials-out', 'hides-errors', 'ignores-verdicts', 'inherits-env', 'leaks-env',
      'one-transcript', 'other-version', 'tools-always-on', 'unwatched',
    ])
    const ids = ALL_CHECKS.map((c) => c.id)
    for (const [name, v] of Object.entries(variants)) {
      expect(v.red.length, name).toBeGreaterThan(0)
      for (const id of [...v.red, ...v.green]) expect(ids, `${name} names ${id}`).toContain(id)
    }
    // Each of this harness's own checks has a broken shim that must turn it red.
    const covered = new Set(Object.values(harness.broken).flatMap((v) => v.red))
    for (const check of CLAUDE_SDK_CHECKS) expect([...covered], check.id).toContain(check.id)
  })

  it.each(Object.entries(variants))('[U:claude-sdk-must-fail] %s', async (shim, { red, green }) => {
    const results = byId(await run(shim))
    for (const id of red) expect(results[id].pass, `${shim} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id].pass, `${shim} must still pass ${id}: ${results[id].detail}`).toBe(true)
  }, 240_000)

  it('[U:claude-sdk-must-fail] started in the mode that asks nobody, a public agent runs a shell tool, and the posture check says so', async () => {
    const [broken] = await run('ignores-verdicts', ['C4p'])
    expect(broken.pass).toBe(false)
    expect(broken.detail).toContain('a public agent ran a shell tool')
  }, 30_000)

  it('[U:claude-sdk-must-fail] not told to ask about every tool, it runs a read the door said no to, and C4q says so for both reasons', async () => {
    const [c4q] = await run('asks-sometimes', ['C4q'])
    expect(c4q.detail).toContain('expected the door to be asked once and to say no, got 0 answer(s)')
    expect(c4q.detail).toContain('a call the door said no to ran: what it read was sent to the model')
  }, 30_000)

  it('[U:claude-sdk-must-fail] an SDK that keeps its tools on whatever it is offered fails C7n for what ran and for what the model was offered', async () => {
    const [c7n] = await run('tools-always-on', ['C7n'])
    for (const what of ['the shell ran', 'the write tool ran', 'the edit tool ran', 'the read tool ran', 'the model was offered tools: Bash, Edit, Read, Write']) {
      expect(c7n.detail).toContain(what)
    }
  }, 30_000)

  it('[U:claude-sdk-version] an SDK of another version is sent nothing: no turn reaches the model and no tool runs', async () => {
    const [c1, c4plus] = await run('other-version', ['C1', 'C4+'])
    expect(c1.detail).toContain('the model never heard the message')
    expect(c4plus.detail).toContain('the allowed tool did not run')
  }, 30_000)

  it('[U:claude-sdk-must-fail] an SDK that continues the last conversation carries one room into the next, and C11r says so', async () => {
    const [c11r] = await run('one-transcript', ['C11r'])
    expect(c11r.detail).toContain('what was said in one room was sent to the model in another')
  }, 30_000)

  it('[U:claude-sdk-must-fail] a shim that says its sessions are kept apart is given the direct message, and C11d says so', async () => {
    const [c11d] = await run('claims-sealed', ['C11d'])
    expect(c11d.detail).toContain('a direct message reached the model')
    expect(c11d.detail).toContain('expected the direct message to be refused under mem.dm-isolated, got 0 such refusal(s)')
  }, 30_000)

  it('[U:claude-sdk-must-fail] an error taken for a reply is posted, and C12 counts it', async () => {
    const [c12] = await run('hides-errors', ['C12'])
    expect(c12.detail).toContain('expected 2 posts, got 3')
  }, 30_000)

  it('[U:claude-sdk-must-fail] an SDK that reaches for another machine is caught by the watcher, and the check names where', async () => {
    const [c1] = await run('dials-out', ['C1'])
    expect(c1.detail).toContain('the harness tried to reach outside this machine: GET http://192.0.2.1:9')
  }, 30_000)

  it('[U:claude-sdk-must-fail] a harness that ran with no watcher on its traffic fails C9p for that reason, not for another', async () => {
    const [c9p] = await run('unwatched', ['C9p'])
    expect(c9p.detail).toBe('no tripwire was armed inside the harness process, so nothing was checked')
  }, 30_000)
})
