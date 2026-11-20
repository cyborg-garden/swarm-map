import { describe, it, expect } from 'vitest'
import { lookupPricing, computeCost } from '@/lib/pricing'

describe('lookupPricing', () => {
  it('returns pricing for claude-sonnet-4', () => {
    const p = lookupPricing('claude-sonnet-4')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(3.0)
    expect(p!.outputPerMillion).toBe(15.0)
    expect(p!.cacheReadPerMillion).toBe(0.3)
    expect(p!.cacheWritePerMillion).toBe(3.75)
  })

  it('returns pricing for a dated claude-sonnet-4 variant', () => {
    const p = lookupPricing('claude-sonnet-4-5-20250929')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(3.0)
  })

  it('returns pricing for claude-opus-4-6', () => {
    const p = lookupPricing('claude-opus-4-6')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(5.0)
    expect(p!.outputPerMillion).toBe(25.0)
  })

  it('returns pricing for gemini-2.5-flash', () => {
    const p = lookupPricing('gemini-2.5-flash')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.15)
    expect(p!.outputPerMillion).toBe(0.6)
  })

  it('strips bedrock/ prefix', () => {
    const p = lookupPricing('bedrock/anthropic.claude-sonnet-4-6')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(3.0)
  })

  it('returns null for unknown models', () => {
    expect(lookupPricing('some-custom-model')).toBeNull()
  })

  it('returns pricing for gpt-4o-mini', () => {
    const p = lookupPricing('gpt-4o-mini')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.15)
    expect(p!.outputPerMillion).toBe(0.6)
  })

  it('returns pricing for gpt-4o (not mini)', () => {
    const p = lookupPricing('gpt-4o')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(2.5)
  })

  it('returns pricing for deepseek-chat', () => {
    const p = lookupPricing('deepseek-chat')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.14)
  })

  it('returns pricing for deepseek-reasoner', () => {
    const p = lookupPricing('deepseek-reasoner')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.55)
    expect(p!.outputPerMillion).toBe(2.19)
  })

  it('returns pricing for claude-haiku-4-5', () => {
    const p = lookupPricing('claude-haiku-4-5')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(1.0)
    expect(p!.outputPerMillion).toBe(5.0)
  })
})

describe('lookupPricing — GLM / Kimi / DeepSeek routing tiers', () => {
  // The GLM-primary fleet flip: every tier of the hierarchy must resolve to a
  // non-null entry (cost_status "estimated", not "unknown") under both the bare
  // model name and the provider-prefixed OpenRouter slug state.db may record.

  it('resolves glm-5.2 (bare and z-ai/ prefixed) to Z.ai list price', () => {
    for (const id of ['glm-5.2', 'z-ai/glm-5.2']) {
      const p = lookupPricing(id)
      expect(p, id).not.toBeNull()
      expect(p!.inputPerMillion).toBe(1.4)
      expect(p!.outputPerMillion).toBe(4.4)
    }
  })

  it('resolves glm-4.6 to Z.ai list price', () => {
    const p = lookupPricing('glm-4.6')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.6)
    expect(p!.outputPerMillion).toBe(2.2)
  })

  it('resolves glm-4.5-flash to a real $0 entry (free tier, not unknown)', () => {
    const p = lookupPricing('glm-4.5-flash')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0)
    expect(p!.outputPerMillion).toBe(0)
    expect(computeCost({ input: 1_000_000, output: 1_000_000 }, p!)).toBe(0)
  })

  it('resolves kimi-k3 (bare and moonshotai/ prefixed) with cache-hit pricing', () => {
    for (const id of ['kimi-k3', 'moonshotai/kimi-k3']) {
      const p = lookupPricing(id)
      expect(p, id).not.toBeNull()
      expect(p!.inputPerMillion).toBe(3.0)
      expect(p!.outputPerMillion).toBe(15.0)
      expect(p!.cacheReadPerMillion).toBe(0.3)
    }
  })

  it('resolves kimi-k2.7-code (bare and moonshotai/ prefixed)', () => {
    for (const id of ['kimi-k2.7-code', 'moonshotai/kimi-k2.7-code']) {
      const p = lookupPricing(id)
      expect(p, id).not.toBeNull()
      expect(p!.inputPerMillion).toBe(0.72)
      expect(p!.outputPerMillion).toBe(3.49)
    }
  })

  it('resolves deepseek-v3.2 (bare and deepseek/ prefixed) ahead of the legacy wildcard', () => {
    for (const id of ['deepseek-v3.2', 'deepseek/deepseek-v3.2']) {
      const p = lookupPricing(id)
      expect(p, id).not.toBeNull()
      expect(p!.inputPerMillion).toBe(0.23)
      expect(p!.outputPerMillion).toBe(0.34)
    }
  })

  it('resolves deepseek-v4-flash (bare and deepseek/ prefixed) ahead of the legacy wildcard', () => {
    // openrouter/deepseek/… covers double-prefixed names as recorded by some
    // gateways — must still resolve the versioned entry (cache-read rate), not
    // the legacy wildcard.
    for (const id of ['deepseek-v4-flash', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-0731', 'openrouter/deepseek/deepseek-v4-flash-0731']) {
      const p = lookupPricing(id)
      expect(p, id).not.toBeNull()
      expect(p!.inputPerMillion).toBe(0.14)
      expect(p!.outputPerMillion).toBe(0.28)
      expect(p!.cacheReadPerMillion).toBe(0.0028)
    }
  })

  it('keeps legacy deepseek models on the old wildcard rates', () => {
    const p = lookupPricing('deepseek-chat')
    expect(p).not.toBeNull()
    expect(p!.inputPerMillion).toBe(0.14)
    expect(p!.outputPerMillion).toBe(0.28)
  })
})

describe('computeCost', () => {
  it('computes basic input/output cost', () => {
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      { input: 1_000_000, output: 100_000 },
      pricing,
    )
    // $3 for 1M input + $1.50 for 100K output = $4.50
    expect(cost).toBeCloseTo(4.5, 2)
  })

  it('includes cache read savings', () => {
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      { input: 500_000, output: 100_000, cacheRead: 500_000 },
      pricing,
    )
    // $1.50 for 500K input + $1.50 for 100K output + $0.15 for 500K cache read = $3.15
    expect(cost).toBeCloseTo(3.15, 2)
  })

  it('includes cache write cost', () => {
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      { input: 1_000_000, output: 0, cacheWrite: 1_000_000 },
      pricing,
    )
    // $3 for input + $3.75 for cache write = $6.75
    expect(cost).toBeCloseTo(6.75, 2)
  })

  it('charges reasoning at output rate', () => {
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      { input: 0, output: 0, reasoning: 1_000_000 },
      pricing,
    )
    // $15 for 1M reasoning tokens at output rate
    expect(cost).toBeCloseTo(15.0, 2)
  })

  it('returns 0 for zero tokens', () => {
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      { input: 0, output: 0 },
      pricing,
    )
    expect(cost).toBe(0)
  })

  it('computes a realistic seraph-alpha-like cost', () => {
    // Real data: ~38M input, ~488K output, ~35M cache read, ~2M cache write for claude-sonnet-4
    const pricing = lookupPricing('claude-sonnet-4')!
    const cost = computeCost(
      {
        input: 38_808_924,
        output: 488_072,
        cacheRead: 35_796_133,
        cacheWrite: 1_990_994,
      },
      pricing,
    )
    // Should be a non-trivial amount
    expect(cost).toBeGreaterThan(100)
    expect(cost).toBeLessThan(500)
  })
})
