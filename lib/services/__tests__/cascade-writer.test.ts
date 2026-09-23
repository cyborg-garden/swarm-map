/**
 * Tests for applyCascadeToHarness — the single server-side path that writes a
 * model cascade (primary = model:, fallbacks = fallback_providers) into an
 * agent's config.yaml.
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
import { readFallbackProviders, readModelConfig, readCascade, cascadeChain } from '@/lib/services/harness'
import { CYBORG, MATILDE, CRYPTIDS, BLACKHOUSE, IRIS, FLEET_SHAPES, OLLAMA_URL as FLEET_OLLAMA_URL } from './fleet-shapes'
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
      expect(res.written.chain).toEqual(entries)
      // The primary lives in model:, the fallbacks in fallback_providers — a
      // fresh file repeats nothing.
      expect(res.written.fallbackProviders).toEqual([entries[1]])
    }
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toContain('model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')
    expect(written).not.toContain('fallback:')
    expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-4-6')
    expect(readFallbackProviders(tmpDir)).toEqual([entries[1]])
    expect(cascadeChain(readCascade(tmpDir))).toEqual(entries)
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
    // The file repeated its primary as row 0, so the new primary is repeated too.
    expect(readFallbackProviders(tmpDir)).toEqual(entries)
    expect(readModelConfig(tmpDir)[0]).toBe('claude-opus-4-8')
    // model.fallback is not read by the runtime; a file without the key does not gain one.
    expect(written).not.toContain('fallback:\n')
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
  // both sections replaced in place, every other line untouched — including
  // the blank line that separates a section from the next key (r3: those
  // used to be consumed) — trailing newline preserved.
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
        '',
        'auxiliary:',
        '  vision:',
        '    model: google/gemini-2.5-flash',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.3',
        '  - provider: openrouter',
        '    model: moonshotai/kimi-k2.7-code',
        '',
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
      'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n' +
        '\nfallback_providers:\n  - provider: anthropic\n    model: claude-haiku-4-5-20251001\n'
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
    expect(modelBlock).not.toContain('fallback:')
    expect((written.match(/^model:/gm) ?? []).length).toBe(1)
    // The duplicate row 0 (the file's convention) followed the primary; the rotated row is row 1.
    expect(readFallbackProviders(tmpDir)).toEqual([
      { provider: 'custom', model: 'qwen3:30b', base_url: OLLAMA_URL },
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
    ])
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

  describe('a primary that is not fallback_providers[0] is the ordinary shape, never a mismatch', () => {
    // matilde-shaped: model.default is kimi-k3 and fallback_providers[0] is
    // glm-5.3. The runtime tries kimi-k3 first and glm-5.3 second — that is
    // exactly what the chain [kimi-k3, glm-5.3, …] says. PR #243 refused this
    // file with 409 primary-mismatch because it assumed row 0 == primary.
    const matilde = [
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

    it('a save that edits a fallback row keeps model.default and adds no duplicate row', () => {
      fs.writeFileSync(configPath(), matilde)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const chain = cascadeChain(readCascade(tmpDir))
      expect(chain.map((e) => e.model)).toEqual(['moonshotai/kimi-k3', 'z-ai/glm-5.3', 'claude-sonnet-5'])
      const res = applyCascadeToHarness(
        'h_test',
        [chain[0], chain[1], { provider: 'anthropic', model: 'claude-sonnet-5.1' }],
        { who: 'api', expected: chain }
      )
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(matilde.replace('claude-sonnet-5\n', 'claude-sonnet-5.1\n'))
    })

    it('a one-entry chain (library apply) makes that entry the primary and empties the rows in place', () => {
      fs.writeFileSync(configPath(), matilde)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-5' }], { who: 'api' })
      expect(res.ok).toBe(true)
      expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-5')
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe('model:\n  provider: anthropic\n  default: claude-sonnet-5\nfallback_providers: []\n')
    })

    it('promoting a fallback to primary rewrites model: and drops it from the rows', () => {
      fs.writeFileSync(configPath(), matilde)
      mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'anthropic', model: 'claude-sonnet-5' }, { provider: 'openrouter', model: 'moonshotai/kimi-k3' }, { provider: 'openrouter', model: 'z-ai/glm-5.3' }],
        { who: 'api' }
      )
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
        'model:\n  provider: anthropic\n  default: claude-sonnet-5\nfallback_providers:\n  - provider: openrouter\n    model: moonshotai/kimi-k3\n  - provider: openrouter\n    model: z-ai/glm-5.3\n'
      )
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

// --- config.yaml integrity (r3 nits) ------------------------------------------
// The writer splices by line into a file the operator also edits by hand. It
// must not eat their comments, change their line endings, or leave the file
// ending in the wrong number of newlines — and a file it cannot read
// unambiguously must be refused, not guessed at.
import { generateDefaultConfig } from '@/lib/templates/config-yaml'

describe('applyCascadeToHarness — config.yaml integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-integrity-'))
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('comments and blank lines after a managed section survive', () => {
    it('a no-op write over the repo template (model block only) is byte-identical', () => {
      const template = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-6', enabledPlatforms: ['telegram'] })
      expect(template).toContain('# --- Context compression')
      fs.writeFileSync(configPath(), template)
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api', fallbackProviders: 'keep' })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(template)
    })

    it('a no-op write over the ollama template keeps its quoted base_url and the header comments', () => {
      const template = generateDefaultConfig({ provider: 'ollama', primaryModel: 'qwen3:30b' })
      fs.writeFileSync(configPath(), template)
      const res = applyCascadeToHarness('h_test', [{ provider: 'custom', model: 'qwen3:30b' }], { who: 'api', fallbackProviders: 'keep' })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(template)
    })

    it('a real write over the template changes nothing but the two managed sections', () => {
      const template = generateDefaultConfig({ provider: 'anthropic', primaryModel: 'claude-sonnet-4-6' })
      fs.writeFileSync(configPath(), template)
      const res = applyCascadeToHarness(
        'h_test',
        [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'openrouter', model: 'z-ai/glm-5.3' }],
        { who: 'api' }
      )
      expect(res.ok).toBe(true)
      const written = fs.readFileSync(configPath(), 'utf-8')
      // The template's hint comment sits under `default:` and stays there;
      // the fallback list the writer adds follows it.
      // The template's commented `# fallback:` hint stays a comment (the
      // runtime never reads model.fallback, so the writer does not add the
      // key); the fallback lands in an appended fallback_providers block
      // that does NOT repeat the primary.
      const expected = template.replace(/\n*$/, '\n') + '\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.3\n'
      expect(written).toBe(expected)
    })

    it('column-0 comments and blank lines between a section and the next key are re-emitted, every write', () => {
      const cfg = [
        'model:',
        '  provider: openrouter',
        '  default: z-ai/glm-5.2',
        '',
        '# --- Context compression ---',
        'compression:',
        '  enabled: true',
        '',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '',
        '# --- Platforms ---',
        '',
        'platforms:',
        '  telegram:',
        '    enabled: true',
        '',
      ].join('\n')
      fs.writeFileSync(configPath(), cfg)
      const entries = [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }]
      for (let i = 0; i < 2; i++) {
        const res = applyCascadeToHarness('h_test', entries, { who: 'scheduler' })
        expect(res.ok).toBe(true)
      }
      // The file repeated its primary as row 0; the rotated primary is repeated the same way.
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(cfg.replaceAll('z-ai/glm-5.2', 'z-ai/glm-5.3'))
    })

    it('a blank line INSIDE a section (between rows) does not end it — the old rows are not duplicated', () => {
      const cfg = [
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '',
        '  - provider: anthropic',
        '    model: claude-sonnet-4-6',
        '',
        'platforms: {}',
        '',
      ].join('\n')
      fs.writeFileSync(configPath(), cfg)
      const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
      expect(res.ok).toBe(true)
      const written = fs.readFileSync(configPath(), 'utf-8')
      expect((written.match(/model: claude-sonnet-4-6/g) ?? []).length).toBe(1)
      expect((written.match(/^fallback_providers:/gm) ?? []).length).toBe(1)
      // The blank line that trailed the block is still there; the model:
      // block the file never had is appended after platforms.
      expect(written).toContain('    model: claude-sonnet-4-6\n\nplatforms: {}\n')
      expect(written.endsWith('\n')).toBe(true)
      expect(written.endsWith('\n\n')).toBe(false)
    })
  })

  describe('trailing newline and line endings', () => {
    it('output ends with exactly one newline whether the input had none, one or three', () => {
      for (const tail of ['', '\n', '\n\n\n']) {
        fs.writeFileSync(configPath(), 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\nplatforms: {}' + tail)
        const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
        expect(res.ok).toBe(true)
        const written = fs.readFileSync(configPath(), 'utf-8')
        expect(written.endsWith('\n')).toBe(true)
        expect(written.endsWith('\n\n')).toBe(false)
      }
    })

    it('an appended block is separated by ONE blank line, never two, and the file still ends with one newline', () => {
      fs.writeFileSync(configPath(), 'platforms: {}\n\n')
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }], { who: 'api' })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
        'platforms: {}\n\nmodel:\n  provider: anthropic\n  default: claude-sonnet-4-6\n\nfallback_providers:\n  - provider: anthropic\n    model: claude-haiku-4-5\n'
      )
    })

    it('CRLF input stays CRLF throughout, including the appended block and the trailing newline', () => {
      fs.writeFileSync(configPath(), 'model:\r\n  provider: anthropic\r\n  default: old\r\n  api_mode: chat\r\n\r\nplatforms: {}\r\n')
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }], { who: 'api' })
      expect(res.ok).toBe(true)
      const written = fs.readFileSync(configPath(), 'utf-8')
      expect(written).toBe(
        'model:\r\n  provider: anthropic\r\n  default: claude-sonnet-4-6\r\n  api_mode: chat\r\n\r\nplatforms: {}\r\n\r\nfallback_providers:\r\n  - provider: anthropic\r\n    model: claude-haiku-4-5\r\n'
      )
      expect(written).not.toMatch(/[^\r]\n/)
      expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'anthropic', model: 'claude-haiku-4-5' }])
      expect(readModelConfig(tmpDir)[0]).toBe('claude-sonnet-4-6')
    })
  })

  describe('flow-form headers', () => {
    it('`fallback_providers: []` is replaced in place, not appended as a second block', () => {
      fs.writeFileSync(configPath(), 'model: {provider: anthropic, default: old, api_mode: chat}\nfallback_providers: []\nplatforms: {}\n')
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }, { provider: 'anthropic', model: 'claude-haiku-4-5' }], { who: 'api' })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
        'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n  api_mode: chat\nfallback_providers:\n  - provider: anthropic\n    model: claude-haiku-4-5\nplatforms: {}\n'
      )
      // …and a chain with no fallbacks writes an empty flow block in place, never deletes the section.
      const none = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
      expect(none.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe('model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n  api_mode: chat\nfallback_providers: []\nplatforms: {}\n')
    })

    it('a flow `fallback_providers: [{…}]` row keeps its extras across a rotation, and the flow model block is expanded around an unchanged primary', () => {
      fs.writeFileSync(
        configPath(),
        'model: {provider: openrouter, default: moonshotai/kimi-k3}\nfallback_providers: [{provider: openrouter, model: z-ai/glm-5.2, key_env: OR_ALT}]\n'
      )
      // The scheduler rotates the fallback row; the primary (kimi-k3, read through the flow form) stays.
      const chain = cascadeChain(readCascade(tmpDir))
      expect(chain).toEqual([{ provider: 'openrouter', model: 'moonshotai/kimi-k3' }, { provider: 'openrouter', model: 'z-ai/glm-5.2' }])
      const res = applyCascadeToHarness('h_test', [chain[0], { provider: 'openrouter', model: 'z-ai/glm-5.3', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } }], { who: 'scheduler' })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
        'model:\n  provider: openrouter\n  default: moonshotai/kimi-k3\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.3\n    key_env: OR_ALT\n'
      )
    })
  })

  describe('duplicate top-level sections', () => {
    it('two model: headers → 409 duplicate-sections, nothing written', () => {
      const cfg = 'model:\n  provider: anthropic\n  default: a\nplatforms: {}\nmodel:\n  provider: anthropic\n  default: b\n'
      fs.writeFileSync(configPath(), cfg)
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'a' }], { who: 'api' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(409)
        expect(res.error).toMatch(/^duplicate-sections/)
        expect(res.error).toContain('model:')
      }
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(cfg)
      expect(services.harness.updateConfig).not.toHaveBeenCalled()
    })

    it('two fallback_providers: headers (one flow, one block, one with a comment) → 409, nothing written', () => {
      const cfg = 'model:\n  provider: anthropic\n  default: a\nfallback_providers: []  # empty\nplatforms: {}\nfallback_providers:\n  - provider: anthropic\n    model: a\n'
      fs.writeFileSync(configPath(), cfg)
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'a' }], { who: 'api' })
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.status).toBe(409)
        expect(res.error).toMatch(/^duplicate-sections/)
        expect(res.error).toContain('fallback_providers:')
      }
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(cfg)
    })

    it('an indented `model:` (auxiliary.vision.model) is not a top-level header', () => {
      fs.writeFileSync(configPath(), 'model:\n  provider: anthropic\n  default: a\nauxiliary:\n  vision:\n    model: x\n')
      const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'a' }], { who: 'api' })
      expect(res.ok).toBe(true)
    })
  })

  describe('scalar comments', () => {
    it('a trailing comment on model.default / row values is not part of the value', () => {
      const cfg = [
        'model:',
        '  provider: openrouter  # routed',
        '  default: z-ai/glm-5.2  # pinned 2026-09',
        'fallback_providers:',
        '  - provider: openrouter # same',
        '    model: z-ai/glm-5.2 # same',
        '    key_env: OR_ALT  # alt key',
        '',
      ].join('\n')
      fs.writeFileSync(configPath(), cfg)
      expect(readModelConfig(tmpDir)).toEqual(['z-ai/glm-5.2'])
      expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
      // The duplicate row 0 is matched against the comment-stripped primary (it compared "z-ai/glm-5.2  # pinned" before).
      expect(readCascade(tmpDir).primaryDuplicatedAsRow0).toBe(true)
      const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
      expect(res.ok).toBe(true)
      const written = fs.readFileSync(configPath(), 'utf-8')
      expect(written).toContain('    key_env: OR_ALT  # alt key')
      expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }])
    })

    it('no default: key in the model block → a fallback: or auxiliary model is never taken for the primary; the write installs one', () => {
      const cfg = [
        'model:',
        '  provider: openrouter',
        '  fallback: moonshotai/kimi-k3',
        'auxiliary:',
        '  vision:',
        '    model: google/gemini-2.5-flash',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '',
      ].join('\n')
      fs.writeFileSync(configPath(), cfg)
      const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }], { who: 'scheduler' })
      expect(res.ok).toBe(true)
      expect(readModelConfig(tmpDir)[0]).toBe('z-ai/glm-5.3')
    })
  })
})

describe('applyCascadeToHarness — carryFrom (round-3 audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-writer-r3-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a rotation onto a model that is already a row keeps each row\'s own keys (carryFrom is looked up first)', () => {
    fs.writeFileSync(
      configPath(),
      [
        'model:',
        '  provider: openrouter',
        '  default: z-ai/glm-5.2',
        'fallback_providers:',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.2',
        '    key_env: OPENROUTER_KEY_B',
        '  - provider: openrouter',
        '    model: z-ai/glm-5.3',
        '    key_env: OPENROUTER_KEY_C',
        '',
      ].join('\n')
    )
    mockEnvVars.mockReturnValue(new Set(['OPENROUTER_KEY_B', 'OPENROUTER_KEY_C']))
    const res = applyCascadeToHarness(
      'h_test',
      [
        { provider: 'openrouter', model: 'z-ai/glm-5.3', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } },
        { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      ],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    const written = fs.readFileSync(configPath(), 'utf-8')
    expect(written).toContain(
      '  - provider: openrouter\n    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B\n  - provider: openrouter\n    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_C\n'
    )
  })

  it('carryFrom naming a row of ANOTHER provider is ignored: a credential never moves across providers, and the entry is validated on its own', () => {
    const cfg = ['fallback_providers:', '  - provider: openrouter', '    model: z-ai/glm-5.2', '    key_env: OPENROUTER_KEY_B', '    api_mode: chat_completions', ''].join('\n')
    fs.writeFileSync(configPath(), cfg)
    mockEnvVars.mockReturnValue(new Set(['OPENROUTER_KEY_B']))
    const res = applyCascadeToHarness(
      'h_test',
      [{ provider: 'anthropic', model: 'claude-sonnet-4-6', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.2' } }],
      { who: 'api' }
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(400)
      expect(res.error).toContain('anthropic')
    }
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(cfg)
  })
})

describe('applyCascadeToHarness — section terminator matches the readers (round-4 audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-r4-'))
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY_B']))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a digit-leading, dotted or quoted top-level key right after model: is a new section, not body to delete', () => {
    const file = ['model:', '  provider: anthropic', '  default: a', 'foo.bar: 1', '2fa: true', '"quoted key": 2', 'agent:', '  z: 1', ''].join('\n')
    fs.writeFileSync(configPath(), file)
    const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'a' }], { who: 'api' })
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(configPath(), 'utf-8')
    expect(out).toContain('foo.bar: 1\n')
    expect(out).toContain('2fa: true\n')
    expect(out).toContain('"quoted key": 2\n')
    expect(out).toContain('agent:\n  z: 1\n')
  })

  it('a column-0 key after the last (writer-managed) fallback_providers field survives, and the readers agree it ended the section', () => {
    const file = ['model:', '  provider: openrouter', '  default: m1', 'fallback_providers:', '  - provider: openrouter', '    model: m1', '2fa: true', 'agent:', '  z: 1', ''].join('\n')
    fs.writeFileSync(configPath(), file)
    expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'm1' }])
    const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'm2', carryFrom: { provider: 'openrouter', model: 'm1' } }], { who: 'api' })
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(configPath(), 'utf-8')
    expect(out).toBe(['model:', '  provider: openrouter', '  default: m2', 'fallback_providers:', '  - provider: openrouter', '    model: m2', '2fa: true', 'agent:', '  z: 1', ''].join('\n'))
    expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'm2' }])
  })

  it('a document-end marker (...) or a --- separator after model: is kept', () => {
    const file = ['model:', '  provider: anthropic', '  default: a', '...', ''].join('\n')
    fs.writeFileSync(configPath(), file)
    const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'a' }], { who: 'api', fallbackProviders: 'keep' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(file)
  })

  it('a column-0 list item still belongs to the fallback_providers body (readers and writer agree)', () => {
    const file = ['model:', '  provider: openrouter', '  default: m1', 'fallback_providers:', '- provider: openrouter', '  model: m1', '  key_env: OPENROUTER_KEY_B', 'agent:', '  z: 1', ''].join('\n')
    fs.writeFileSync(configPath(), file)
    expect(readFallbackProviders(tmpDir)).toEqual([{ provider: 'openrouter', model: 'm1' }])
    const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'm1' }], { who: 'api' })
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(configPath(), 'utf-8')
    expect(out).toBe(['model:', '  provider: openrouter', '  default: m1', 'fallback_providers:', '  - provider: openrouter', '    model: m1', '    key_env: OPENROUTER_KEY_B', 'agent:', '  z: 1', ''].join('\n'))
  })
})

// --- Chain semantics (fix for PR #243's wrong premise) ------------------------
// The runtime's cascade is primary = model: section, then fallback_providers
// rows in order; a row identical to the current (provider, model) is skipped.
// Both fleet conventions (primary repeated as row 0 / not repeated) are valid
// and must survive a save untouched.
describe('applyCascadeToHarness — chain semantics: primary = model:, fallbacks = fallback_providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-chain-'))
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  for (const [name, cfg] of Object.entries(FLEET_SHAPES)) {
    it(`a no-op save over ${name} is byte-identical (convention preserved)`, () => {
      fs.writeFileSync(configPath(), cfg)
      const chain = cascadeChain(readCascade(tmpDir))
      expect(chain.length).toBeGreaterThan(0)
      const res = applyCascadeToHarness('h_test', chain, { who: 'api', expected: chain })
      expect(res.ok).toBe(true)
      expect(fs.readFileSync(configPath(), 'utf-8')).toBe(cfg)
      if (res.ok) expect(res.written.chain).toEqual(chain)
    })
  }

  it('cyborg: reordering the fallbacks leaves model: alone and never adds a duplicate row', () => {
    fs.writeFileSync(configPath(), CYBORG)
    const chain = cascadeChain(readCascade(tmpDir))
    const reordered = [chain[0], chain[2], chain[1], chain[3], chain[4]]
    const res = applyCascadeToHarness('h_test', reordered, { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(configPath(), 'utf-8')
    expect(out).toBe(
      CYBORG.replace(
        '  - provider: anthropic\n    model: claude-sonnet-4-6\n  - provider: openrouter\n    model: anthropic/claude-sonnet-4.6\n',
        '  - provider: openrouter\n    model: anthropic/claude-sonnet-4.6\n  - provider: anthropic\n    model: claude-sonnet-4-6\n'
      )
    )
    expect(readCascade(tmpDir).primaryDuplicatedAsRow0).toBe(false)
    expect(cascadeChain(readCascade(tmpDir))).toEqual(reordered)
  })

  it('iris: promoting a fallback to primary swaps model.default and the row, keeps api_mode, adds no duplicate', () => {
    fs.writeFileSync(configPath(), IRIS)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', [chain[1], chain[0], chain[2]], { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      IRIS.replace('  default: z-ai/glm-5.3\n', '  default: moonshotai/kimi-k3\n').replace('    model: moonshotai/kimi-k3\n', '    model: z-ai/glm-5.3\n')
    )
  })

  it('cryptids: changing the primary rewrites model.default AND the duplicate row 0 together', () => {
    fs.writeFileSync(configPath(), CRYPTIDS)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.4' }, ...chain.slice(1)], { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(CRYPTIDS.replaceAll('z-ai/glm-5.3', 'z-ai/glm-5.4'))
    const after = readCascade(tmpDir)
    expect(after.primaryDuplicatedAsRow0).toBe(true)
    expect(after.fallbacks[0]).toEqual(after.primary)
  })

  it('cryptids: a rotation of the primary (carryFrom) keeps the duplicate row in sync, extras included', () => {
    fs.writeFileSync(configPath(), CRYPTIDS.replace('    model: z-ai/glm-5.3\n', '    model: z-ai/glm-5.3\n    key_env: OPENROUTER_KEY_B\n'))
    mockEnvVars.mockReturnValue(new Set(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_KEY_B']))
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness(
      'h_test',
      [{ provider: 'openrouter', model: 'z-ai/glm-5.4', carryFrom: { provider: 'openrouter', model: 'z-ai/glm-5.3' } }, ...chain.slice(1)],
      { who: 'scheduler' }
    )
    expect(res.ok).toBe(true)
    const out = fs.readFileSync(configPath(), 'utf-8')
    expect(out).toContain('  default: z-ai/glm-5.4\n')
    expect(out).toContain('fallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.4\n    key_env: OPENROUTER_KEY_B\n  - provider: anthropic')
    expect(out).not.toContain('z-ai/glm-5.3')
    // A duplicate row that no longer matched the primary after a rotation would be a bug.
    const after = readCascade(tmpDir)
    expect(after.primaryDuplicatedAsRow0).toBe(true)
    expect(after.fallbacks[0].model).toBe('z-ai/glm-5.4')
  })

  it('blackhouse: adding a fallback keeps the duplicate-only convention (row 0 stays the primary)', () => {
    fs.writeFileSync(configPath(), BLACKHOUSE)
    const chain = cascadeChain(readCascade(tmpDir))
    expect(chain).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
    const res = applyCascadeToHarness('h_test', [...chain, { provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      BLACKHOUSE.replace('    model: z-ai/glm-5.2\n', '    model: z-ai/glm-5.2\n  - provider: anthropic\n    model: claude-sonnet-4-6\n')
    )
  })

  it('matilde: the write result reports the chain and the raw rows separately', () => {
    fs.writeFileSync(configPath(), MATILDE)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', chain, { who: 'api' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.written.primary).toBe('moonshotai/kimi-k3')
      expect(res.written.models).toEqual(chain.map((e) => e.model))
      expect(res.written.chain).toEqual(chain)
      expect(res.written.fallbackProviders).toHaveLength(5)
      expect(res.written.fallbackProviders[0]).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
      expect(res.written.fallbackProviders[4]).toEqual({ provider: 'ollama', model: 'qwen3:30b', base_url: FLEET_OLLAMA_URL })
    }
  })

  it('`expected` is compared against the CHAIN (primary first), so a stale editor loses to a rotated primary', () => {
    fs.writeFileSync(configPath(), CYBORG)
    const chain = cascadeChain(readCascade(tmpDir))
    const stale = [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }, ...chain.slice(1)]
    const res = applyCascadeToHarness('h_test', stale, { who: 'api', expected: stale })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(CYBORG)
  })

  it('model.fallback is rewritten only when the file already has the key (the runtime never reads it)', () => {
    const withKey = 'model:\n  provider: openrouter\n  default: z-ai/glm-5.3\n  fallback:\n    - moonshotai/kimi-k3\nfallback_providers:\n  - provider: openrouter\n    model: moonshotai/kimi-k3\n'
    fs.writeFileSync(configPath(), withKey)
    const chain = cascadeChain(readCascade(tmpDir))
    expect(applyCascadeToHarness('h_test', chain, { who: 'api' }).ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(withKey)
    const res = applyCascadeToHarness('h_test', [...chain, { provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(
      'model:\n  provider: openrouter\n  default: z-ai/glm-5.3\n  fallback:\n    - moonshotai/kimi-k3\n    - claude-sonnet-4-6\nfallback_providers:\n  - provider: openrouter\n    model: moonshotai/kimi-k3\n  - provider: anthropic\n    model: claude-sonnet-4-6\n'
    )
  })

  it('a primary with no fallbacks over a file with no fallback_providers block appends nothing', () => {
    const bare = 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\nplatforms: {}\n'
    fs.writeFileSync(configPath(), bare)
    const res = applyCascadeToHarness('h_test', [{ provider: 'anthropic', model: 'claude-opus-4-8' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(bare.replace('claude-sonnet-4-6', 'claude-opus-4-8'))
  })
})

describe('applyCascadeToHarness — the hermes "new format" model: forms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-writer-newformat-'))
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']))
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  const SCALAR = 'model: z-ai/glm-5.3\nfallback_providers:\n  - provider: anthropic\n    model: claude-sonnet-4-6\nplatforms:\n  discord:\n    enabled: true\n'
  const MODEL_KEY = 'model:\n  provider: openrouter\n  model: z-ai/glm-5.3\nfallback_providers:\n  - provider: anthropic\n    model: claude-sonnet-4-6\n'

  it('scalar `model: <id>`: an untouched editor save (chain == expected) is byte-identical', () => {
    fs.writeFileSync(configPath(), SCALAR)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', chain, { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(SCALAR)
  })

  it('scalar `model: <id>`: rotating the primary keeps the scalar form', () => {
    fs.writeFileSync(configPath(), SCALAR)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', [{ ...chain[0], model: 'z-ai/glm-5.4' }, ...chain.slice(1)], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(SCALAR.replace('model: z-ai/glm-5.3', 'model: z-ai/glm-5.4'))
    expect(readCascade(tmpDir).primary).toEqual({ provider: '', model: 'z-ai/glm-5.4' })
  })

  it('scalar `model: <id>`: a primary that carries a provider upgrades the section to block form', () => {
    fs.writeFileSync(configPath(), SCALAR)
    const res = applyCascadeToHarness('h_test', [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, { provider: 'anthropic', model: 'claude-sonnet-4-6' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(SCALAR.replace('model: z-ai/glm-5.3\n', 'model:\n  provider: openrouter\n  default: z-ai/glm-5.3\n'))
  })

  it('model.model (no default): an untouched save is byte-identical — no `default:` is added', () => {
    fs.writeFileSync(configPath(), MODEL_KEY)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', chain, { who: 'api', expected: chain })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(MODEL_KEY)
  })

  it('model.model (no default): a rotation writes the new primary under the SAME key', () => {
    fs.writeFileSync(configPath(), MODEL_KEY)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', [{ ...chain[0], model: 'z-ai/glm-5.4' }, ...chain.slice(1)], { who: 'api' })
    expect(res.ok).toBe(true)
    const after = fs.readFileSync(configPath(), 'utf-8')
    expect(after).toBe(MODEL_KEY.replace('  model: z-ai/glm-5.3', '  model: z-ai/glm-5.4'))
    expect(after).not.toContain('default:')
  })

  it('model.model AND model.default: default is the managed key, model passes through verbatim', () => {
    const both = 'model:\n  provider: openrouter\n  model: moonshotai/kimi-k3\n  default: z-ai/glm-5.3\n'
    fs.writeFileSync(configPath(), both)
    const chain = cascadeChain(readCascade(tmpDir))
    const res = applyCascadeToHarness('h_test', [{ ...chain[0], model: 'z-ai/glm-5.4' }], { who: 'api' })
    expect(res.ok).toBe(true)
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe('model:\n  provider: openrouter\n  default: z-ai/glm-5.4\n  model: moonshotai/kimi-k3\n')
  })
})
