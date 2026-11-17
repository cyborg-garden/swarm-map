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
import { fakePiCommand, PI_CHECKS as CHECKS, piHarness } from '../harnesses/pi.ts'
import { runChecks as runShared, type CheckResult } from './checks.ts'
import { KNOWN_CHECK_IDS, type Matrix } from '../matrix.ts'
import { brokenVariants } from './harness.ts'
import { MODEL_FAILURE_CHECKS } from './failure-checks.ts'
import { TOOL_CHECKS } from './tool-checks.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const harness = piHarness(fakePiCommand(), 'fake')
// Every run here is over Pi's whole list: the shared checks and the tool checks.
const runChecks = (base: Parameters<typeof runShared>[0], ids?: string[]) => runShared(base, ids, CHECKS)
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
      ['answers-as-admin', 'chatty', 'covers-failures', 'dials-out', 'gate-missing', 'gate-silent', 'ignores-verdicts', 'inherits-env', 'leaks-env', 'no-limits', 'no-path-check', 'runs-more', 'silence-is-yes', 'unwatched'])
    const ids = CHECKS.map((c) => c.id)
    for (const [name, v] of Object.entries(variants)) {
      expect(v.red.length, name).toBeGreaterThan(0)
      for (const id of [...v.red, ...v.green]) expect(ids, `${name} names ${id}`).toContain(id)
    }
  })

  it.each(Object.entries(variants))('[U:must-fail] %s', async (name, { red, green, shim, lab, checks }) => {
    const results = byId(await runChecks({ harness, shim: shim ?? name, ...lab }, checks))
    for (const id of red) expect(results[id].pass, `${name} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id].pass, `${name} must still pass ${id}: ${results[id].detail}`).toBe(true)
  }, 240_000)

  it('[U:must-fail] every tool check has something broken on purpose that must turn it red', () => {
    const covered = new Set(Object.values(variants).flatMap((v) => v.red))
    // C6s waits out a turn that never ends, so a shim has nothing to cover up in it. What turns it red is a door that says nothing at the deadline: door.test.ts [P:one-reply].
    for (const check of [...TOOL_CHECKS, ...MODEL_FAILURE_CHECKS]) if (check.id !== 'W1+' && check.id !== 'C6s') expect([...covered], check.id).toContain(check.id)
  })

  it('[U:must-fail] each tool check goes red for the reason it names', async () => {
    const detail = async (name: string, id: string): Promise<string> => {
      const v = variants[name]
      return (await runChecks({ harness, shim: v.shim ?? name, ...v.lab }, [id]))[0].detail
    }
    expect(await detail('ignores-verdicts', 'C6')).toContain('the door never asked in the room')
    expect(await detail('answers-as-admin', 'C6n')).toContain('the tool ran on an answer that was not an admin\'s')
    expect(await detail('runs-more', 'C6x')).toContain('the call that ran made')
    expect(await detail('runs-more', 'C6x')).toContain('runs-more.marker')
    expect(await detail('no-path-check', 'W1')).toContain('a file outside the scratch folder was read')
    expect(await detail('no-path-check', 'W1')).toContain('a folder outside the scratch folder was listed')
    expect(await detail('no-path-check', 'W1')).toContain('a file was written outside the scratch folder (w1.planted)')
    expect(await detail('no-path-check', 'W1')).toContain('a file was written outside the scratch folder (w1.planted-by-link)')
    expect(await detail('no-limits', 'L1')).toBe('a call ran on past the time limit')
    expect(await detail('no-limits', 'L2')).toContain('output past the size limit reached the model')
    expect(await detail('silence-is-yes', 'C5v')).toContain('the tool ran with no verdict')
    expect(await detail('ignores-verdicts', 'K1')).toContain('a hidden write ran with no yes (case 0)')
    expect(await detail('ignores-verdicts', 'K1')).toContain('a blocked command ran')
    expect(await detail('covers-failures', 'C6m')).toContain('the room was not told why: "All done."')
    expect(await detail('covers-failures', 'C6b')).toContain('the room was not told why: "All done."')
  }, 120_000)

  it('[U:must-fail] a harness that ran with no tripwire inside it fails C9p for that reason, not for another', async () => {
    const [c9p] = await runChecks({ harness, shim: 'unwatched' }, ['C9p'])
    expect(c9p.pass).toBe(false)
    expect(c9p.detail).toBe('no tripwire was armed inside the harness process, so nothing was checked')
  }, 30_000)

  it('[U:must-fail] a gate that lets everything run is caught by the posture check, for the posture rule', async () => {
    const [good] = await runChecks({ harness, shim: 'good' }, ['C4p'])
    expect(good.detail).toBe('ok')
    const [broken] = await runChecks({ harness, shim: 'ignores-verdicts' }, ['C4p'])
    expect(broken.pass).toBe(false)
    expect(broken.detail).toContain('a public agent ran a shell tool')
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
    // Every check anyone knows of has a row, run or not, and there is no row for one nobody knows.
    // Plus Pi's own: the checks that a failed model call is told to the room.
    expect(Object.keys(rows).sort()).toEqual([...new Set([...KNOWN_CHECK_IDS, ...MODEL_FAILURE_CHECKS.map((c) => c.id)])].sort())
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
