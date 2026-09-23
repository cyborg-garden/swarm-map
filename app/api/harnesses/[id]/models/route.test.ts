// @vitest-environment node
/**
 * Tests for PUT /api/harnesses/:id/models.
 *
 * The PUT route writes the model cascade into the agent's config.yaml and the
 * agent restarts onto it. The guard rejects (a) an empty model id, and (b) a
 * model whose provider has NO configured credential for this agent — which would
 * crash-loop the agent on restart. It validates provider-credential PRESENCE
 * (read from the agent's .env), NOT catalog membership, and fails open on any
 * uncertainty so a valid config is never blocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'

vi.mock('@/lib/services', () => ({
  services: {
    harness: {
      get: vi.fn(() => ({ id: 'h_test', name: 'test', serviceName: 'hermes-test' })),
      updateConfig: vi.fn(),
    },
  },
}))

// readAgentEnvVarNames returns the provider keys configured for this agent.
// Default fixture: the agent has an Anthropic key only. Individual tests
// override it to exercise the credential-presence guard.
const mockEnvVars = vi.fn(() => new Set<string>(['ANTHROPIC_API_KEY']))
// What the agent's config.yaml currently holds under fallback_providers.
// Default: nothing. Legacy-body tests override it to prove rows are preserved.
const mockExistingFp = vi.fn((): Array<{ provider: string; model: string; base_url?: string }> => [])
const mockModelProvider = vi.fn(() => '')
// The primary as readCascade reports it (model.provider / model.default).
// Default: none — a chain is then the rows alone.
const mockPrimary = vi.fn((): { provider: string; model: string; base_url?: string } | null => null)

vi.mock('@/lib/services/harness', async (importOriginal) => {
  // The writer shares the readers' header regexes and scalar helpers; use
  // the real ones so the route test exercises the same header forms the
  // readers accept.
  const { FALLBACK_PROVIDERS_HEADER, MODEL_HEADER, FLOW_MAP, FLOW_SEQ, isTopLevelLine, yamlScalar, parseFlowPairs, parseFlowMaps, cascadeChain, sameCascadeRow } =
    await importOriginal<typeof import('@/lib/services/harness')>()
  return {
    FALLBACK_PROVIDERS_HEADER,
    MODEL_HEADER,
    FLOW_MAP,
    FLOW_SEQ,
    isTopLevelLine,
    yamlScalar,
    parseFlowPairs,
    parseFlowMaps,
    cascadeChain,
    sameCascadeRow,
    guessDataDir: vi.fn(() => '/tmp/hermes-test-data'),
    readModelConfig: vi.fn(() => []),
    readModelProvider: vi.fn(() => mockModelProvider()),
    readFallbackProviders: vi.fn(() => mockExistingFp()),
    // Built from the same fixtures the readers above serve.
    readCascade: vi.fn(() => {
      const primary = mockPrimary()
      const fallbacks = mockExistingFp()
      return { primary, fallbacks, primaryDuplicatedAsRow0: !!primary && fallbacks.length > 0 && sameCascadeRow(fallbacks[0], primary) }
    }),
    readAgentEnvVarNames: vi.fn(() => mockEnvVars()),
  }
})

import { GET, PUT } from './route'
import { services } from '@/lib/services'
import { readModelConfig } from '@/lib/services/harness'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_test/models', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Models API — PUT validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY']))
    mockExistingFp.mockReturnValue([])
    mockModelProvider.mockReturnValue('')
    mockPrimary.mockReturnValue(null)
    // Pretend config.yaml exists and is writable; capture writes in-memory.
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n' as never
    )
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('accepts a model whose provider has a configured key and writes config.yaml (200)', async () => {
    // claude-opus-4-8 is NOT in the suggestions catalog — must still pass.
    const body = { provider: 'anthropic', cascade: ['claude-opus-4-8'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(fs.writeFileSync).toHaveBeenCalled()
    expect(services.harness.updateConfig).toHaveBeenCalled()
  })

  it('rejects a provider with no configured credential (400) without writing', async () => {
    // Agent has ANTHROPIC_API_KEY only — pushing an openrouter model crash-loops it.
    const body = { provider: 'openrouter', cascade: ['moonshotai/kimi-k2.7-code'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('moonshotai/kimi-k2.7-code')
    expect(json.error).toContain('openrouter')
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  // The { fallback_providers } body is fallback-only: the primary on disk
  // (model.default, as the mocked readCascade reports it) stays and the rows
  // become the block. These tests seed the primary the fixture file has.
  const seedPrimary = () => mockPrimary.mockReturnValue({ provider: 'anthropic', model: 'claude-sonnet-4-6' })

  it('rejects an un-serviceable provider in the fallback_providers shape (400)', async () => {
    seedPrimary()
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY'])) // no OPENAI_API_KEY
    const body = {
      fallback_providers: [
        { provider: 'anthropic', model: 'claude-opus-4-8' }, // serviceable
        { provider: 'openai', model: 'gpt-5' }, // no key → un-serviceable
      ],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('gpt-5')
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('accepts ollama with no key (local provider, 200)', async () => {
    seedPrimary()
    mockEnvVars.mockReturnValue(new Set<string>()) // no keys at all
    const body = {
      fallback_providers: [{ provider: 'ollama', model: 'my-local-build:latest', base_url: 'http://host.docker.internal:11434/v1' }],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(fs.writeFileSync).toHaveBeenCalled()
  })

  it('accepts an unknown / uncertain provider even with no key (fail open, 200)', async () => {
    mockEnvVars.mockReturnValue(new Set<string>())
    const body = { provider: 'nous', cascade: ['Hermes-4-405B'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(fs.writeFileSync).toHaveBeenCalled()
  })

  it('still rejects an empty cascade (400)', async () => {
    const body = { provider: 'anthropic', cascade: [] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('rejects an empty model id even when the provider has a key (400)', async () => {
    seedPrimary()
    const body = { fallback_providers: [{ provider: 'anthropic', model: '' }] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/missing model/i)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  // --- Section replacement must not leave orphaned block-sequence items -----
  //
  // Regression: an existing config whose `fallback_providers:` entries were
  // written with the dash at COLUMN 0 (valid YAML) was only partially replaced —
  // the old col-0 `- provider:` items don't match the "skip indented line" rule,
  // so they survived AFTER the freshly-written block, producing a bare sequence
  // item as a sibling of top-level keys → invalid YAML → agent can't load config.
  it('fully replaces a column-0 fallback_providers block (no orphaned entries)', async () => {
    const existing = [
      'model:',
      '  provider: anthropic',
      '  default: claude-sonnet-4-6',
      'fallback_providers:',
      '- provider: anthropic',           // <-- dash at column 0 (the failing shape)
      '  model: claude-sonnet-4-6',
      '- provider: ollama',
      '  model: qwen3:30b',
      '  base_url: http://host.docker.internal:11434/v1',
      'credential_pool_strategies: {}',
      '',
    ].join('\n')
    vi.spyOn(fs, 'readFileSync').mockReturnValue(existing as never)
    seedPrimary()
    mockExistingFp.mockReturnValue([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' }])
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

    const body = {
      fallback_providers: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
        { provider: 'ollama', model: 'glm4:9b', base_url: 'http://host.docker.internal:11434/v1' },
      ],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)

    // No orphaned column-0 sequence items may remain anywhere in the output.
    expect(written).not.toMatch(/^- provider:/m)
    // The trailing top-level key must survive exactly once (not duplicated/eaten).
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
    // The new final fallback landed, and the old block was not carried over twice.
    expect(written).toContain('glm4:9b')
    expect((written.match(/model: qwen3:30b/g) ?? []).length).toBe(1)
    // Every non-blank line between the header and the next top-level key is indented.
    const lines = written.split('\n')
    const start = lines.findIndex((l) => /^fallback_providers:/.test(l))
    const end = lines.findIndex((l, i) => i > start && /^[A-Za-z_][\w-]*:/.test(l))
    for (const l of lines.slice(start + 1, end)) {
      if (l.trim() !== '') expect(l).toMatch(/^\s+/)
    }
  })

  // --- Issue #149 --------------------------------------------------------------
  //
  // Legacy body shape `{ provider, cascade: string[] }` (API callers, README
  // example). Before: fpLines was empty, so the section loop DELETED the whole
  // existing fallback_providers block, and every row's provider/base_url was
  // lost. After: each cascade model is mapped onto its existing row (keeping
  // provider + base_url); only a model with no existing row gets body.provider.
  it('legacy body preserves existing ollama row (provider + base_url) when reordered to primary', async () => {
    const OLLAMA_URL = 'http://host.docker.internal:11434/v1'
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY']))
    mockModelProvider.mockReturnValue('anthropic')
    mockPrimary.mockReturnValue({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    mockExistingFp.mockReturnValue([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
    ])
    const existing = [
      'model:',
      '  provider: anthropic',
      '  default: claude-sonnet-4-6',
      '  fallback:',
      '    - qwen3:30b',
      '',
      'fallback_providers:',
      '  - provider: anthropic',
      '    model: claude-sonnet-4-6',
      '  - provider: ollama',
      '    model: qwen3:30b',
      `    base_url: ${OLLAMA_URL}`,
      'credential_pool_strategies: {}',
      '',
    ].join('\n')
    vi.spyOn(fs, 'readFileSync').mockReturnValue(existing as never)
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

    // Local model promoted to primary, plus one brand-new anthropic fallback.
    const body = { provider: 'anthropic', cascade: ['qwen3:30b', 'claude-sonnet-4-6', 'claude-haiku-4-5'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)

    // The block survived — exactly one header.
    expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
    // qwen3 kept its ollama provider AND base_url; it was not rewritten as anthropic.
    expect(written).toMatch(/- provider: ollama\n\s+model: qwen3:30b\n\s+base_url: http:\/\/host\.docker\.internal:11434\/v1/)
    expect(written).not.toMatch(/- provider: anthropic\n\s+model: qwen3:30b/)
    // model.provider follows the new primary row, not the stale body.provider.
    expect(written).toMatch(/^model:\n  provider: ollama\n  default: qwen3:30b/m)
    // The unknown model defaulted to body.provider.
    expect(written).toMatch(/- provider: anthropic\n\s+model: claude-haiku-4-5/)
    // Order in the block follows the cascade order.
    expect(written.indexOf('model: qwen3:30b')).toBeLessThan(written.indexOf('model: claude-sonnet-4-6'))
    expect(written.indexOf('model: claude-sonnet-4-6')).toBeLessThan(written.indexOf('model: claude-haiku-4-5'))
    // Trailing top-level key intact, exactly once.
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
  })

  it('legacy body with no provider defaults an unknown model to model.provider, never a null-provider row', async () => {
    // README/AGENTS document `{"cascade":[...]}` with no provider. An unknown
    // model must not be written as `- provider: ` (YAML null): Hermes silently
    // drops such a row and our own reader cannot parse it back, so the editor
    // and model.fallback silently diverge.
    const OLLAMA_URL = 'http://host.docker.internal:11434/v1'
    mockModelProvider.mockReturnValue('anthropic')
    mockPrimary.mockReturnValue({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
    mockExistingFp.mockReturnValue([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:8b', base_url: OLLAMA_URL },
    ])
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

    const body = { cascade: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'qwen3:8b'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(written).not.toMatch(/provider:\s*$/m)
    expect(written).toMatch(/- provider: anthropic\n\s+model: claude-haiku-4-5/)
    expect(written).toMatch(/- provider: ollama\n\s+model: qwen3:8b\n\s+base_url: /)
    expect(written).toMatch(/^model:\n  provider: anthropic\n  default: claude-sonnet-4-6/m)
  })

  it('legacy body with no provider anywhere rejects an unknown model (400) and writes nothing', async () => {
    mockModelProvider.mockReturnValue('')
    mockExistingFp.mockReturnValue([
      { provider: 'ollama', model: 'qwen3:8b', base_url: 'http://host.docker.internal:11434/v1' },
    ])
    const body = { cascade: ['qwen3:8b', 'claude-haiku-4-5'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('claude-haiku-4-5')
    expect(json.error).toMatch(/provider/i)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  it('legacy body never deletes an existing fallback_providers block, even when the reader cannot parse it', async () => {
    // Reader says [] (e.g. a shape it does not understand) but the file has a
    // block. Old code: fpLines empty → section loop ate the block. Must survive.
    mockExistingFp.mockReturnValue([])
    const existing = [
      'model:',
      '  provider: anthropic',
      '  default: claude-sonnet-4-6',
      'fallback_providers:',
      '  - provider: ollama',
      '    model: qwen3:30b',
      '    base_url: http://host.docker.internal:11434/v1',
      'credential_pool_strategies: {}',
      '',
    ].join('\n')
    vi.spyOn(fs, 'readFileSync').mockReturnValue(existing as never)
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

    const body = { provider: 'anthropic', cascade: ['claude-opus-4-8'] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
    expect(written).toContain('model: qwen3:30b')
    expect(written).toContain('base_url: http://host.docker.internal:11434/v1')
    expect(written).toMatch(/^model:\n  provider: anthropic\n  default: claude-opus-4-8/m)
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
  })

  // Writer must recognise the same header form the reader does. A header with
  // a trailing comment was not matched → the old block was left in place AND a
  // second top-level `fallback_providers:` was appended → duplicate key.
  it('replaces a fallback_providers block whose header carries a trailing comment (no duplicate block)', async () => {
    const existing = [
      'model:',
      '  provider: anthropic',
      '  default: claude-sonnet-4-6',
      'fallback_providers:  # ordered; first entry is primary',
      '  - provider: anthropic',
      '    model: claude-sonnet-4-6',
      '  - provider: ollama',
      '    model: qwen3:30b',
      '    base_url: http://host.docker.internal:11434/v1',
      'credential_pool_strategies: {}',
      '',
    ].join('\n')
    vi.spyOn(fs, 'readFileSync').mockReturnValue(existing as never)
    seedPrimary()
    mockExistingFp.mockReturnValue([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' }])
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

    // The file repeats its primary as row 0, so the primary's row is the
    // writer's: it stays at row 0 and the body's copy is not written twice.
    const body = {
      fallback_providers: [
        { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
    expect((written.match(/model: qwen3:30b/g) ?? []).length).toBe(1)
    expect((written.match(/model: claude-sonnet-4-6/g) ?? []).length).toBe(1)
    // Fallback-only body: the primary is untouched and its duplicate row keeps row 0; qwen follows.
    expect(written).toMatch(/^model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n/m)
    expect(written.indexOf('model: claude-sonnet-4-6\n', written.indexOf('fallback_providers:'))).toBeLessThan(written.indexOf('model: qwen3:30b'))
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
  })
})

// --- Audit: the legacy body shape must go through the same guarded writer -----
describe('Models API — legacy body through the shared writer (audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
    mockExistingFp.mockReturnValue([])
    mockModelProvider.mockReturnValue('')
    mockPrimary.mockReturnValue(null)
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  const capture = () => {
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })
    return () => written
  }

  it('{cascade} with no fallback_providers block keeps model.provider', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue('model:\n  provider: openrouter\n  default: z-ai/glm-5.2\nagent:\n  max_turns: 60\n' as never)
    const get = capture()
    const res = await PUT(makeRequest({ cascade: ['z-ai/glm-5.3'] }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(get()).toMatch(/^model:\n  provider: openrouter\n  default: z-ai\/glm-5\.3\n/m)
    expect(get()).toContain('agent:\n  max_turns: 60')
    expect(await res.json()).toMatchObject({ provider: 'openrouter', primary: 'z-ai/glm-5.3' })
  })

  it('{model} on a template custom primary keeps model.provider and model.base_url', async () => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'model:\n  provider: custom\n  default: qwen3:30b\n  base_url: "http://host.docker.internal:11434/v1"\n\ncompression:\n  enabled: true\n' as never
    )
    const get = capture()
    const res = await PUT(makeRequest({ model: 'glm4:9b' }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(get()).toMatch(/^model:\n  provider: custom\n  default: glm4:9b\n  base_url: "http:\/\/host\.docker\.internal:11434\/v1"\n/m)
    expect(get()).toContain('compression:\n  enabled: true')
  })

  it('{cascade} with duplicate ids writes each row once and never lists the primary under fallback:', async () => {
    mockExistingFp.mockReturnValue([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\nfallback_providers:\n  - provider: anthropic\n    model: claude-sonnet-4-6\n' as never
    )
    const get = capture()
    const res = await PUT(makeRequest({ cascade: ['claude-sonnet-4-6', 'claude-sonnet-4-6'] }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect((get().match(/model: claude-sonnet-4-6/g) ?? []).length).toBe(1)
    expect(get()).not.toContain('fallback:')
    expect((await res.json()).models).toEqual(['claude-sonnet-4-6'])
  })

  it('legacy body rejects an unsafe base_url carried on an existing row (same scalar check as the fallback_providers shape)', async () => {
    mockExistingFp.mockReturnValue([{ provider: 'ollama', model: 'qwen3:30b', base_url: 'http://x\nevil: true' }])
    const res = await PUT(makeRequest({ cascade: ['qwen3:30b'] }), makeParams('h_test'))
    expect(res.status).toBe(400)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  // matilde-shaped file — model.default is kimi-k3 and row 0 is glm-5.3. The
  // runtime tries kimi-k3 first, then glm-5.3: that IS the chain. PR #243
  // refused this with 409 primary-mismatch on the wrong premise (row 0 ==
  // primary).
  const DRIFTED =
    'model:\n  provider: openrouter\n  default: moonshotai/kimi-k3\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.3\n  - provider: anthropic\n    model: claude-sonnet-5\n'
  const DRIFTED_ROWS = [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-5' }]
  const DRIFTED_PRIMARY = { provider: 'openrouter', model: 'moonshotai/kimi-k3' }
  const DRIFTED_CHAIN = [DRIFTED_PRIMARY, ...DRIFTED_ROWS]
  const seedDrifted = () => {
    mockPrimary.mockReturnValue(DRIFTED_PRIMARY)
    mockExistingFp.mockReturnValue(DRIFTED_ROWS)
    vi.spyOn(fs, 'readFileSync').mockReturnValue(DRIFTED as never)
  }

  it('{ chain, expected_chain } on a file whose primary is not row 0 edits a fallback and keeps model.default (no 409)', async () => {
    seedDrifted()
    const written = capture()
    const body = {
      chain: [DRIFTED_PRIMARY, DRIFTED_ROWS[0], { provider: 'anthropic', model: 'claude-sonnet-5.1' }],
      expected_chain: DRIFTED_CHAIN,
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(written()).toBe(DRIFTED.replace('claude-sonnet-5\n', 'claude-sonnet-5.1\n'))
    expect(services.harness.updateConfig).toHaveBeenCalledWith('h_test', { models: ['moonshotai/kimi-k3', 'z-ai/glm-5.3', 'claude-sonnet-5.1'] })
  })

  it('{ chain } may change the primary outright: chain[0] goes to model:, no duplicate row is invented', async () => {
    seedDrifted()
    const written = capture()
    const res = await PUT(makeRequest({ chain: [DRIFTED_ROWS[0], DRIFTED_PRIMARY, DRIFTED_ROWS[1]], expected_chain: DRIFTED_CHAIN }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(written()).toBe(
      'model:\n  provider: openrouter\n  default: z-ai/glm-5.3\nfallback_providers:\n  - provider: openrouter\n    model: moonshotai/kimi-k3\n  - provider: anthropic\n    model: claude-sonnet-5\n'
    )
  })

  it('{ chain } with a stale expected_chain → 409, nothing written', async () => {
    seedDrifted()
    const stale = [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, ...DRIFTED_ROWS]
    const res = await PUT(makeRequest({ chain: stale, expected_chain: stale }), makeParams('h_test'))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed since it was read/)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  it('{ chain } strips carryFrom from the body: the row is validated bare', async () => {
    seedDrifted()
    mockEnvVars.mockReturnValue(new Set<string>(['OPENROUTER_KEY_B']))
    vi.spyOn(fs, 'readFileSync').mockReturnValue(DRIFTED.replace('    model: z-ai/glm-5.3\n', '    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B\n') as never)
    const body = { chain: [{ provider: 'openrouter', model: 'moonshotai/kimi-k3.1', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.3' } }] }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })

  it('the pre-chain { fallback_providers } body is fallback-only: the rows are rewritten, model.default (kimi-k3) is untouched', async () => {
    seedDrifted()
    const written = capture()
    const body = {
      fallback_providers: [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-5.1' }],
      expected_fallback_providers: DRIFTED_ROWS,
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(written()).toBe(DRIFTED.replace('claude-sonnet-5\n', 'claude-sonnet-5.1\n'))
    expect((await res.json()).chain[0]).toEqual(DRIFTED_PRIMARY)
  })

  it('legacy {model} on the same file moves the primary and empties the rows in place', async () => {
    seedDrifted()
    const written = capture()
    const res = await PUT(makeRequest({ model: 'z-ai/glm-5.3' }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(written()).toBe('model:\n  provider: openrouter\n  default: z-ai/glm-5.3\nfallback_providers: []\n')
  })

  it('fallback_providers shape with a stale expected_fallback_providers → 409, nothing written', async () => {
    mockExistingFp.mockReturnValue([{ provider: 'openrouter', model: 'z-ai/glm-5.3' }])
    const body = {
      fallback_providers: [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }],
      expected_fallback_providers: [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(409)
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })
})

describe('Models API — carryFrom never enters from the API (round-3 audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistingFp.mockReturnValue([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
    mockModelProvider.mockReturnValue('openrouter')
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('a body row carrying carryFrom does not inherit the named row\'s key_env: the row is validated bare (400, nothing written)', async () => {
    // The agent authenticates OpenRouter only through the row's key_env; there
    // is no OPENROUTER_API_KEY. A body that names that row as carryFrom would
    // otherwise ride its credential onto any model it likes.
    mockEnvVars.mockReturnValue(new Set<string>(['OPENROUTER_KEY_B']))
    mockPrimary.mockReturnValue({ provider: 'openrouter', model: 'z-ai/glm-5.2' })
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      ['model:', '  provider: openrouter', '  default: z-ai/glm-5.2', 'fallback_providers:', '  - provider: openrouter', '    model: z-ai/glm-5.2', '    key_env: OPENROUTER_KEY_B', ''].join('\n') as never
    )
    const body = {
      fallback_providers: [{ provider: 'openrouter', model: 'moonshotai/kimi-k3', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } }],
      expected_fallback_providers: [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }],
    }
    const res = await PUT(makeRequest(body), makeParams('h_test'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toContain('moonshotai/kimi-k3')
    expect(fs.writeFileSync).not.toHaveBeenCalled()
  })
})

describe('Models API — GET returns the chain the editor shows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockModelProvider.mockReturnValue('openrouter')
    vi.mocked(readModelConfig).mockReturnValue(['z-ai/glm-5.3'])
  })
  afterEach(() => vi.restoreAllMocks())

  const get = () => GET(new Request('http://localhost/api/harnesses/h_test/models'), makeParams('h_test'))

  it('cyborg-shaped (primary not in the rows): chain = [primary, ...rows], flag false, raw rows kept', async () => {
    mockPrimary.mockReturnValue({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    mockExistingFp.mockReturnValue([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    const json = await (await get()).json()
    expect(json.chain).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    expect(json.primaryEntry).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(json.primaryDuplicatedAsRow0).toBe(false)
    expect(json.fallbackProviders).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    // Compatibility fields.
    expect(json).toMatchObject({ provider: 'openrouter', primary: 'z-ai/glm-5.3', models: ['z-ai/glm-5.3'] })
  })

  it('HSM-saved (primary repeated as row 0): the duplicate is folded out of the chain and reported by the flag', async () => {
    mockPrimary.mockReturnValue({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    mockExistingFp.mockReturnValue([{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    const json = await (await get()).json()
    expect(json.chain.map((e: { model: string }) => e.model)).toEqual(['z-ai/glm-5.3', 'claude-sonnet-4-6'])
    expect(json.primaryDuplicatedAsRow0).toBe(true)
    expect(json.fallbackProviders).toHaveLength(2)
  })

  it('no primary: the chain is the rows alone and primaryEntry is null', async () => {
    mockPrimary.mockReturnValue(null)
    mockExistingFp.mockReturnValue([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    const json = await (await get()).json()
    expect(json.chain).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    expect(json.primaryEntry).toBeNull()
  })
})
