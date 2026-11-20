// @vitest-environment node
//
// OpenCode's own rules: each must be proven by a test that exists. Same guard as the catalogue.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../../core/rules/catalogue.ts'
import { OPENCODE_RULES } from '../rules.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const TEST_DIRS = ['lib/runtimes/opencode/__tests__', 'lib/runtimes/acp/__tests__', 'conformance/suites']
const titled = new Set<string>()
for (const dir of TEST_DIRS) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (!name.endsWith('.test.ts') || name === 'rules.test.ts' || !(dir.includes('opencode') || dir.includes('acp') || name.includes('opencode'))) continue
    for (const m of readFileSync(path.join(ROOT, dir, name), 'utf8').matchAll(/\[(U:[a-z0-9.-]+)\]/g)) titled.add(m[1])
  }
}

describe('OpenCode rules', () => {
  it('ids are unique, start with opencode., and none shadows a shared rule', () => {
    const ids = OPENCODE_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^opencode\.[a-z-]+$/)
    expect(ids.filter((id) => RULES.some((r) => r.id === id))).toEqual([])
  })

  it('only tests of OpenCode and the ACP client were read', () => {
    expect(titled.has('U:acp-breach')).toBe(true)
    expect([...titled].filter((t) => t.startsWith('U:pi-') || t.startsWith('U:letta-code'))).toEqual([])
  })

  it.each(OPENCODE_RULES.map((r) => [r.id, r] as const))('%s has a test, and every test id exists', (_id, rule) => {
    expect(rule.tests.length).toBeGreaterThan(0)
    expect(rule.tests.filter((t) => !titled.has(t))).toEqual([])
  })
})
