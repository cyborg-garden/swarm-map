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

vi.mock('@/lib/services/harness', async (importOriginal) => ({
  // The writer shares the reader's header regex; use the real one so the
  // route test exercises the same header form the reader accepts.
  FALLBACK_PROVIDERS_HEADER: (await importOriginal<typeof import('@/lib/services/harness')>()).FALLBACK_PROVIDERS_HEADER,
  guessDataDir: vi.fn(() => '/tmp/hermes-test-data'),
  readModelConfig: vi.fn(() => []),
  readModelProvider: vi.fn(() => mockModelProvider()),
  readFallbackProviders: vi.fn(() => mockExistingFp()),
  readAgentEnvVarNames: vi.fn(() => mockEnvVars()),
}))

import { PUT } from './route'
import { services } from '@/lib/services'

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

  it('rejects an un-serviceable provider in the fallback_providers shape (400)', async () => {
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
    let written = ''
    vi.spyOn(fs, 'writeFileSync').mockImplementation((_p, data) => { written = String(data) })

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
    expect(written.indexOf('model: qwen3:30b')).toBeLessThan(written.indexOf('model: claude-sonnet-4-6'))
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
  })
})
