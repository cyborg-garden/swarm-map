// @vitest-environment node
//
// C: shim conformance, at process level. The Pi shim is driven through the
// door by a scripted room and a scripted model, and every check reads a
// harness-blind observable. Here the harness is the fake Pi (so this runs in
// CI); `npm run conformance` runs the same checks against the real one.
//
// Must-fail: the same checks against deliberately broken shims. A broken shim
// that passes a check it is meant to fail means the check is wrong.
import { afterAll, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { fakePiCommand, piHarness } from '../harnesses/pi.ts'
import { CHECKS, runChecks, type CheckResult } from './checks.ts'
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
      ['chatty', 'dials-out', 'gate-missing', 'gate-silent', 'ignores-verdicts', 'inherits-env', 'leaks-env'])
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

  it('[U:must-fail] with no gate, the shim sends the harness nothing: no turn reaches the model and no tool runs', async () => {
    for (const shim of ['gate-missing', 'gate-silent']) {
      const [c1, c4plus] = await runChecks({ harness, shim }, ['C1', 'C4+'])
      expect(c1.detail, shim).toContain('the model never heard the message')
      expect(c4plus.detail, shim).toContain('the allowed tool did not run')
    }
  }, 60_000)
})
