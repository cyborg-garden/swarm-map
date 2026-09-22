// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readModelConfig, readModelProvider, readFallbackProviders } from '../harness'
import fs from 'fs'
import path from 'path'
import os from 'os'

describe('readModelConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when config.yaml does not exist', () => {
    expect(readModelConfig(tmpDir)).toEqual([])
  })

  it('parses primary model from config.yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\n`
    )
    const models = readModelConfig(tmpDir)
    expect(models).toContain('anthropic/claude-opus-4.7')
    expect(models[0]).toBe('anthropic/claude-opus-4.7')
  })

  it('parses fallback model when present', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\n  fallback: anthropic/claude-haiku-4.5\n`
    )
    const models = readModelConfig(tmpDir)
    expect(models[0]).toBe('anthropic/claude-opus-4.7')
    expect(models[1]).toBe('anthropic/claude-haiku-4.5')
  })

  it('handles quoted values', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: anthropic\n  default: "claude-opus-4-5"\n`
    )
    const models = readModelConfig(tmpDir)
    expect(models[0]).toBe('claude-opus-4-5')
  })

  it('ignores auxiliary model: lines with empty values', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\n\nauxiliary:\n  vision:\n    provider: auto\n    model: ""\n`
    )
    const models = readModelConfig(tmpDir)
    // Empty model value should not be included
    expect(models).not.toContain('')
    expect(models[0]).toBe('anthropic/claude-opus-4.7')
  })

  it('captures non-empty auxiliary models', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\n\nauxiliary:\n  vision:\n    provider: auto\n    model: google/gemini-2.5-pro\n`
    )
    const models = readModelConfig(tmpDir)
    expect(models).toContain('google/gemini-2.5-pro')
    expect(models[0]).toBe('anthropic/claude-opus-4.7')
  })
})

describe('readModelProvider', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-provider-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty string when config.yaml does not exist', () => {
    expect(readModelProvider(tmpDir)).toBe('')
  })

  it('parses provider from config.yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: openrouter\n  default: anthropic/claude-opus-4.7\n`
    )
    expect(readModelProvider(tmpDir)).toBe('openrouter')
  })

  it('handles anthropic provider', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      `model:\n  provider: anthropic\n  default: claude-opus-4-5\n`
    )
    expect(readModelProvider(tmpDir)).toBe('anthropic')
  })
})

describe('readFallbackProviders', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-providers-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns correct array from config with fallback_providers', () => {
    const config = `model:
  provider: anthropic
  default: claude-sonnet-4-5-20250929
  fallback:
    - gemini-2.5-flash

fallback_providers:
  - provider: anthropic
    model: claude-sonnet-4-5-20250929
  - provider: custom
    model: gemini-2.5-flash
    base_url: http://vertex-proxy:8080/v1
  - provider: ollama
    model: qwen3:30b
    base_url: http://host.docker.internal:11434/v1
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
      { provider: 'custom', model: 'gemini-2.5-flash', base_url: 'http://vertex-proxy:8080/v1' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
    ])
  })

  it('returns empty array when config has no fallback_providers', () => {
    const config = `model:
  provider: anthropic
  default: claude-sonnet-4-5
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([])
  })

  it('returns empty array when config.yaml does not exist', () => {
    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([])
  })

  it('filters out entries missing provider or model', () => {
    const config = `fallback_providers:
  - provider: anthropic
    model: claude-sonnet-4-5
  - provider: ollama
  - model: some-model
  - provider: openrouter
    model: gpt-4
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'openrouter', model: 'gpt-4' },
    ])
  })

  // Re-audit: the reader's rows go straight into GET/PUT /api/harnesses/:id/models
  // responses and the editor echoes them back as expected_fallback_providers.
  // An inline api_key must never leave the file through this reader.
  it('never returns an inline api_key (it reaches the browser otherwise)', () => {
    const config = `fallback_providers:
  - provider: anthropic
    model: claude-sonnet-4-5
    api_key: sk-ant-secret
  - {provider: custom, model: proxy, base_url: http://p:1/v1, api_key: sk-inline-flow}
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      { provider: 'custom', model: 'proxy', base_url: 'http://p:1/v1' },
    ])
    expect(JSON.stringify(result)).not.toContain('sk-')
  })

  // Issue #149 — Trigger B. Hermes' own writer and hand edits both produce
  // shapes the line parser did not recognise, so the editor saw [] and seeded
  // every row from the OLD primary's provider (dropping ollama's base_url).
  it('parses flow-style list items `- {provider: ..., model: ..., base_url: ...}`', () => {
    const config = `model:
  provider: anthropic
  default: claude-sonnet-4-6

fallback_providers:
  - {provider: anthropic, model: claude-sonnet-4-6}
  - { provider: ollama, model: qwen3:30b, base_url: http://host.docker.internal:11434/v1 }
  - {provider: "custom", model: 'gemini-2.5-flash', base_url: "http://vertex-proxy:8080/v1"}
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    expect(readFallbackProviders(tmpDir)).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
      { provider: 'custom', model: 'gemini-2.5-flash', base_url: 'http://vertex-proxy:8080/v1' },
    ])
  })

  it('accepts a section header with a trailing comment', () => {
    const config = `model:
  provider: anthropic
  default: claude-sonnet-4-6

fallback_providers:  # ordered; first entry is primary
  - provider: anthropic
    model: claude-sonnet-4-6
  - provider: ollama
    model: qwen3:30b
    base_url: http://host.docker.internal:11434/v1
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    expect(readFallbackProviders(tmpDir)).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
    ])
  })

  it('stops reading fallback_providers when a new top-level key appears', () => {
    const config = `fallback_providers:
  - provider: anthropic
    model: claude-sonnet-4-5

auxiliary:
  tool_use:
    model: claude-haiku
`
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), config)

    const result = readFallbackProviders(tmpDir)
    expect(result).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-5' },
    ])
  })
})
