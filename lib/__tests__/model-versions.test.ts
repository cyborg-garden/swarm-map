// @vitest-environment node
//
// Table tests for the model-id normaliser + successor finder. The OpenRouter
// fixture rows below are verbatim (id, canonical_slug, created, expiration)
// from the live GET /api/v1/models list on 2026-09-22 — the same list the
// prototype was verified against.
import { describe, it, expect } from 'vitest'
import {
  normalizeModelId,
  findSuccessor,
  modelIdentityKey,
  priceRatio,
  type LiveModel,
} from '../model-versions'

const TODAY = '2026-09-22'

const p = (prompt: number, completion: number) => ({ prompt, completion })

// Subset of the live OpenRouter list. Aliases keep their `~` prefix.
const OR: LiveModel[] = [
  { id: 'z-ai/glm-5.3-flashx', canonical: 'z-ai/glm-5.3-flashx-20260918', created: 1789800000 },
  { id: 'deepseek/deepseek-v4.1-flash', canonical: 'deepseek/deepseek-v4.1-flash-20260910', created: 1789100000, pricing: p(0.00000005, 0.0000007) },
  { id: 'google/gemini-3.8-flash', canonical: 'google/gemini-3.8-flash-20260902', created: 1788400000, pricing: p(0.0000005, 0.000003) },
  { id: 'google/gemini-3.8-flash:batch', canonical: 'google/gemini-3.8-flash-20260902', created: 1788400000 },
  { id: 'z-ai/glm-5.3-flash', canonical: 'z-ai/glm-5.3-flash-20260826', created: 1787800000 },
  { id: 'z-ai/glm-5.3-flash:batch', canonical: 'z-ai/glm-5.3-flash-20260826', created: 1787800000 },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', canonical: 'deepseek/deepseek-v4-flash-vision-exp-20260821', created: 1787400000 },
  { id: '~z-ai/glm-latest', canonical: '~z-ai/glm-latest', created: 1787100000 },
  { id: 'z-ai/glm-5.3', canonical: 'z-ai/glm-5.3-20260816', created: 1787086655, pricing: p(0.00000091, 0.00000286) },
  { id: 'z-ai/glm-5.3:batch', canonical: 'z-ai/glm-5.3-20260816', created: 1787086655 },
  { id: '~deepseek/deepseek-v4-flash-latest', canonical: '~deepseek/deepseek-v4-flash-latest', created: 1785500000 },
  { id: 'deepseek/deepseek-v4-flash-0731', canonical: 'deepseek/deepseek-v4-flash-20260731', created: 1785478908, pricing: p(0.00000004, 0.00000064) },
  { id: 'anthropic/claude-opus-5', canonical: 'anthropic/claude-opus-5-20260723', created: 1784800000 },
  { id: 'moonshotai/kimi-k3', canonical: 'moonshotai/kimi-k3-20260715', created: 1784215858, pricing: p(0.000003, 0.000015) },
  { id: 'anthropic/claude-sonnet-5', canonical: 'anthropic/claude-sonnet-5-20260630', created: 1782800000 },
  { id: 'google/gemini-3.5-flash-lite', canonical: 'google/gemini-3.5-flash-lite-20260721', created: 1784700000 },
  { id: 'z-ai/glm-5.2', canonical: 'z-ai/glm-5.2-20260616', created: 1781631930, pricing: p(0.0000006496, 0.0000020416) },
  { id: 'z-ai/glm-5.2:free', canonical: 'z-ai/glm-5.2-20260616', created: 1781631930, pricing: p(0, 0) },
  { id: 'moonshotai/kimi-k2.7-code', canonical: 'moonshotai/kimi-k2.7-code-20260612', created: 1781266361, pricing: p(0.0000007062, 0.00000321) },
  { id: 'moonshotai/kimi-k2.7', canonical: 'moonshotai/kimi-k2.7-20260601', created: 1780400000 },
  { id: 'openai/gpt-5.5', canonical: 'openai/gpt-5.5-20260520', created: 1779400000 },
  { id: 'openai/gpt-6-astra', canonical: 'openai/gpt-6-astra-20260601', created: 1780300000 },
  { id: 'deepseek/deepseek-v4-pro-0813', canonical: 'deepseek/deepseek-v4-pro-20260813', created: 1786600000 },
  { id: 'deepseek/deepseek-v4-flash', canonical: 'deepseek/deepseek-v4-flash-20260423', created: 1777000666, pricing: p(0.000000088606, 0.000000177212) },
  { id: 'deepseek/deepseek-v4-pro', canonical: 'deepseek/deepseek-v4-pro-20260423', created: 1777000000 },
  { id: 'anthropic/claude-opus-4.6', canonical: 'anthropic/claude-4.6-opus-20260205', created: 1770300000 },
  { id: 'anthropic/claude-sonnet-4.6', canonical: 'anthropic/claude-4.6-sonnet-20260217', created: 1771342990, pricing: p(0.000003, 0.000015) },
  { id: 'google/gemini-3-flash-preview', canonical: 'google/gemini-3-flash-preview-20251217', created: 1765900000 },
  { id: 'deepseek/deepseek-v3.2', canonical: 'deepseek/deepseek-v3.2-20251201', created: 1764594642, expiration: '2026-09-28' },
  { id: 'deepseek/deepseek-v3.2-exp', canonical: 'deepseek/deepseek-v3.2-exp', created: 1758000000, expiration: '2026-09-28' },
  { id: 'anthropic/claude-sonnet-4.5', canonical: 'anthropic/claude-4.5-sonnet-20250929', created: 1759161676 },
  { id: 'google/gemini-2.5-flash', canonical: 'google/gemini-2.5-flash', created: 1750172488, expiration: '2026-10-20', pricing: p(0.0000003, 0.0000025) },
  { id: 'google/gemini-2.5-flash-preview', canonical: 'google/gemini-2.5-flash-preview', created: 1745000000 },
  { id: 'openai/gpt-4.1', canonical: 'openai/gpt-4.1', created: 1744700000 },
  { id: 'openai/gpt-4o-2024-11-20', canonical: 'openai/gpt-4o-2024-11-20', created: 1732100000 },
  { id: 'openai/gpt-4o', canonical: 'openai/gpt-4o', created: 1715558400 },
  { id: 'qwen/qwen3-235b-a22b-2507', canonical: 'qwen/qwen3-235b-a22b-2507', created: 1753200000 },
  { id: 'qwen/qwen3-235b-a22b', canonical: 'qwen/qwen3-235b-a22b', created: 1745900000 },
  { id: 'qwen/qwen3.8-flash', canonical: 'qwen/qwen3.8-flash-20260901', created: 1788300000 },
  { id: 'deepseek/deepseek-r1', canonical: 'deepseek/deepseek-r1', created: 1737300000 },
]

