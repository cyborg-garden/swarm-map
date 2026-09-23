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
