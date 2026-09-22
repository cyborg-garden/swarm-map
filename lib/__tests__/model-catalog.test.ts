// @vitest-environment node
//
// validateCascadeEntries guards the PUT /harnesses/:id/models write path. It
// rejects a cascade entry ONLY when it can POSITIVELY determine the entry is
// bad: an empty model id, or a provider that is DEFINITIVELY un-serviceable for
// this agent (needs a key, we know which env var, and it's absent). Everything
// uncertain FAILS OPEN — a valid config must never be blocked.
import { describe, it, expect } from 'vitest'
import { validateCascadeEntries, MODEL_CATALOG, ENV_TO_PROVIDER } from '../model-catalog'

describe('validateCascadeEntries', () => {
  // --- Empty-id guard (always rejects, regardless of credentials) ----------

  it('rejects an empty model id', () => {
    const errors = validateCascadeEntries([{ provider: 'anthropic', model: '' }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/missing model/i)
  })

  it('still rejects an empty model id for a no-key provider', () => {
    const errors = validateCascadeEntries([{ provider: 'ollama', model: '' }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/missing model/i)
  })

  // --- Provider WITH a configured key → passes -----------------------------

  it('accepts a model whose provider has a configured key', () => {
    const env = new Set(['ANTHROPIC_API_KEY'])
    const errors = validateCascadeEntries(
      [{ provider: 'anthropic', model: 'claude-opus-4-8' }], // NOT in catalog — must still pass
      env
    )
    expect(errors).toEqual([])
  })

  it('accepts anthropic when the key lives in ANTHROPIC_TOKEN (bearer format)', () => {
    const env = new Set(['ANTHROPIC_TOKEN'])
    const errors = validateCascadeEntries([{ provider: 'anthropic', model: 'claude-opus-4-8' }], env)
    expect(errors).toEqual([])
  })

  it('fails open when no env vars were read at all (missing/unreadable .env)', () => {
    // Empty set = we couldn't read the agent's .env. Must NOT reject an
    // enforced-provider model on credential grounds — only the empty-id guard applies.
    const errors = validateCascadeEntries(
      [{ provider: 'anthropic', model: 'claude-opus-4-8' }],
      new Set()
    )
    expect(errors).toEqual([])
  })

  it('still rejects an empty model id even when env is empty (floor guard holds)', () => {
    const errors = validateCascadeEntries([{ provider: 'anthropic', model: '' }], new Set())
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/missing model/i)
  })

  it('accepts a multi-entry cascade when every provider has its key', () => {
    const env = new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'])
    const errors = validateCascadeEntries(
      [
        { provider: 'anthropic', model: 'claude-opus-4-8' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
      ],
      env
    )
    expect(errors).toEqual([])
  })

  // --- Provider that NEEDS a key but the agent has NONE → 400 --------------

  it('rejects a model whose provider needs a key the agent lacks (the crash case)', () => {
    const env = new Set(['ANTHROPIC_API_KEY']) // no OPENROUTER_API_KEY
    const errors = validateCascadeEntries(
      [{ provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' }],
      env
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('moonshotai/kimi-k2.7-code')
    expect(errors[0]).toContain('openrouter')
    expect(errors[0]).toContain('OPENROUTER_API_KEY')
  })

  it('reports every un-serviceable entry, not just the first', () => {
    // Non-empty env (so the credential check is active) that simply lacks the
    // openrouter + openai keys — both entries are definitively un-serviceable.
    const env = new Set(['ANTHROPIC_API_KEY'])
    const errors = validateCascadeEntries(
      [
        { provider: 'openrouter', model: 'or-model' },
        { provider: 'openai', model: 'gpt-x' },
      ],
      env
    )
    expect(errors).toHaveLength(2)
    expect(errors.join(' ')).toContain('or-model')
    expect(errors.join(' ')).toContain('gpt-x')
  })

  // --- No-key providers → always pass --------------------------------------

  it('accepts ollama with no key configured (local, base_url)', () => {
    const errors = validateCascadeEntries(
      [{ provider: 'ollama', model: 'my-local-build:latest' }],
      new Set()
    )
    expect(errors).toEqual([])
  })

  it('accepts custom (proxy) with no key configured', () => {
    const errors = validateCascadeEntries(
      [{ provider: 'custom', model: 'whatever-proxy-model' }],
      new Set()
    )
    expect(errors).toEqual([])
  })

  // --- Fail-open on uncertainty --------------------------------------------

  it('accepts an unknown / uncertain provider even with no key (fail open)', () => {
    const errors = validateCascadeEntries([{ provider: 'nous', model: 'Hermes-4-405B' }], new Set())
    expect(errors).toEqual([])
  })

  it('accepts google/gemini with no single key (ambiguous auth → fail open)', () => {
    // Google has multiple auth modes (API key, Vertex/ADC, service account), so
    // a missing GOOGLE_API_KEY is NOT proof it's un-serviceable.
    expect(validateCascadeEntries([{ provider: 'google', model: 'gemini-3-pro' }], new Set())).toEqual([])
    expect(validateCascadeEntries([{ provider: 'gemini', model: 'gemini-3-pro' }], new Set())).toEqual([])
  })

  it('accepts bedrock even with no AWS creds in the .env (creds may be an instance role → fail open)', () => {
    const errors = validateCascadeEntries(
      [{ provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6-20250527-v1:0' }],
      new Set()
    )
    expect(errors).toEqual([])
  })

  it('accepts an entry with no provider (legacy / unknown → fail open)', () => {
    const errors = validateCascadeEntries([{ provider: '', model: 'anything-goes' }], new Set())
    expect(errors).toEqual([])
  })

  it('fails open entirely when no env-var set is supplied (only the empty-id guard applies)', () => {
    // Default presentEnvVars = empty set, but callers that pass nothing get
    // credential validation effectively disabled (everything fails open) EXCEPT
    // providers we can prove need a key — which, with an empty set, would reject.
    // Verify a no-key provider and an uncertain provider still pass.
    expect(validateCascadeEntries([{ provider: 'ollama', model: 'x' }])).toEqual([])
    expect(validateCascadeEntries([{ provider: 'nous', model: 'x' }])).toEqual([])
  })

  // --- zai (GLM) provider — Z.ai cloud, key-authenticated -------------------

  it('accepts a zai/GLM model when GLM_API_KEY is configured', () => {
    const errors = validateCascadeEntries([{ provider: 'zai', model: 'glm-5.2' }], new Set(['GLM_API_KEY']))
    expect(errors).toEqual([])
  })

  it('accepts a zai/GLM model when an alternate ZAI_API_KEY is configured', () => {
    const errors = validateCascadeEntries([{ provider: 'zai', model: 'glm-5.2' }], new Set(['ZAI_API_KEY']))
    expect(errors).toEqual([])
  })

  it('rejects a zai/GLM model when the agent has no GLM key (the crash case)', () => {
    const errors = validateCascadeEntries([{ provider: 'zai', model: 'glm-5.2' }], new Set(['ANTHROPIC_API_KEY']))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('glm-5.2')
    expect(errors[0]).toContain('zai')
    expect(errors[0]).toContain('GLM_API_KEY')
  })
})

describe('validateCascadeEntries — YAML-safe plain scalars', () => {
  // provider/model are written UNQUOTED into config.yaml by line splicing. A
  // value that is not a safe YAML plain scalar can inject top-level keys
  // (newline) or break the mapping (": ", " #", trailing ":", leading indicator).
  const env = new Set(['ANTHROPIC_API_KEY'])

  it('rejects a model id containing a newline (config.yaml key injection)', () => {
    const errors = validateCascadeEntries(
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6\nmodel: injected\ntoolsets: [oops]' }],
      env
    )
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/config\.yaml/)
  })

  it('rejects a provider containing a newline or carriage return', () => {
    expect(validateCascadeEntries([{ provider: 'anthropic\nfoo: bar', model: 'x' }], env)).toHaveLength(1)
    expect(validateCascadeEntries([{ provider: 'anthropic\rfoo', model: 'x' }], env)).toHaveLength(1)
  })

  it('rejects a model id containing ": " or " #" (breaks the plain scalar)', () => {
    expect(validateCascadeEntries([{ provider: 'anthropic', model: 'foo: bar' }], env)).toHaveLength(1)
    expect(validateCascadeEntries([{ provider: 'anthropic', model: 'foo #bar' }], env)).toHaveLength(1)
  })

  it('rejects a model id ending in ":" or starting with a YAML indicator', () => {
    for (const model of ['foo:', '@cf/meta/llama', '- x', '[a]', '{a}', '"quoted"', "'q'", '&anchor', '*alias', '!tag', '|', '>', '%x', '`x', '#x', '?x', ',x']) {
      expect(validateCascadeEntries([{ provider: 'anthropic', model }], env), model).toHaveLength(1)
    }
  })

  it('accepts real-world ids with inner colons, slashes and dots', () => {
    for (const model of ['qwen3:30b', 'us.anthropic.claude-sonnet-4-6-20250527-v1:0', 'anthropic/claude-fable-5', 'glm-4.5-flash', 'moonshotai/kimi-k2.7-code']) {
      expect(validateCascadeEntries([{ provider: 'anthropic', model }], env), model).toEqual([])
    }
  })
})

describe('MODEL_CATALOG — GLM / open-model lane', () => {
  it('exposes GLM-5.2 under a first-class zai provider', () => {
    const zai = MODEL_CATALOG.zai
    expect(zai, 'zai provider should be registered in the catalog').toBeDefined()
    expect(zai.map((m) => m.id)).toContain('glm-5.2')
  })

  it('offers a genuinely-local GLM via the existing ollama provider (glm4:9b)', () => {
    const ids = MODEL_CATALOG.ollama.map((m) => m.id)
    expect(ids).toContain('glm4:9b')
    const local = MODEL_CATALOG.ollama.find((m) => m.id === 'glm4:9b')
    expect(local?.tier).toBe('local')
  })

  it('maps the GLM key env vars to the zai provider for /suggest detection', () => {
    expect(ENV_TO_PROVIDER.GLM_API_KEY).toBe('zai')
    expect(ENV_TO_PROVIDER.ZAI_API_KEY).toBe('zai')
  })
})

describe('MODEL_CATALOG — Anthropic freshness', () => {
  it('exposes the current top-end Anthropic models (Fable 5, Opus 4.8)', () => {
    const ids = MODEL_CATALOG.anthropic.map((m) => m.id)
    expect(ids).toContain('claude-fable-5')
    expect(ids).toContain('claude-opus-4-8')
    // and does not regress the workhorse tiers
    expect(ids).toContain('claude-sonnet-4-6')
    expect(ids).toContain('claude-haiku-4-5-20251001')
  })

  it('mirrors the top-end models on openrouter', () => {
    const ids = MODEL_CATALOG.openrouter.map((m) => m.id)
    expect(ids).toContain('anthropic/claude-fable-5')
    expect(ids).toContain('anthropic/claude-opus-4-8')
  })
})

describe('MODEL_CATALOG — OpenRouter cheap metered workhorse lane', () => {
  // The cost motivation ([intelligent-routing-cost], token-spend audit): every
  // fleet agent primaries on metered Claude with NO cheap-metered rung in any
  // cascade — so when Claude credits run dry the only fallback is a local model.
  // The catalog must OFFER a genuinely-cheap OpenRouter workhorse so operators
  // can build a metered cheap rung above the local floor.
  it('offers a cheap metered workhorse via openrouter (not only premium mirrors)', () => {
    const cheap = MODEL_CATALOG.openrouter.filter((m) => m.tier === 'fallback')
    // At least one fallback-tier entry that is NOT a premium Anthropic mirror.
    const nonPremium = cheap.filter((m) => !m.id.startsWith('anthropic/'))
    expect(nonPremium.length).toBeGreaterThan(0)
  })

  it('exposes Kimi K2.7 (confirmed-live cheap agentic model) as a fallback rung', () => {
    const kimi = MODEL_CATALOG.openrouter.find((m) => m.id === 'moonshotai/kimi-k2.7-code')
    expect(kimi, 'kimi cheap workhorse should be in the openrouter catalog').toBeDefined()
    expect(kimi?.tier).toBe('fallback')
  })

  it('keeps Fable/Opus as primary tier (never auto-fallback targets)', () => {
    for (const id of ['claude-fable-5', 'claude-opus-4-8']) {
      expect(MODEL_CATALOG.anthropic.find((m) => m.id === id)?.tier).toBe('primary')
    }
  })

  it('exposes DeepSeek V3.2 as the cheap routing tier ([intelligent-routing-cost])', () => {
    // The intelligent-routing plugin in the agent image routes cheap traffic to
    // DeepSeek V3.2 — the catalog must offer the slug so operators can pin it.
    const ds = MODEL_CATALOG.openrouter.find((m) => m.id === 'deepseek/deepseek-v3.2')
    expect(ds, 'deepseek v3.2 cheap routing tier should be in the openrouter catalog').toBeDefined()
    expect(ds?.tier).toBe('fallback')
  })

  it('exposes DeepSeek V4 Flash 0731 as the successor cheap routing tier (D-2026-08-06)', () => {
    // V4 Flash 0731 supersedes V3.2 for the cheap down-route slot; V3.2 stays
    // listed while live agent cascades still reference it. The bare
    // deepseek/deepseek-v4-flash slug resolves to the weak 0423 preview on
    // OpenRouter and must NOT be the catalog entry.
    const ds = MODEL_CATALOG.openrouter.find((m) => m.id === 'deepseek/deepseek-v4-flash-0731')
    expect(ds, 'deepseek v4 flash 0731 should be in the openrouter catalog').toBeDefined()
    expect(ds?.tier).toBe('fallback')
    const bare = MODEL_CATALOG.openrouter.find((m) => m.id === 'deepseek/deepseek-v4-flash')
    expect(bare, 'bare v4-flash slug (0423 preview) must not be offered').toBeUndefined()
  })
})

describe('MODEL_CATALOG — GLM-primary fleet hierarchy on OpenRouter', () => {
  // The fleet flip: GLM-5.2 (via OpenRouter) becomes chat primary, Kimi K3 is
  // the on-demand premium tier, DeepSeek V3.2 the cheap routing tier (above).
  it('exposes GLM-5.2 as a primary-capable openrouter entry (fleet chat primary)', () => {
    const glm = MODEL_CATALOG.openrouter.find((m) => m.id === 'z-ai/glm-5.2')
    expect(glm, 'z-ai/glm-5.2 should be in the openrouter catalog').toBeDefined()
    expect(glm?.tier).toBe('primary')
  })

  it('exposes Kimi K3 as the premium on-demand tier (primary-capable, not a fallback rung)', () => {
    const kimi = MODEL_CATALOG.openrouter.find((m) => m.id === 'moonshotai/kimi-k3')
    expect(kimi, 'moonshotai/kimi-k3 should be in the openrouter catalog').toBeDefined()
    expect(kimi?.tier).toBe('primary')
  })

  it('keeps the direct Z.ai lane for GLM-5.2 alongside the OpenRouter entry', () => {
    expect(MODEL_CATALOG.zai.map((m) => m.id)).toContain('glm-5.2')
  })
})
