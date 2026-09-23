// @vitest-environment node
//
// #136 — stale/retired models are FLAGGED in the catalog, never deleted, and
// validateCascadeEntries stays fail-open for them (a live cascade that still
// references a retired id must remain writable/readable).
import { describe, it, expect } from 'vitest'
import { MODEL_CATALOG, validateCascadeEntries } from '../model-catalog'

const or = (id: string) => MODEL_CATALOG.openrouter.find((m) => m.id === id)

describe('model catalog hygiene (#136)', () => {
  it('deepseek/deepseek-v3.2 is retired (expires 2026-09-28) but still listed', () => {
    const row = or('deepseek/deepseek-v3.2')
    expect(row).toBeDefined()
    expect(row!.retired).toBe(true)
    expect(row!.deprecates).toBe('2026-09-28')
  })

  it('google/gemini-2.5-flash carries its 2026-10-20 deprecation date and is not retired', () => {
    const row = or('google/gemini-2.5-flash')
    expect(row!.deprecates).toBe('2026-10-20')
    expect(row!.retired).toBeUndefined()
  })

  it('every deprecates value is an ISO date and the fleet primaries carry neither flag', () => {
    for (const rows of Object.values(MODEL_CATALOG)) {
      for (const m of rows) {
        if (m.deprecates !== undefined) expect(m.deprecates).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      }
    }
    expect(or('z-ai/glm-5.3')!.retired).toBeUndefined()
    expect(or('z-ai/glm-5.3')!.deprecates).toBeUndefined()
  })

  it('validateCascadeEntries still accepts a retired model (fail-open)', () => {
    expect(
      validateCascadeEntries([{ provider: 'openrouter', model: 'deepseek/deepseek-v3.2' }], new Set(['OPENROUTER_API_KEY'])),
    ).toEqual([])
  })
})
