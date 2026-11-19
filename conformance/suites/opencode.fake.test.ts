// @vitest-environment node
//
// C: shim conformance for OpenCode over ACP, at process level. The same
// shared checks every harness is put through, and the ask flow of the tool
// checks. Here the harness is the fake OpenCode (so this runs in CI);
// `npm run conformance -- opencode` runs the same checks against the real one.
//
// Must-fail: the same checks against deliberately broken shims and agents.
// A broken one that passes a check it is meant to fail means the check is wrong.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { OPENCODE_VERSION } from '../../lib/runtimes/opencode/caps.ts'
import { armTripwire, tripwireAttempts } from '../guards/tripwire.ts'
import type { Matrix } from '../matrix.ts'
import { ALL_CHECKS, fakeOpenCodeCommand, openCodeHarness } from '../harnesses/opencode.ts'
import { runChecks, type CheckResult } from './checks.ts'
import { brokenVariants } from './harness.ts'
import { startLab } from './lab.ts'

armTripwire()
afterAll(() => expect(tripwireAttempts()).toEqual([]))

const harness = openCodeHarness(fakeOpenCodeCommand(), 'fake')
const byId = (results: CheckResult[]) => Object.fromEntries(results.map((r) => [r.id, r]))
const run = (shim: string, ids?: string[]) => runChecks({ harness, shim }, ids, ALL_CHECKS)

describe('OpenCode shim, against the fake OpenCode', () => {
  it.each(ALL_CHECKS.map((c) => [c.id, c.title] as const))('[U:opencode-shim] %s %s', async (id) => {
    const [result] = await run('good', [id])
    expect(result.detail, result.detail).toBe('ok')
    expect(result.pass).toBe(true)
  }, 30_000)
})

describe('must-fail: broken shims and agents turn their named checks red', () => {
  const variants = brokenVariants(harness)

  it('every way of breaking it is listed, and each names a check that exists', () => {
    expect(Object.keys(variants).sort()).toEqual(
      ['allows-all', 'chatty', 'dials-out', 'ignores-reject', 'inherits-env', 'leaks-env', 'other-version', 'picks-always', 'unwatched'])
    const ids = ALL_CHECKS.map((c) => c.id)
    for (const [name, v] of Object.entries(variants)) {
      expect(v.red.length, name).toBeGreaterThan(0)
      for (const id of [...v.red, ...v.green]) expect(ids, `${name} names ${id}`).toContain(id)
    }
  })

  it.each(Object.entries(variants))('[U:opencode-must-fail] %s', async (shim, { red, green }) => {
    const results = byId(await run(shim))
    for (const id of red) expect(results[id].pass, `${shim} must fail ${id}`).toBe(false)
    for (const id of green) expect(results[id].pass, `${shim} must still pass ${id}: ${results[id].detail}`).toBe(true)
  }, 300_000)
})

// What the door saw of a turn the shim caught: its error receipt, and what was posted.
function caught(lab: Awaited<ReturnType<typeof startLab>>): { errors: number; modelPosts: number } {
  return {
    errors: lab.receipts.all().filter((r) => r.rule === 'out.still-allowed' && r.verdict === 'drop' && r.why === 'The harness reported an error for this turn.').length,
    modelPosts: lab.fake.ledger.filter((p) => p.text.includes(`FAKE-MODEL-${lab.nonce}`)).length,
  }
}

