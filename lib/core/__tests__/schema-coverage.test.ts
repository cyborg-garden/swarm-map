// @vitest-environment node
//
// Guard on the guards: a PolicyRecord field that no rule reads is a knob
// nothing is wired to. Every field path must be read by a catalogue rule, or
// sit in DEFERRED_FIELDS with the id of the rule that will read it.
import { describe, expect, it } from 'vitest'
import { RULES } from '../rules/catalogue.ts'
import { DEFERRED_FIELDS, DEFERRED_COUNT_CEILING } from '../policy/deferred.ts'
import { EXEMPLAR_POLICY, fieldPaths } from '../policy/exemplar.ts'

describe('schema coverage', () => {
  const paths = fieldPaths(EXEMPLAR_POLICY)

  it('walks a real set of field paths', () => {
    expect(paths).toContain('surfaces.*.dm.mode')
    expect(paths).toContain('tools.allow')
    expect(paths).toContain('budget.monthlyUsd')
    expect(paths.length).toBeGreaterThan(30)
  })

  it('every field is read by a rule or is on the deferred list', () => {
    const read = new Set(RULES.flatMap((r) => r.reads))
    const deferred = new Set(DEFERRED_FIELDS.map((d) => d.path))
    const orphans = paths.filter((p) => !read.has(p) && !deferred.has(p))
    expect(orphans).toEqual([])
  })

  it('no rule or deferred entry names a field that does not exist', () => {
    const known = new Set(paths)
    const ghosts = [
      ...RULES.flatMap((r) => r.reads),
      ...DEFERRED_FIELDS.map((d) => d.path),
    ].filter((p) => !known.has(p))
    expect(ghosts).toEqual([])
  })

  it('every deferred field names the rule that will read it', () => {
    for (const d of DEFERRED_FIELDS) expect(d.rule, d.path).toMatch(/^[a-z]+\.[a-z0-9.-]+$/)
  })

  it('the deferred list may only shrink', () => {
    expect(DEFERRED_FIELDS.length).toBeLessThanOrEqual(DEFERRED_COUNT_CEILING)
  })
})
