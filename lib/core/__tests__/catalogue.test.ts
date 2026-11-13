// @vitest-environment node
//
// Guard on the guards: a rule with no test is a claim nobody earned, and a
// test id that points at nothing is a claim that only looks earned.
//
// The catalogue is shared by every harness, so its proof has to be too. A
// rule's `tests` may only name tests of shared code. What one harness must
// show for the rule is named in `checks`: shim checks every harness is put
// through, whose result is that harness's matrix. A test of one harness's
// shim proves nothing about the next harness, and may not stand in here.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_CHECK_IDS } from '../../../conformance/matrix.ts'
import { loadScenarios } from '../../../conformance/scenarios/load.ts'
import { SURFACE_IDS } from '../policy/shape.ts'
import { RULES, type Rule } from '../rules/catalogue.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function testFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (name.endsWith('.test.ts') && name !== 'catalogue.test.ts') out.push(full)
  }
  return out
}

/** A test file is about one harness if it lives with a runtime, or imports a runtime or a harness adapter. */
function isHarnessSide(file: string, source: string): boolean {
  if (path.relative(ROOT, file).split(path.sep).includes('runtimes')) return true
  return [...source.matchAll(/from '([^']+)'/g)].some((m) => m[1].includes('/runtimes/') || m[1].includes('/harnesses/'))
}

// Titles like `it('[P:receipts] ...')` in lib/ and conformance/, split by what they test.
const shared = new Set<string>()
const harnessSide = new Set<string>()
for (const dir of ['lib', 'conformance']) {
  for (const file of testFiles(path.join(ROOT, dir))) {
    const source = readFileSync(file, 'utf8')
    const into = isHarnessSide(file, source) ? harnessSide : shared
    for (const m of source.matchAll(/\[([PU]:[a-z0-9.-]+)\]/g)) into.add(m[1])
  }
}
const scenarios = loadScenarios()
const scenarioIds = new Set(scenarios.map((s) => `D:${s.id}`))

/** Everything wrong with one rule's proof. Empty means the claim is earned as far as this file can tell. */
function problems(rule: Pick<Rule, 'tests' | 'checks' | 'enforcer' | 'surfaces'>): string[] {
  const out: string[] = []
  if (rule.tests.length === 0) out.push('no tests')
  for (const t of rule.tests) {
    if (scenarioIds.has(t) || shared.has(t)) continue
    out.push(harnessSide.has(t) ? `${t} is a test of one harness, not of shared code` : `${t} does not exist`)
  }
  for (const c of rule.checks) if (!KNOWN_CHECK_IDS.includes(c)) out.push(`${c} is not a shim check`)
  // The gate and the model route only work with the harness's part in place, so that part must be named.
  if ((rule.enforcer === 'gate' || rule.enforcer === 'model-route') && rule.checks.length === 0) {
    out.push(`enforced by the ${rule.enforcer}, which needs the harness, but names no shim check`)
  }
  if (rule.surfaces !== 'all') {
    if (rule.surfaces.length === 0) out.push('applies to no surface')
    for (const s of rule.surfaces) if (!SURFACE_IDS.includes(s)) out.push(`${s} is not a surface`)
  }
  return out
}

describe('rule catalogue', () => {
  it('rule ids are unique', () => {
    const ids = RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the test files were split: both kinds exist, and the known examples fell on the right side', () => {
    expect(shared.has('P:receipts')).toBe(true)
    expect(shared.has('U:budget-meter')).toBe(true)
    expect(harnessSide.has('U:pi-shim')).toBe(true)
    expect(harnessSide.has('U:pi-gate')).toBe(true)
    expect(shared.has('U:pi-shim') || shared.has('U:pi-gate') || shared.has('U:must-fail')).toBe(false)
  })

  it.each(RULES.map((r) => [r.id, r] as const))('%s is proven by shared tests that exist, and names shim checks that exist', (_id, rule) => {
    expect(problems(rule)).toEqual([])
  })

  // Negative controls: each of these was, or could be, in the catalogue. Each must be refused.
  const good: Pick<Rule, 'tests' | 'checks' | 'enforcer' | 'surfaces'> = { tests: ['P:receipts'], checks: [], enforcer: 'door', surfaces: 'all' }
  it.each([
    ['a rule proven only by one harness\'s shim suite', { ...good, tests: ['U:pi-shim'] }, /U:pi-shim is a test of one harness/],
    ['a shared test plus one harness\'s unit test', { ...good, tests: ['P:receipts', 'U:pi-gate'] }, /U:pi-gate is a test of one harness/],
    ['a rule proven by must-fail runs of one harness', { ...good, tests: ['U:must-fail'] }, /U:must-fail is a test of one harness/],
    ['a test id that points at nothing', { ...good, tests: ['U:no-such-test'] }, /U:no-such-test does not exist/],
    ['no tests at all', { ...good, tests: [] }, /no tests/],
    ['a shim check that does not exist', { ...good, checks: ['C99'] }, /C99 is not a shim check/],
    ['a gate rule that names no shim check', { ...good, enforcer: 'gate' as const }, /names no shim check/],
    ['a model-route rule that names no shim check', { ...good, enforcer: 'model-route' as const }, /names no shim check/],
    ['a surface that does not exist', { ...good, surfaces: ['irc' as never] }, /irc is not a surface/],
    ['an empty surface list', { ...good, surfaces: [] }, /applies to no surface/],
  ])('refuses %s', (_what, rule, why) => {
    expect(problems(rule).join('; ')).toMatch(why)
  })

  it('accepts the plain good case the negative controls are built from', () => {
    expect(problems(good)).toEqual([])
  })

  it('every scenario tests a rule in the catalogue, and is listed by it', () => {
    const byId = new Map(RULES.map((r) => [r.id, r]))
    const unlisted = scenarios.filter((s) => !byId.get(s.rule)?.tests.includes(`D:${s.id}`)).map((s) => s.id)
    expect(unlisted).toEqual([])
  })

  it('no shared rule is about one harness\'s mechanism', () => {
    // A harness's own rules live with its runtime (lib/runtimes/<id>/rules.ts).
    expect(RULES.map((r) => r.id)).not.toContain('tools.gate-loaded')
    expect(RULES.filter((r) => /\bPi\b/.test(r.statement)).map((r) => r.id)).toEqual([])
  })
})