describe('ACP: what the shim catches that ACP itself cannot stop', () => {
  it('[U:opencode-breach] an agent that acts on a call the door refused is caught: the turn is an error at the door and its reply is never posted', async () => {
    const breaches: string[] = []
    const lab = await startLab({ harness: withBreachLog(breaches), shim: 'ignores-reject', policy: { 'tools.allow': ['shell'] }, silentVerdicts: true })
    try {
      const canary = lab.canary('breach')
      const file = lab.file('breach.touched')
      lab.script({ match: canary, tool: lab.harness.shell.touch(file), text: 'done' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `run ${canary}` })
      await lab.door.idle()
      // ACP cannot stop it: the call ran.
      expect(existsSync(file)).toBe(true)
      expect(breaches).toEqual(['the agent ran a call the door said no to'])
      expect(caught(lab)).toEqual({ errors: 1, modelPosts: 0 })
    } finally { await lab.close() }
  }, 30_000)

  it('[U:opencode-once-only] a yes that reaches the agent as "always" is caught on the next call, which the agent no longer asks about', async () => {
    const breaches: string[] = []
    const lab = await startLab({ harness: withBreachLog(breaches), shim: 'picks-always', policy: { 'tools.allow': ['shell'] } })
    try {
      const canary = lab.canary('always')
      // Asked for on every turn the canary is in, not only the first.
      lab.script({ match: canary, tools: [lab.harness.shell.touch(lab.file('always.touched'))], text: 'done' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `run ${canary}` })
      await lab.door.idle()
      expect(breaches).toEqual([])
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `again ${canary}` })
      await lab.door.idle()
      expect(breaches).toEqual(['the agent ran a call it never asked the door about'])
      // The first turn's reply was posted; the second turn's was not.
      expect(caught(lab)).toEqual({ errors: 1, modelPosts: 1 })
    } finally { await lab.close() }
  }, 30_000)

  it('[U:opencode-once-only] what the door posts for approval offers approve or deny, never "always"', async () => {
    const lab = await startLab({ harness, shim: 'good', policy: { 'tools.allow': [], 'tools.ask': ['shell'] }, approvalTimeoutMs: 800, verdictTimeoutMs: 3000, vetoTimeoutMs: 4000 })
    try {
      const canary = lab.canary('offer')
      lab.script({ match: canary, tool: lab.harness.shell.touch(lab.file('offer.touched')), text: 'done' })
      lab.fake.say({ room: 'r-general', sender: 'u-alice', mention: true, text: `run ${canary}` })
      await lab.door.idle()
      const requests = lab.fake.ledger.filter((p) => p.text.startsWith('Approval needed.'))
      expect(requests).toHaveLength(1)
      for (const p of lab.fake.ledger) expect(p.text.toLowerCase()).not.toContain('always')
    } finally { await lab.close() }
  }, 30_000)
})

/** The same harness, with the shim's breach reports collected. */
function withBreachLog(into: string[]): typeof harness {
  return openCodeHarness(fakeOpenCodeCommand(), 'fake', { onBreach: (why) => into.push(why) })
}

// The matrix file is evidence from a real OpenCode run, and only `npm run conformance -- opencode` may
// write it. CI can tell when it no longer matches the suite: a check or a broken shim added since.
describe('the committed matrix for the pinned OpenCode', () => {
  const file = path.resolve(import.meta.dirname, '..', 'matrix', `opencode-${OPENCODE_VERSION}.process.json`)
  const committed = JSON.parse(readFileSync(file, 'utf8')) as Matrix
  const rows = Object.fromEntries(committed.rows.map((r) => [r.id, r]))

  it('[U:opencode-matrix] is from a real OpenCode of the pinned version, run as a plain process, and every check it runs passed', () => {
    expect(committed).toMatchObject({ harness: 'opencode', version: OPENCODE_VERSION, harnessBuild: 'real', substrate: 'process', suiteTrusted: true })
    for (const check of ALL_CHECKS) expect(rows[check.id], `${check.id}: run npm run conformance -- opencode`).toMatchObject({ status: 'pass', title: check.title })
  })

  it('[U:opencode-matrix] names every broken shim the suite has today, with the checks each must fail today', () => {
    const today = Object.fromEntries(Object.entries(brokenVariants(harness)).map(([shim, v]) => [shim, v.red]))
    expect(Object.fromEntries(committed.mustFail.map((m) => [m.shim, m.mustFail]))).toEqual(today)
    for (const m of committed.mustFail) for (const id of m.mustFail) expect(m.failed, `${m.shim} must fail ${id}`).toContain(id)
  })
})
