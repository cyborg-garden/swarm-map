// @vitest-environment node
//
// Guard on the guards: a rule with no test is a claim nobody earned, and a
// test id that points at nothing is a claim that only looks earned.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadScenarios } from '../../../conformance/scenarios/load.ts'
import { RULES } from '../rules/catalogue.ts'

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

// Titles like `it('[P:receipts] ...')` in lib/ and conformance/.
const titled = new Set<string>()
for (const dir of ['lib', 'conformance']) {
  for (const file of testFiles(path.join(ROOT, dir))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\[([PU]:[a-z0-9.-]+)\]/g)) titled.add(m[1])
  }
}
const scenarios = loadScenarios()
const scenarioIds = new Set(scenarios.map((s) => `D:${s.id}`))

describe('rule catalogue', () => {
  it('rule ids are unique', () => {
    const ids = RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(RULES.map((r) => [r.id, r] as const))('%s has a test, and every test id exists', (_id, rule) => {
    expect(rule.tests.length, 'no tests').toBeGreaterThan(0)
    const missing = rule.tests.filter((t) => !scenarioIds.has(t) && !titled.has(t))
    expect(missing).toEqual([])
  })

  it('every scenario tests a rule in the catalogue, and is listed by it', () => {
    const byId = new Map(RULES.map((r) => [r.id, r]))
    const unlisted = scenarios.filter((s) => !byId.get(s.rule)?.tests.includes(`D:${s.id}`)).map((s) => s.id)
    expect(unlisted).toEqual([])
  })
})