const or = (model: string, live: LiveModel[] = OR) => findSuccessor({ provider: 'openrouter', model }, live, TODAY)

describe('normalizeModelId', () => {
  it('parses an OpenRouter vendor/family-version id', () => {
    const n = normalizeModelId('openrouter', 'z-ai/glm-5.2')
    expect(n.vendor).toBe('z-ai')
    expect(n.family).toEqual(['glm'])
    expect(n.version).toEqual([5, 2])
    expect(n.tags.size).toBe(0)
    expect(n.routing.size).toBe(0)
    expect(n.alias).toBe(false)
    expect(n.unstable).toBe(false)
  })

  it('splits an OpenRouter routing variant (:free) from the model', () => {
    const n = normalizeModelId('openrouter', 'z-ai/glm-5.2:free')
    expect(n.version).toEqual([5, 2])
    expect([...n.routing]).toEqual(['free'])
  })

  it('keeps a variant tag (kimi-k2.7-code) and a letter-prefixed version (k2.7)', () => {
    const n = normalizeModelId('openrouter', 'moonshotai/kimi-k2.7-code')
    expect(n.family).toEqual(['kimi', 'k'])
    expect(n.version).toEqual([2, 7])
    expect([...n.tags]).toEqual(['code'])
  })

  it('reads a trailing MMDD token as a snapshot (deepseek-v4-flash-0731)', () => {
    const n = normalizeModelId('openrouter', 'deepseek/deepseek-v4-flash-0731')
    expect(n.version).toEqual([4])
    expect([...n.tags]).toEqual(['flash'])
    expect(n.snapshot).toBe('0731')
  })

  it('marks preview/exp/latest rows unstable and ~ rows as aliases', () => {
    expect(normalizeModelId('openrouter', 'google/gemini-3-flash-preview').unstable).toBe(true)
    expect(normalizeModelId('openrouter', 'deepseek/deepseek-v3.2-exp').unstable).toBe(true)
    expect(normalizeModelId('openrouter', '~z-ai/glm-latest').alias).toBe(true)
  })

  it('Anthropic dot-vs-dash: openrouter anthropic/claude-sonnet-4.6 ≡ direct claude-sonnet-4-6', () => {
    const viaOr = normalizeModelId('openrouter', 'anthropic/claude-sonnet-4.6')
    const direct = normalizeModelId('anthropic', 'claude-sonnet-4-6')
    expect(viaOr.version).toEqual([4, 6])
    expect(direct.version).toEqual([4, 6])
    expect(direct.family).toEqual(['claude', 'sonnet'])
    expect(modelIdentityKey(viaOr)).toBe(modelIdentityKey(direct))
  })

  it('reads an Anthropic pinned snapshot id (claude-haiku-4-5-20251001)', () => {
    const n = normalizeModelId('anthropic', 'claude-haiku-4-5-20251001')
    expect(n.version).toEqual([4, 5])
    expect(n.snapshot).toBe('2025-10-01')
  })

  it('treats ollama :tags as size/quant tags, not routing', () => {
    const n = normalizeModelId('ollama', 'qwen3:30b')
    expect(n.vendor).toBe('ollama')
    expect(n.family).toEqual(['qwen'])
    expect(n.version).toEqual([3])
    expect([...n.tags]).toEqual(['30b'])
    expect(n.routing.size).toBe(0)
  })

  it('parses gpt-4o as version 4 with tag o, and gpt-5-2025-08-07 as a dated snapshot', () => {
    const a = normalizeModelId('openrouter', 'openai/gpt-4o')
    expect(a.version).toEqual([4])
    expect([...a.tags]).toEqual(['o'])
    const b = normalizeModelId('openrouter', 'openai/gpt-5-2025-08-07')
    expect(b.version).toEqual([5])
    expect(b.snapshot).toBe('2025-08-07')
  })
})

