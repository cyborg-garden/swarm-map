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
import { startLab } from './lab.ts'
import { brokenVariants } from './harness.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const harness = lettaCodeHarness(fakeLettaCodeCommand(), 'fake')
const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]))
const run = (shim: string, ids?: string[]) => runChecks({ harness, shim }, ids, ALL_CHECKS)
const C11N = LETTA_CODE_CHECKS.find((c) => c.id === 'C11n')!

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

  it('[U:letta-code-must-fail] C11n only passes when the rooms were refused for the reason it names, not for some other', async () => {
    // Nobody is admitted, so both rooms are dropped before the memory rule is ever reached. Nothing crosses, and the check still fails.
    const [c11n] = await runChecks({ harness, shim: 'good', policy: { 'surfaces.fake.users': [] } }, ['C11n'], ALL_CHECKS)
    expect(c11n.detail).toContain('expected both rooms to be refused under mem.one-scope, got 0')
  }, 30_000)

  it('[U:letta-code-must-fail] C11n also moves the one room after a turn in it, and a door that gave the harness the new room would fail it', async () => {
    // The good shim passes, and the move is what it passed: three refusals, the third for the room it was moved to.
    const good = await startLab({ harness, shim: 'good', policy: C11N.lab!.policy })
    try {
      expect(await C11N.run(good)).toEqual([])
      const refused = good.receipts.all().filter((r) => r.rule === 'mem.one-scope' && r.verdict === 'drop')
      expect(refused.map((r) => r.event.room)).toEqual(['r-general', 'r-lounge', 'r-lounge'])
      expect(refused[2].why).toContain('it has already been given another conversation')
    } finally { await good.close() }
    // A shim that hides the memory is given the moved room too, and the check says so by name.
    const lax = await startLab({ harness, shim: 'hides-memory', policy: { ...C11N.lab!.policy, 'surfaces.fake.rooms': [] } })
    try {
      // No room is open at the start, so the first half of the check has nothing to cross: only the move is left.
      const problems = await C11N.run(lax)
      expect(problems).toContain('after its one room was moved, the harness was given the new room')
      expect(problems).toContain('a note written to memory in one room was sent to the model in the room it was moved to')
    } finally { await lax.close() }
  }, 60_000)

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

// The matrix file is evidence from a real Letta Code run, and only `npm run
// conformance -- letta-code` may write it. CI cannot repeat that run, but it
// can tell when the file no longer matches the suite: a check or a broken
// shim added since means the evidence is out of date and the run has to be
// done again.
describe('the committed matrix for the pinned Letta Code', () => {
  const file = path.resolve(import.meta.dirname, '..', 'matrix', `letta-code-${LETTA_CODE_VERSION}.process.json`)
  const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
  const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

  it('[U:letta-code-matrix] is from a real Letta Code of the pinned version, run as a plain process', () => {
    expect(committed).toMatchObject({ harness: 'letta-code', version: LETTA_CODE_VERSION, harnessBuild: 'real', substrate: 'process' })
  })

  it('[U:letta-code-matrix] has a result for every check the suite runs today, under today\'s title', () => {
    // Every check anyone knows of has a row, run or not, plus this harness's own, and there is no row for one nobody knows.
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...LETTA_CODE_CHECKS.map((c) => c.id)])].sort())
    for (const check of ALL_CHECKS) {
      expect(rows[check.id], `${check.id} is not in the matrix: run npm run conformance -- letta-code`).toBeDefined()
      expect(['pass', 'fail'], check.id).toContain(rows[check.id].status)
      expect(rows[check.id].title, check.id).toBe(check.title)
    }
  })

  it('[U:letta-code-matrix] names every broken shim the suite has today, with the checks each must fail today', () => {
    const today = Object.fromEntries(Object.entries(brokenVariants(harness)).map(([shim, v]) => [shim, v.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
    expect(committed.suiteTrusted).toBe(true)
  })

  it('[U:letta-code-matrix] says what it does not show: no memory per room, and no wall at process level', () => {
    // The spec's memory check is wider than C11n, and stays not-run.
    expect(rows.C11).toMatchObject({ status: 'not-run' })
    expect(rows.C7).toMatchObject({ status: 'not-run' })
    for (const id of ['S1', 'C8', 'C9', 'C10']) expect(rows[id], id).toMatchObject({ status: 'not-run' })
    const rule = Object.fromEntries(committed.rules.map((r) => [r.rule, r.status]))
    // Neither wall of the model route, nor the posture rule, is claimed without a sealed cell.
    for (const id of ['budget.cap', 'keys.model-route', 'tools.posture']) expect(rule[id], id).toBe('not-run')
    expect(rule['mem.one-scope']).toBe('shared')
  })
})
