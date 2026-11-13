// @vitest-environment node
//
// C: shim conformance, at process level. The Pi shim is driven through the
// door by a scripted room and a scripted model, and every check reads a
// harness-blind observable. Here the harness is the fake Pi (so this runs in
// CI); `npm run conformance` runs the same checks against the real one.
//
// Must-fail: the same checks against deliberately broken shims. A broken shim
// that passes a check it is meant to fail means the check is wrong.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { fakePiCommand, piHarness } from '../harnesses/pi.ts'
import { CHECKS, runChecks, type CheckResult } from './checks.ts'
import type { Matrix } from '../matrix.ts'
import { brokenVariants } from './harness.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const harness = piHarness(fakePiCommand(), 'fake')
const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]))

describe('Pi shim, against the fake Pi', () => {
  it.each(CHECKS.map((c) => [c.id, c.title] as const))('[U:pi-shim] %s %s', async (id) => {
    const [result] = await runChecks({ harness, shim: 'good' }, [id])
    expect(result.detail, result.detail).toBe('ok')
    expect(result.pass).toBe(true)
  }, 20_000)
})

describe('must-fail: broken shims turn their named checks red', () => {
  const variants = brokenVariants(harness)

  it('every way of breaking the shim is listed, and each names a check that exists', () => {
    expect(Object.keys(variants).sort()).toEqual(
      ['chatty', 'dials-out', 'gate-missing', 'gate-silent', 'ignores-verdicts', 'inherits-env', 'leaks-env', 'unwatched'])
    const ids = CHECKS.map((c) => c.id)
    for (const [name, v] of Object.entries(variants)) {
      expect(v.red.length, name).toBeGreaterThan(0)
      for (const id of [...v.red, ...v.green]) expect(ids, `${name} names ${id}`).toContain(id)
    }
  })

  it.each(Object.entries(variants))('[U:must-fail] %s', async (shim, { red, green }) => {
    const results = byId(await runChecks({ harness, shim }))
    for (const id of red) expect(results[id].pass, `${shim} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id].pass, `${shim} must still pass ${id}: ${results[id].detail}`).toBe(true)
  }, 120_000)

  it('[U:must-fail] a harness that ran with no tripwire inside it fails C9p for that reason, not for another', async () => {
    const [c9p] = await runChecks({ harness, shim: 'unwatched' }, ['C9p'])
    expect(c9p.pass).toBe(false)
    expect(c9p.detail).toBe('no tripwire was armed inside the harness process, so nothing was checked')
  }, 30_000)

  it('[U:must-fail] with no gate, the shim sends the harness nothing: no turn reaches the model and no tool runs', async () => {
    for (const shim of ['gate-missing', 'gate-silent']) {
      const [c1, c4plus] = await runChecks({ harness, shim }, ['C1', 'C4+'])
      expect(c1.detail, shim).toContain('the model never heard the message')
      expect(c4plus.detail, shim).toContain('the allowed tool did not run')
    }
  }, 60_000)
})

// The matrix file is evidence from a real-Pi run, and only `npm run conformance`
// may write it. CI cannot repeat that run, but it can tell when the file no
// longer matches the suite: a check or a broken shim added since means the
// evidence is out of date and the run has to be done again.
describe('the committed matrix for the pinned Pi', () => {
  const file = path.resolve(import.meta.dirname, '..', 'matrix', `pi-${PI_VERSION}.process.json`)
  const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix

  it('[U:matrix-fresh] is from a real Pi of the pinned version, run as a plain process', () => {
    expect(committed).toMatchObject({ harness: harness.caps.harness, version: PI_VERSION, harnessBuild: 'real', substrate: 'process' })
  })

  it('[U:matrix-fresh] has a result for every check the suite runs today, under today\'s title', () => {
    const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))
    for (const check of CHECKS) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
  })

  it('[U:matrix-fresh] names every broken shim the suite has today, with the checks each must fail today', () => {
    const today = Object.fromEntries(Object.entries(brokenVariants(harness)).map(([shim, v]) => [shim, v.red]))
    const then = Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))
    expect(then).toEqual(today)
    // And on that run, each one did turn its checks red.
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })
})