describe('findSuccessor — worked cases (live OpenRouter list)', () => {
  it('z-ai/glm-5.2 → z-ai/glm-5.3 (version), flash variants are near misses only', () => {
    const r = or('z-ai/glm-5.2')
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('z-ai/glm-5.3')
    expect(r.successor?.pricing).toEqual(p(0.00000091, 0.00000286))
    expect(r.nearMisses).toContain('z-ai/glm-5.3-flash')
    expect(r.nearMisses).not.toContain('z-ai/glm-5.3')
  })

  it('moonshotai/kimi-k2.7 → moonshotai/kimi-k3', () => {
    const r = or('moonshotai/kimi-k2.7')
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('moonshotai/kimi-k3')
  })

  it('deepseek/deepseek-v4-flash → deepseek/deepseek-v4.1-flash (version beats the 0731 snapshot)', () => {
    const r = or('deepseek/deepseek-v4-flash')
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('anthropic/claude-sonnet-4.5 → anthropic/claude-sonnet-5', () => {
    expect(or('anthropic/claude-sonnet-4.5').successor?.model).toBe('anthropic/claude-sonnet-5')
  })

  it('anthropic/claude-opus-4.6 → anthropic/claude-opus-5', () => {
    expect(or('anthropic/claude-opus-4.6').successor?.model).toBe('anthropic/claude-opus-5')
  })

  it('google/gemini-2.5-flash → google/gemini-3.8-flash (highest version; -lite is a near miss)', () => {
    const r = or('google/gemini-2.5-flash')
    expect(r.successor?.model).toBe('google/gemini-3.8-flash')
    expect(r.nearMisses).toContain('google/gemini-3.5-flash-lite')
  })

  it('openai/gpt-4.1 → openai/gpt-5.5 (gpt-6-astra has a tag → near miss)', () => {
    const r = or('openai/gpt-4.1')
    expect(r.successor?.model).toBe('openai/gpt-5.5')
    expect(r.nearMisses).toContain('openai/gpt-6-astra')
  })

  it('openai/gpt-4o → dated snapshot openai/gpt-4o-2024-11-20 (kind snapshot)', () => {
    const r = or('openai/gpt-4o')
    expect(r.kind).toBe('snapshot')
    expect(r.successor?.model).toBe('openai/gpt-4o-2024-11-20')
  })

  it('qwen/qwen3-235b-a22b → qwen/qwen3-235b-a22b-2507 (snapshot; size tags must match)', () => {
    const r = or('qwen/qwen3-235b-a22b')
    expect(r.kind).toBe('snapshot')
    expect(r.successor?.model).toBe('qwen/qwen3-235b-a22b-2507')
  })

  it('deepseek/deepseek-v3.2 → nothing (the v4 rows all carry flash/pro tags)', () => {
    const r = or('deepseek/deepseek-v3.2')
    expect(r.kind).toBeNull()
    expect(r.successor).toBeUndefined()
    expect(r.nearMisses).toContain('deepseek/deepseek-v4-flash-0731')
  })
})

describe('findSuccessor — adversarial cases', () => {
  it('kimi-k2.7-code must NOT become kimi-k3 (strict tag equality)', () => {
    const r = or('moonshotai/kimi-k2.7-code')
    expect(r.successor).toBeUndefined()
    expect(r.kind).toBeNull()
    expect(r.nearMisses).toEqual(['moonshotai/kimi-k3'])
  })

  it(':free must not become paid', () => {
    const r = or('z-ai/glm-5.2:free')
    expect(r.successor).toBeUndefined()
  })

  it('bare deepseek-v4-flash orders by canonical date: 0731 is the snapshot successor, never the reverse', () => {
    const noV41 = OR.filter((m) => m.id !== 'deepseek/deepseek-v4.1-flash')
    const r = or('deepseek/deepseek-v4-flash', noV41)
    expect(r.kind).toBe('snapshot')
    expect(r.successor?.model).toBe('deepseek/deepseek-v4-flash-0731')
    // and the dated row itself has no older "successor"
    expect(or('deepseek/deepseek-v4-flash-0731', noV41).successor).toBeUndefined()
  })

  it('-preview / -exp / ~latest rows are never successors', () => {
    const noStable = OR.filter((m) => !['google/gemini-3.8-flash', 'google/gemini-3.5-flash-lite'].includes(m.id))
    expect(or('google/gemini-2.5-flash', noStable).successor).toBeUndefined() // gemini-3-flash-preview skipped
    expect(or('z-ai/glm-5.3').successor).toBeUndefined() // ~z-ai/glm-latest skipped
    const r = or('deepseek/deepseek-v3.2', OR.filter((m) => m.id !== 'deepseek/deepseek-v3.2'))
    expect(r.successor).toBeUndefined() // -exp skipped
  })

  it('a row whose expiration_date has passed is never a successor', () => {
    const live: LiveModel[] = [
      { id: 'z-ai/glm-5.2', canonical: 'z-ai/glm-5.2-20260616', created: 1 },
      { id: 'z-ai/glm-5.3', canonical: 'z-ai/glm-5.3-20260816', created: 2, expiration: '2026-01-01' },
    ]
    expect(or('z-ai/glm-5.2', live).successor).toBeUndefined()
  })

  it('the newest model has no successor (kimi-k3, deepseek-r1)', () => {
    expect(or('moonshotai/kimi-k3').successor).toBeUndefined()
    expect(or('deepseek/deepseek-r1').successor).toBeUndefined()
  })
})

describe('findSuccessor — direct Anthropic list', () => {
  const ANTHROPIC: LiveModel[] = [
    { id: 'claude-sonnet-4-7', created: 1790000000 },
    { id: 'claude-sonnet-4-6', created: 1771000000 },
    { id: 'claude-opus-4-8', created: 1780000000 },
    { id: 'claude-haiku-4-5-20251101', created: 1762000000 },
    { id: 'claude-haiku-4-5-20251001', created: 1759000000 },
  ]
  const direct = (model: string) => findSuccessor({ provider: 'anthropic', model }, ANTHROPIC, TODAY)

  it('claude-sonnet-4-6 → claude-sonnet-4-7 (dash-encoded version bump)', () => {
    const r = direct('claude-sonnet-4-6')
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('claude-sonnet-4-7')
  })

  it('a pinned snapshot id bumps to the newer snapshot of the same version', () => {
    const r = direct('claude-haiku-4-5-20251001')
    expect(r.kind).toBe('snapshot')
    expect(r.successor?.model).toBe('claude-haiku-4-5-20251101')
  })

  it('opus is never a successor to sonnet', () => {
    expect(direct('claude-sonnet-4-6').nearMisses).not.toContain('claude-opus-4-8')
  })
})

describe('priceRatio', () => {
  it('is the larger of the prompt/completion ratios', () => {
    expect(priceRatio(p(1, 2), p(1.5, 5))).toBe(2.5)
  })
  it('is undefined when either side has no pricing', () => {
    expect(priceRatio(null, p(1, 1))).toBeUndefined()
    expect(priceRatio(p(1, 1), undefined)).toBeUndefined()
  })
  it('free → paid is Infinity; free → free is 1', () => {
    expect(priceRatio(p(0, 0), p(1, 1))).toBe(Infinity)
    expect(priceRatio(p(0, 0), p(0, 0))).toBe(1)
  })
})

// --- Audit: release-date ordering ------------------------------------------
//
// Version numbers alone are not a timeline. Live OpenRouter (2026-09-22) has
// x-ai/grok-4.20 (released 2026-03-09) beside x-ai/grok-4.7 (2026-09-16):
// [4,20] > [4,7] numerically, but 4.20 is the OLDER model. And snapshot keys
// used to mix YYYYMMDD, raw MMDD tokens and epoch strings, so a bare id could
// be reported as the "newer snapshot" of a dated retrain.
describe('findSuccessor — release-date ordering (audit)', () => {
  const GROK: LiveModel[] = [
    { id: 'x-ai/grok-4.7', canonical: 'x-ai/grok-4.7-20260916', created: 1789948800, pricing: p(0.000003, 0.000015) },
    { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200, pricing: p(0.00000234, 0.0000117) },
    { id: 'x-ai/grok-4.5', canonical: 'x-ai/grok-4.5-20260601', created: 1780000000, pricing: p(0.000003, 0.000015) },
  ]

  it('a higher version number with an OLDER release date is never a successor (grok-4.7 ↛ grok-4.20)', () => {
    const r = or('x-ai/grok-4.7', GROK)
    expect(r.successor).toBeUndefined()
    expect(r.kind).toBeNull()
  })

  it('drops the older-dated bump and picks the highest of the rest (grok-4.5 → grok-4.7, never 4.20)', () => {
    const r = or('x-ai/grok-4.5', GROK)
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('x-ai/grok-4.7')
  })

  it('a bare id created before a dated retrain is not its newer snapshot (deepseek-r1-0528 ↛ deepseek-r1)', () => {
    const R1: LiveModel[] = [
      { id: 'deepseek/deepseek-r1-0528', canonical: 'deepseek/deepseek-r1-0528', created: 1748390400 },
      { id: 'deepseek/deepseek-r1', canonical: 'deepseek/deepseek-r1', created: 1737331200 },
    ]
    expect(or('deepseek/deepseek-r1-0528', R1).successor).toBeUndefined()
    // The real direction still resolves, through `created` when the id token is a bare MMDD.
    const fwd = or('deepseek/deepseek-r1', R1)
    expect(fwd.kind).toBe('snapshot')
    expect(fwd.successor?.model).toBe('deepseek/deepseek-r1-0528')
  })
})

// --- Re-audit: newest release wins, and the date guard cannot go inert ------
//
// Sorting version bumps by version number first let the grok-4.20 trap back
// in for any row older than BOTH 4.20 and 4.7: grok-4.1 resolved to 4.20 and
// was then stuck there (4.7 is a lower tuple). And when the current id was
// not in the live list at all — retired by absence, or a case mismatch — the
// "older than current" guard had no date to compare against and switched
// itself off.
describe('findSuccessor — newest release wins (re-audit)', () => {
  const GROK: LiveModel[] = [
    { id: 'x-ai/grok-4.7', canonical: 'x-ai/grok-4.7-20260916', created: 1789948800, pricing: p(0.000003, 0.000015) },
    { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200, pricing: p(0.00000234, 0.0000117) },
    { id: 'x-ai/grok-4.1', canonical: 'x-ai/grok-4.1-20251117', created: 1763337600, pricing: p(0.000003, 0.000015) },
    { id: 'x-ai/grok-4', canonical: 'x-ai/grok-4-20250709', created: 1752019200, pricing: p(0.000003, 0.000015) },
  ]

  it('grok-4.1 → grok-4.7 (newest release), never the numerically higher but older grok-4.20', () => {
    const r = or('x-ai/grok-4.1', GROK)
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('x-ai/grok-4.7')
  })

  it('grok-4 → grok-4.7', () => {
    expect(or('x-ai/grok-4', GROK).successor?.model).toBe('x-ai/grok-4.7')
  })

  it('a newer-dated LOWER tuple is at least a near miss (grok-4.20 shows grok-4.7)', () => {
    const r = or('x-ai/grok-4.20', GROK)
    expect(r.successor).toBeUndefined()
    expect(r.nearMisses).toContain('x-ai/grok-4.7')
  })

  it('current id absent from the live list: the newest release still wins (grok-4.7 gone → grok-4.9, not 4.20)', () => {
    const live: LiveModel[] = [
      { id: 'x-ai/grok-4.20', canonical: 'x-ai/grok-4.20-20260309', created: 1774915200 },
      { id: 'x-ai/grok-4.9', canonical: 'x-ai/grok-4.9-20260920', created: 1790294400 },
    ]
    const r = or('x-ai/grok-4.7', live)
    expect(r.kind).toBe('version')
    expect(r.successor?.model).toBe('x-ai/grok-4.9')
  })

  it('an absent current id with a date in the id keeps the guard: gpt-5-2026-01-01 ↛ older gpt-5.1-2025-06-01', () => {
    const live: LiveModel[] = [{ id: 'openai/gpt-5.1-2025-06-01', canonical: 'openai/gpt-5.1-2025-06-01', created: 1748736000 }]
    const r = or('openai/gpt-5-2026-01-01', live)
    expect(r.successor).toBeUndefined()
    expect(r.nearMisses).toContain('openai/gpt-5.1-2025-06-01')
  })

  it('finds its own row case-insensitively so the date guard stays active ("X-AI/grok-4.7 " ↛ grok-4.20)', () => {
    const r = or('X-AI/grok-4.7 ', GROK)
    expect(r.successor).toBeUndefined()
    expect(r.nearMisses).toContain('x-ai/grok-4.20')
  })
})
