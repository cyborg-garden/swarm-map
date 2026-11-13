// @vitest-environment node
//
// Pi's own rules: what the Pi shim promises that the shared catalogue cannot
// promise for every harness. Same guard as the catalogue: each must be proven
// by a test that exists.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../../core/rules/catalogue.ts'
import { PI_RULES } from '../rules.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const PI_TEST_DIRS = ['lib/runtimes/pi/__tests__', 'conformance/suites', 'conformance/rig/__tests__']
const titled = new Set<string>()
for (const dir of PI_TEST_DIRS) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (!name.endsWith('.test.ts') || name === 'rules.test.ts') continue
    for (const m of readFileSync(path.join(ROOT, dir, name), 'utf8').matchAll(/\[(U:[a-z0-9.-]+)\]/g)) titled.add(m[1])
  }
}

describe('Pi rules', () => {
  it('ids are unique, start with pi., and none shadows a shared rule', () => {
    const ids = PI_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^pi\.[a-z-]+$/)
    expect(ids.filter((id) => RULES.some((r) => r.id === id))).toEqual([])
  })

  it.each(PI_RULES.map((r) => [r.id, r] as const))('%s has a test, and every test id exists', (_id, rule) => {
    expect(rule.tests.length).toBeGreaterThan(0)
    expect(rule.tests.filter((t) => !titled.has(t))).toEqual([])
  })

  it('the mechanisms that used to sit in the shared catalogue are here', () => {
    const proof = new Set(PI_RULES.flatMap((r) => r.tests))
    for (const id of ['U:pi-gate-ready', 'U:pi-gate', 'U:pi-preamble', 'U:must-fail', 'U:pi-env']) expect(proof, id).toContain(id)
  })
})
