// @vitest-environment node
//
// The Claude Agent SDK shim's own rules: what it promises that the shared
// catalogue cannot promise for every harness. Same guard as the catalogue:
// each must be proven by a test that exists.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../../core/rules/catalogue.ts'
import { CLAUDE_SDK_RULES } from '../rules.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..')
const TEST_DIRS = ['lib/runtimes/claude-sdk/__tests__', 'conformance/suites', 'conformance/rig/__tests__']
const titled = new Set<string>()
for (const dir of TEST_DIRS) {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (!name.endsWith('.test.ts') || name === 'rules.test.ts' || !(dir.includes('claude-sdk') || name.includes('claude-sdk'))) continue
    for (const m of readFileSync(path.join(ROOT, dir, name), 'utf8').matchAll(/\[(U:[a-z0-9.-]+)\]/g)) titled.add(m[1])
  }
}

describe('Claude Agent SDK rules', () => {
  it('ids are unique, start with claude-sdk., and none shadows a shared rule', () => {
    const ids = CLAUDE_SDK_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^claude-sdk\.[a-z-]+$/)
    expect(ids.filter((id) => RULES.some((r) => r.id === id))).toEqual([])
  })

  it('only tests of this harness were read', () => {
    expect(titled.has('U:claude-sdk-session')).toBe(true)
    expect([...titled].filter((t) => t.startsWith('U:pi-') || t.startsWith('U:letta-code-'))).toEqual([])
  })

  it.each(CLAUDE_SDK_RULES.map((r) => [r.id, r] as const))('%s has a test, and every test id exists', (_id, rule) => {
    expect(rule.tests.length).toBeGreaterThan(0)
    expect(rule.tests.filter((t) => !titled.has(t))).toEqual([])
  })
})
