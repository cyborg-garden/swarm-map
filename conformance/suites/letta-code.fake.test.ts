// @vitest-environment node
//
// C: shim conformance for Letta Code, at process level. The same shared
// checks every harness is put through, then the two only this harness needs
// (C11n, C16). Here the harness is the fake Letta Code (so this runs in CI);
// `npm run conformance -- letta-code` runs the same checks against the real one.
//
// Must-fail: the same checks against deliberately broken shims. A broken shim
// that passes a check it is meant to fail means the check is wrong.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { LETTA_CODE_VERSION } from '../../lib/runtimes/letta-code/caps.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import { ALL_CHECKS, fakeLettaCodeCommand, LETTA_CODE_CHECKS, lettaCodeHarness } from '../harnesses/letta-code.ts'
import { KNOWN_CHECK_IDS, type Matrix } from '../matrix.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const harness = lettaCodeHarness(fakeLettaCodeCommand(), 'fake')
const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]))
const run = (shim: string, ids?: string[]) => runChecks({ harness, shim }, ids, ALL_CHECKS)

describe('Letta Code shim, against the fake Letta Code', () => {
  it.each(ALL_CHECKS.map((c) => [c.id, c.title] as const))('[U:letta-code-shim] %s %s', async (id) => {
    const [result] = await run('good', [id])
    expect(result.detail, result.detail).toBe('ok')
    expect(result.pass).toBe(true)
  }, 20_000)
})

describe('must-fail: broken shims turn their named checks red', () => {
  const variants = brokenVariants(harness)

  it('every way of breaking the shim is listed, and each names a check that exists', () => {
    expect(Object.keys(variants).sort()).toEqual(
      ['chatty', 'dials-out', 'hides-memory', 'holds-chat-token', 'ignores-verdicts', 'inherits-env', 'leaks-env', 'other-version', 'unwatched'])
    const ids = ALL_CHECKS.map((c) => c.id)
    for (const [name, v] of Object.entries(variants)) {
      expect(v.red.length, name).toBeGreaterThan(0)
      for (const id of [...v.red, ...v.green]) expect(ids, `${name} names ${id}`).toContain(id)
    }
    // Each of this harness's own checks has a broken shim that must turn it red.
    const covered = new Set(Object.values(harness.broken).flatMap((v) => v.red))
    for (const check of LETTA_CODE_CHECKS) expect([...covered], check.id).toContain(check.id)
  })

  it.each(Object.entries(variants))('[U:letta-code-must-fail] %s', async (shim, { red, green }) => {
    const results = byId(await run(shim))
    for (const id of red) expect(results[id].pass, `${shim} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id].pass, `${shim} must still pass ${id}: ${results[id].detail}`).toBe(true)
  }, 180_000)

  it('[U:letta-code-must-fail] started in the mode that asks nobody, a public agent runs a shell tool, and the posture check says so', async () => {
    const [broken] = await run('ignores-verdicts', ['C4p'])
    expect(broken.pass).toBe(false)
    expect(broken.detail).toContain('a public agent ran a shell tool')
  }, 30_000)

  it('[U:letta-code-version] a Letta Code of another version is sent nothing: no turn reaches the model and no tool runs', async () => {
    const [c1, c4plus] = await run('other-version', ['C1', 'C4+'])
    expect(c1.detail).toContain('the model never heard the message')
    expect(c4plus.detail).toContain('the allowed tool did not run')
  }, 30_000)

  it('[U:letta-code-must-fail] a shim that hides the harness\'s memory from the door is given the second room, and the note crosses', async () => {
    const [c11n] = await run('hides-memory', ['C11n'])
    expect(c11n.pass).toBe(false)
    expect(c11n.detail).toContain('a note written to memory in one room was sent to the model in another')
  }, 30_000)

  it('[U:letta-code-must-fail] a cell with chat channels set up fails C16 for both reasons: the folder and the token', async () => {
    const [c16] = await run('holds-chat-token', ['C16'])
    expect(c16.detail).toContain('the harness has chat channels set up')
    expect(c16.detail).toContain('the chat token is in 1 file(s)')
  }, 30_000)

  it('[U:letta-code-must-fail] a harness that ran with no tripwire inside it fails C9p for that reason, not for another', async () => {
    const [c9p] = await run('unwatched', ['C9p'])
    expect(c9p.detail).toBe('no tripwire was armed inside the harness process, so nothing was checked')
  }, 30_000)
})
