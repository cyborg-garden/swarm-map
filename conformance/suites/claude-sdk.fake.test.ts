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

// The matrix file is evidence from a real SDK run, and only `npm run
// conformance -- claude-sdk` may write it. CI cannot repeat that run, but it
// can tell when the file no longer matches the suite: a check or a broken
// shim added since means the evidence is out of date and the run has to be
// done again.
describe('the committed matrix for the pinned Claude Agent SDK', () => {
  const file = path.resolve(import.meta.dirname, '..', 'matrix', `claude-sdk-${CLAUDE_SDK_VERSION}.process.json`)
  const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
  const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

  it('[U:claude-sdk-matrix] is from a real SDK of the pinned version, run as a plain process', () => {
    expect(committed).toMatchObject({ harness: 'claude-sdk', version: CLAUDE_SDK_VERSION, harnessBuild: 'real', substrate: 'process' })
  })

  it('[U:claude-sdk-matrix] has a result for every check the suite runs today, under today\'s title', () => {
    // Every check anyone knows of has a row, run or not, plus this harness's own, and there is no row for one nobody knows.
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...CLAUDE_SDK_CHECKS.map((c) => c.id)])].sort())
    for (const check of ALL_CHECKS) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance -- claude-sdk`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
  })

  it('[U:claude-sdk-matrix] names every broken shim the suite has today, with the checks each must fail today', () => {
    const today = Object.fromEntries(Object.entries(brokenVariants(harness)).map(([shim, v]) => [shim, v.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })

  it('[U:claude-sdk-matrix] says what it does not show: how its traffic was watched, no wall at process level, and no chat of its own to switch off', () => {
    // The watcher on this harness is a proxy it is told to use, and the file says so in so many words.
    expect(committed.caveats.join(' ')).toContain('watched by a proxy it is told to use, not from inside its process')
    expect(rows.C7).toMatchObject({ status: 'not-run' })
    expect(rows.C11).toMatchObject({ status: 'not-run' })
    expect(rows.C16).toMatchObject({ status: 'n/a' })
    for (const id of ['S1', 'C8', 'C9', 'C10']) expect(rows[id], id).toMatchObject({ status: 'not-run' })
    const rule = Object.fromEntries(committed.rules.map((r) => [r.rule, r.status]))
    // Neither wall of the model route, nor the posture rule, is claimed without a sealed cell.
    for (const id of ['budget.cap', 'keys.model-route', 'tools.posture']) expect(rule[id], id).toBe('not-run')
  })
})
