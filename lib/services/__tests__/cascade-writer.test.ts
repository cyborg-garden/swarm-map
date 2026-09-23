/**
 * Tests for applyCascadeToHarness — the single server-side path that writes a
 * fallback_providers cascade into an agent's config.yaml.
 *
 * Extracted from PUT /api/harnesses/:id/models so the cascade library's
 * "apply" route and the manual editor share ONE guarded writer. The most
 * important property: an entry whose provider has no credential in the
 * agent's .env must fail with a 400 result and write NOTHING — a bad write
 * crash-loops a live agent on restart.
 *
 * config.yaml lives in a real tmpdir here (no fs mocking) so the line-splicing
 * is exercised against disk and read back with the real readFallbackProviders.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpDir = ''
const mockEnvVars = vi.fn(() => new Set<string>(['ANTHROPIC_API_KEY']))
const mockGet = vi.fn((id: string) =>
  id === 'h_test' ? { id: 'h_test', name: 'test', serviceName: 'hermes-test' } : undefined
)

vi.mock('@/lib/services', () => ({
  services: {
    harness: {
      get: (id: string) => mockGet(id),
      updateConfig: vi.fn(),
    },
    audit: { append: vi.fn() },
  },
}))

vi.mock('@/lib/services/harness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/harness')>(
    '@/lib/services/harness'
  )
  return {
    ...actual,
    guessDataDir: vi.fn(() => tmpDir),
    readAgentEnvVarNames: vi.fn(() => mockEnvVars()),
  }
})

import { applyCascadeToHarness } from '../cascade-writer'
import { readFallbackProviders, readModelConfig } from '@/lib/services/harness'
import { services } from '@/lib/services'

const configPath = () => path.join(tmpDir, 'config.yaml')

describe('applyCascadeToHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-writer-'))
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY']))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns 404 and writes nothing for an unknown harness', () => {
    const res = applyCascadeToHarness('h_missing', [{ provider: 'anthropic', model: 'x' }], { who: 'api' })
    expect(res).toEqual({ ok: false, status: 404, error: 'Harness not found' })
    expect(fs.existsSync(configPath())).toBe(false)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty cascade and writes nothing', () => {
    const res = applyCascadeToHarness('h_test', [], { who: 'api' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(400)
    expect(fs.existsSync(configPath())).toBe(false)
  })

  // THE guard. An openrouter entry on an agent whose .env has only
  // ANTHROPIC_API_KEY must be refused before any byte hits config.yaml.
  it('returns 400 with the validation message and writes NOTHING when a provider has no credential', () => {
    fs.writeFileSync(configPath(), 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')
    const before = fs.readFileSync(configPath(), 'utf-8')

    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
      ],
      { who: 'api' }
    )

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(400)
      expect(res.error).toMatch(/^Invalid model cascade:/)
      expect(res.error).toContain('moonshotai/kimi-k2.7-code')
      expect(res.error).toContain('openrouter')
    }
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(before)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
    expect(services.audit.append).not.toHaveBeenCalled()
  })

  it('returns 400 for an empty model id even with a key present', () => {
    const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: '' }], { who: 'api' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/missing model/i)
    expect(fs.existsSync(configPath())).toBe(false)
  })

  it('creates config.yaml when none exists and reports what it wrote', () => {
    const entries = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' },
    ]
    const res = applyCascadeToHarness('h_test', entries, { who: 'api' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.written.provider).toBe('anthropic')
      expect(res.written.primary).toBe('claude-sonnet-4-6')
      expect(res.written.models).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5'])
      expect(res.written.fallbackProviders).toEqual(entries)
    }
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toContain('model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n  fallback:\n    - claude-haiku-4-5\n')
    expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-4-6')
    expect(readFallbackProviders(tmpDir)).toEqual(entries)
    expect(services.harness.updateConfig).toHaveBeenCalledWith('h_test', {
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    })
  })

  it('splices model: and fallback_providers: into an existing config, preserving other keys', () => {
    fs.writeFileSync(
      configPath(),
      [
        'agent_name: test',
        'model:',
        '  provider: anthropic',
        '  default: claude-sonnet-4-6',
        'fallback_providers:',
        '- provider: anthropic', // column-0 list item — must be fully replaced
        '  model: claude-sonnet-4-6',
        'credential_pool_strategies: {}',
        '',
      ].join('\n')
    )
    const entries = [
      { provider: 'anthropic', model: 'claude-opus-4-8' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
    ]
    const res = applyCascadeToHarness('h_test', entries, { who: 'api' })
    expect(res.ok).toBe(true)

    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toContain('agent_name: test')
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
    expect(written).not.toMatch(/^- provider:/m)
    expect((written.match(/^model:/gm) ?? []).length).toBe(1)
    expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
    expect(written).not.toContain('api_key')
    expect(readFallbackProviders(tmpDir)).toEqual(entries)
    expect(readModelConfig(tmpDir)[0]).toBe('claude-opus-4-8')
    expect(written).toContain('  fallback:\n    - qwen3:30b')
  })

  it('never writes api_key into config.yaml even if an entry carries one', () => {
    const res = applyCascadeToHarness(
      'h_test',
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6', api_key: 'sk-ant-SECRET' } as never],
      { who: 'api' }
    )
    expect(res.ok).toBe(true)
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).not.toContain('SECRET')
    expect(written).not.toContain('api_key')
  })

  it('accepts ollama with no key at all (local provider) and an unknown provider (fail open)', () => {
    mockEnvVars.mockReturnValue(new Set<string>())
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'ollama', model: 'my-local:latest', base_url: 'http://host.docker.internal:11434/v1' },
        { provider: 'nous', model: 'Hermes-4-405B' },
      ],
      { who: 'api' }
    )
    expect(res.ok).toBe(true)
    expect(fs.existsSync(configPath())).toBe(true)
  })

  // Values are written UNQUOTED by line splicing. A newline in a model id would
  // inject arbitrary top-level keys into config.yaml (then the caller restarts
  // the agent onto it). Refuse before any byte is written, key or no key.
  it('returns 400 and writes NOTHING for a model id containing a newline, even with a key present', () => {
    fs.writeFileSync(configPath(), 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')
    const before = fs.readFileSync(configPath(), 'utf-8')
    const res = applyCascadeToHarness(
      'h_test',
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6\nmodel: injected\ntoolsets: [oops]' }],
      { who: 'api' }
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(400)
      expect(res.error).toMatch(/^Invalid model cascade:/)
    }
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(before)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  it('returns 400 and writes NOTHING for a provider or base_url that is not a safe YAML scalar', () => {
    for (const entry of [
      { provider: 'anthropic\nfoo: bar', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://h:11434/v1\nplatforms: {}' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://h:11434/v1 #x' },
      { provider: 'anthropic', model: 'foo: bar' },
    ]) {
      const res = applyCascadeToHarness('h_test', [entry], { who: 'api' })
      expect(res.ok, JSON.stringify(entry)).toBe(false)
      if (!res.ok) expect(res.status).toBe(400)
    }
    expect(fs.existsSync(configPath())).toBe(false)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
  })

  // Writer must recognise the same header form the reader does. A header with
  // a trailing comment was not matched → the old block was left in place AND a
  // second top-level `fallback_providers:` was appended → duplicate key (#149).
  it('replaces a fallback_providers block whose header carries a trailing comment (no duplicate block)', () => {
    fs.writeFileSync(
      configPath(),
      [
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
    )
    const entries = [
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ]
    const res = applyCascadeToHarness('h_test', entries, { who: 'api' })
    expect(res.ok).toBe(true)
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
    expect((written.match(/model: qwen3:30b/g) ?? []).length).toBe(1)
    expect((written.match(/model: claude-sonnet-4-6/g) ?? []).length).toBe(1)
    expect(written.indexOf('model: qwen3:30b')).toBeLessThan(written.indexOf('model: claude-sonnet-4-6'))
    expect((written.match(/^credential_pool_strategies:/gm) ?? []).length).toBe(1)
    expect(readFallbackProviders(tmpDir)).toEqual(entries)
  })

  // Byte-for-byte pin of the splice. The model-update scheduler rewrites a
  // RUNNING agent's config.yaml through this writer with no human in the loop,
  // so a refactor must not be able to silently change what lands on disk:
  // both sections replaced in place, every other line untouched, blank lines
  // inside a replaced section consumed, trailing newline preserved.
  it('replaces both sections in place and leaves every other line byte-identical', () => {
    mockEnvVars.mockReturnValue(new Set<string>(['OPENROUTER_API_KEY']))
    fs.writeFileSync(
      configPath(),
      [
        '# agent config',
        'model:',
        '  provider: openrouter',
        '  default: z-ai/glm-5.2',
        '  fallback:',
        '    - moonshotai/kimi-k2.7-code',
        '',
        'auxiliary:',
        '  vision:',
        '    model: google/gemini-2.5-flash',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '  - provider: openrouter',
        '    model: moonshotai/kimi-k2.7-code',
        '',
        'platforms:',
        '  telegram:',
        '    enabled: true',
        '',
      ].join('\n')
    )
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'openrouter', model: 'z-ai/glm-5.3' },
        { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
      ],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      [
        '# agent config',
        'model:',
        '  provider: openrouter',
        '  default: z-ai/glm-5.3',
        '  fallback:',
        '    - moonshotai/kimi-k2.7-code',
        'auxiliary:',
        '  vision:',
        '    model: google/gemini-2.5-flash',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.3',
        '  - provider: openrouter',
        '    model: moonshotai/kimi-k2.7-code',
        'platforms:',
        '  telegram:',
        '    enabled: true',
        '',
      ].join('\n')
    )
  })

  it('creates config.yaml with exactly the two sections when none exists', () => {
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      ],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n  fallback:\n    - claude-haiku-4-5-20251001\n' +
        '\nfallback_providers:\n  - provider: anthropic\n    model: claude-sonnet-4-6\n  - provider: anthropic\n    model: claude-haiku-4-5-20251001\n'
    )
  })

  it('appends an audit entry only when asked, with the caller-supplied who/what/meta', () => {
    applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
    expect(services.audit.append).not.toHaveBeenCalled()

    applyCascadeToHarness(
      'h_test',
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }],
      { who: 'scheduler', audit: { what: 'cascade:apply', meta: { name: 'fleet', harness: 'h_test' } } }
    )
    expect(services.audit.append).toHaveBeenCalledTimes(1)
    expect(services.audit.append).toHaveBeenCalledWith({
      who: 'scheduler',
      what: 'cascade:apply',
      target: 'h_test',
      meta: { name: 'fleet', harness: 'h_test' },
    })
  })
})

// --- Audit: the writer must round-trip what it does not manage --------------
describe('applyCascadeToHarness — round-trip and preconditions (audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-writer-'))
    mockEnvVars.mockReturnValue(new Set<string>(['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY']))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const OLLAMA_URL = 'http://host.docker.internal:11434/v1'

  it('keeps model.base_url and other model.* keys (api_mode) when a different row is rotated', () => {
    // The HSM template writes provider: custom + base_url for a local primary.
    fs.writeFileSync(
      configPath(),
      [
        'model:',
        '  provider: custom',
        '  default: qwen3:30b',
        `  base_url: "${OLLAMA_URL}"`,
        '  api_mode: chat_completions',
        '',
        'fallback_providers:',
        '  - provider: custom',
        '    model: qwen3:30b',
        `    base_url: "${OLLAMA_URL}"`,
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        'platforms:',
        '  telegram:',
        '    enabled: true',
        '',
      ].join('\n')
    )
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'custom', model: 'qwen3:30b', base_url: OLLAMA_URL },
        { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      ],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    const written = fs.readFileSync(configPath(), 'utf-8')
    const modelBlock = written.slice(0, written.indexOf('fallback_providers:'))
    expect(modelBlock).toMatch(/^  provider: custom$/m)
    expect(modelBlock).toMatch(/^  default: qwen3:30b$/m)
    expect(modelBlock).toMatch(/^  base_url: "?http:\/\/host\.docker\.internal:11434\/v1"?$/m)
    expect(modelBlock).toMatch(/^  api_mode: chat_completions$/m)
    expect(modelBlock).toMatch(/^  fallback:\n    - z-ai\/glm-5\.3$/m)
    expect((written.match(/^model:/gm) ?? []).length).toBe(1)
  })

  it('model.base_url follows the new primary row: written from entry 0, dropped when a cloud primary replaces a local one', () => {
    fs.writeFileSync(
      configPath(),
      [
        'model:',
        '  provider: anthropic',
        '  default: claude-sonnet-4-6',
        'fallback_providers:',
        '  - provider: anthropic',
        '    model: claude-sonnet-4-6',
        '  - provider: ollama',
        '    model: qwen3:30b',
        `    base_url: ${OLLAMA_URL}`,
        '',
      ].join('\n')
    )
    // Local model promoted to primary → model.base_url must appear.
    let res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      ],
      { who: 'api' }
    )
    expect(res.ok).toBe(true)
    let written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toMatch(/^model:\n  provider: ollama\n  default: qwen3:30b\n  base_url: http:\/\/host\.docker\.internal:11434\/v1\n/m)

    // Cloud model back to primary → the local base_url must not leak onto it.
    res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
      ],
      { who: 'api' }
    )
    expect(res.ok).toBe(true)
    written = fs.readFileSync(configPath(), 'utf-8')
    const modelBlock = written.slice(0, written.indexOf('fallback_providers:'))
    expect(modelBlock).not.toContain('base_url')
    expect(modelBlock).toMatch(/^  provider: anthropic\n  default: claude-sonnet-4-6\n/m)
  })

  it('round-trips unknown row keys (api_key, key_env, api_mode) on rows it did not change; still never writes a caller-supplied api_key', () => {
    fs.writeFileSync(
      configPath(),
      [
        'model:',
        '  provider: openrouter',
        '  default: z-ai/glm-5.2',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '  - provider: custom',
        '    model: some-proxy-model',
        '    base_url: http://proxy:4000/v1',
        '    api_key: sk-proxy-inline',
        '    key_env: PROXY_KEY',
        '    api_mode: chat_completions',
        'platforms:',
        '  telegram:',
        '    enabled: true',
        '',
      ].join('\n')
    )
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'openrouter', model: 'z-ai/glm-5.3' },
        { provider: 'custom', model: 'some-proxy-model', base_url: 'http://proxy:4000/v1', api_key: 'sk-from-ui' } as never,
      ],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toContain('    api_key: sk-proxy-inline')
    expect(written).toContain('    key_env: PROXY_KEY')
    expect(written).toContain('    api_mode: chat_completions')
    expect(written).not.toContain('sk-from-ui')
    expect(written).toContain('    model: z-ai/glm-5.3')
    expect(written).not.toContain('z-ai/glm-5.2')
    // Extra keys stay inside their own row (between the custom row and the next top-level key).
    const customIdx = written.indexOf('model: some-proxy-model')
    expect(written.indexOf('api_key: sk-proxy-inline')).toBeGreaterThan(customIdx)
    expect(written.indexOf('api_key: sk-proxy-inline')).toBeLessThan(written.indexOf('platforms:'))
    // The reader never surfaces the inline key (it would reach the browser).
    expect(readFallbackProviders(tmpDir)).toEqual([
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      { provider: 'custom', model: 'some-proxy-model', base_url: 'http://proxy:4000/v1' },
    ])
  })

  it('does not carry a row\'s extra keys onto a row that replaced it with a different model', () => {
    fs.writeFileSync(
      configPath(),
      [
        'model:',
        '  provider: custom',
        '  default: proxy-a',
        'fallback_providers:',
        '  - provider: custom',
        '    model: proxy-a',
        '    base_url: http://proxy:4000/v1',
        '    api_key: sk-proxy-inline',
        '',
      ].join('\n')
    )
    const res = applyCascadeToHarness('h_test', [{ provider: 'custom', model: 'proxy-b', base_url: 'http://other:1/v1' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).not.toContain('api_key')
  })

  it('refuses with 409 and writes nothing when `expected` no longer matches the rows on disk', () => {
    const before = ['model:', '  provider: openrouter', '  default: z-ai/glm-5.3', 'fallback_providers:', '  - provider: openrouter', '    model: z-ai/glm-5.3', ''].join('\n')
    fs.writeFileSync(configPath(), before)
    // The editor was opened while the file still said glm-5.2; the scheduler rotated it since.
    const res = applyCascadeToHarness(
      'h_test',
      [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }],
      { who: 'api', expected: [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }] }
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(before)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()

    // Matching expectation → the write proceeds.
    const ok = applyCascadeToHarness(
      'h_test',
      [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }],
      { who: 'api', expected: [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }] }
    )
    expect(ok.ok).toBe(true)
    expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
  })

  it('fallbackProviders: "keep" rewrites only the model block and leaves the block on disk untouched', () => {
    const fpBlock = ['fallback_providers:', '  - provider: ollama', '    model: qwen3:30b', `    base_url: ${OLLAMA_URL}`].join('\n')
    fs.writeFileSync(configPath(), ['model:', '  provider: custom', '  default: qwen3:30b', `  base_url: "${OLLAMA_URL}"`, fpBlock, 'agent:', '  max_turns: 60', ''].join('\n'))
    // No provider from the caller → the existing provider line (and its base_url) stay.
    const res = applyCascadeToHarness('h_test', [{ provider: '', model: 'glm4:9b' }], { who: 'api', fallbackProviders: 'keep' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.written.provider).toBe('custom')
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toMatch(/^model:\n  provider: custom\n  default: glm4:9b\n  base_url: "http:\/\/host\.docker\.internal:11434\/v1"\n/m)
    expect(written).toContain(fpBlock)
    expect(written).toContain('agent:\n  max_turns: 60')
  })

  // --- Re-audit -------------------------------------------------------------

  describe('primary-mismatch guard (re-audit)', () => {
    // matilde-shaped: model.default is kimi-k3 while fallback_providers[0] is
    // glm-5.3. The writer derives model.default from row 0, so an editor save
    // that only touched row 2 silently switched the agent's primary.
    const drifted = [
      'model:',
      '  provider: openrouter',
      '  default: moonshotai/kimi-k3',
      'fallback_providers:',
      '  - provider: openrouter',
      '    model: z-ai/glm-5.3',
      '  - provider: anthropic',
      '    model: claude-sonnet-5',
      '',
    ].join('\n')

    it('refuses (409) a save whose row 0 is not the file\'s primary, and writes nothing', () => {
      fs.writeFileSync(configPath(), drifted)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-5.1' }],
        { who: 'api', expected: [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-5' }] }
      )
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(409)
        expect(res.error).toMatch(/primary-mismatch/)
        expect(res.error).toContain('moonshotai/kimi-k3')
      }
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(drifted)
      expect(services.harness.updateConfig).not.toHaveBeenCalled()
    })

    it('allows the save that puts the file\'s primary back at the top (reconciliation)', () => {
      fs.writeFileSync(configPath(), drifted)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'openrouter', model: 'moonshotai/kimi-k3' }, { provider: 'openrouter', model: 'z-ai/glm-5.3' }],
        { who: 'api' }
      )
      expect(res.ok).toBe(true)
      expect(readModelConfig(tmpDir)[0]).toBe('moonshotai/kimi-k3')
    })

    it('allowPrimaryChange (cascade library apply, legacy {model} body) may move the primary', () => {
      fs.writeFileSync(configPath(), drifted)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-5' }], { who: 'api', allowPrimaryChange: true })
      expect(res.ok).toBe(true)
      expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-5')
    })

    it('no drift (model.default == row 0) → a reorder is an ordinary edit', () => {
      fs.writeFileSync(configPath(), drifted.replace('default: moonshotai/kimi-k3', 'default: z-ai/glm-5.3'))
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'openrouter', model: 'z-ai/glm-5.3' }],
        { who: 'api' }
      )
      expect(res.ok).toBe(true)
      expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-5')
    })
  })

  describe('row extras across a rotation (re-audit)', () => {
    const cfg = [
      'model:',
      '  provider: openrouter',
      '  default: z-ai/glm-5.2',
      'fallback_providers:',
      '  - provider: openrouter',
      '    model: z-ai/glm-5.2',
      '    key_env: OPENROUTER_KEY_B',
      '    api_mode: chat_completions',
      '  - provider: anthropic',
      '    model: claude-sonnet-4-6',
      '',
    ].join('\n')

    it('carryFrom moves the old row\'s key_env / api_mode onto the successor row', () => {
      fs.writeFileSync(configPath(), cfg)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY_B']))
      const res = applyCascadeToHarness(
        'h_test',
        [
          { provider: 'openrouter', model: 'z-ai/glm-5.3', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } },
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        ],
        { who: 'scheduler' }
      )
      expect(res.ok).toBe(true)
      const written = fs.readFileSync(configPath(), 'utf-8')
      expect(written).toContain('  - provider: openrouter\n    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B\n    api_mode: chat_completions\n  - provider: anthropic')
      expect(written).not.toContain('glm-5.2')
      expect(written).not.toContain('carryFrom')
    })

    it('a row whose carried key_env names a present var is not refused for the provider\'s default var', () => {
      fs.writeFileSync(configPath(), cfg)
      // No OPENROUTER_API_KEY at all — the row authenticates with OPENROUTER_KEY_B.
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_KEY_B']))
      const res = applyCascadeToHarness(
        'h_test',
        [
          { provider: 'openrouter', model: 'z-ai/glm-5.3', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } },
          { provider: 'anthropic', model: 'claude-sonnet-4-6' },
        ],
        { who: 'scheduler' }
      )
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toContain('    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B')
      // …but an openrouter row with NO own credential is still refused.
      const bare = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'openrouter', model: 'moonshotai/kimi-k3' }], { who: 'api' })
      expect(bare.ok).toBe(false)
    })

    it('a stale carryFrom (row not on disk) is ignored, never an error', () => {
      fs.writeFileSync(configPath(), cfg)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'openrouter', model: 'z-ai/glm-5.3', carryFrom: { provider: 'openrouter', model: 'nope' } }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }],
        { who: 'scheduler' }
      )
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).not.toContain('key_env')
    })
  })

  it('the write result never carries an inline api_key (re-audit)', () => {
    fs.writeFileSync(
      configPath(),
      ['model:', '  provider: anthropic', '  default: claude-sonnet-4-6', 'fallback_providers:', '  - provider: anthropic', '    model: claude-sonnet-4-6', '    api_key: sk-inline-secret', ''].join('\n')
    )
    const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(JSON.stringify(res)).not.toContain('sk-inline-secret')
    // The operator's key still rides along inside the file.
    expect(fs.readFileSync(configPath(), 'utf-8')).toContain('    api_key: sk-inline-secret')
  })
})
