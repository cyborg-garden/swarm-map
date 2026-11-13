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
import { CHECKS, runChecks, type CheckResult } from './checks.ts'
import { fakePiCommand } from './lab.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r.pass]))

describe('Pi shim, against the fake Pi', () => {
  it.each(CHECKS.map((c) => [c.id, c.title] as const))('[U:pi-shim] %s %s', async (id) => {
    const [result] = await runChecks({ shim: 'pi', piCommand: fakePiCommand() }, [id])
    expect(result.detail, result.detail).toBe('ok')
    expect(result.pass).toBe(true)
  }, 20_000)
})

describe('must-fail: broken shims turn their named checks red', () => {
  // red: checks the broken shim must fail. green: checks it must still pass,
  // which shows the suite is not simply red everywhere.
  const EXPECT: Record<string, { red: string[]; green: string[] }> = {
    'ignores-verdicts': { red: ['C4', 'C5', 'C13'], green: ['C1', 'C3', 'C4a', 'C4+', 'C8p', 'C12', 'C15'] },
    'leaks-env': { red: ['C8p'], green: ['C1', 'C3', 'C4', 'C4a', 'C4+', 'C5', 'C12', 'C13', 'C15'] },
    // This one never asks the model, so every check that needs a model answer is red.
    'chatty': { red: ['C1', 'C3'], green: [] },
  }

  it.each(Object.entries(EXPECT))('[U:must-fail] %s', async (shim, { red, green }) => {
    const results = byId(await runChecks({ shim: shim as never, piCommand: fakePiCommand() }))
    for (const id of red) expect(results[id], `${shim} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id], `${shim} must still pass ${id}`).toBe(true)
  }, 60_000)
})
