// @vitest-environment node
/**
 * readCascade — the cascade the way the runtime sees it: primary = model:
 * section, fallbacks = fallback_providers rows. Whether the file repeats the
 * primary as row 0 is a per-file convention the reader reports, never a
 * drift to warn about.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readCascade, cascadeChain } from '../harness'
import { CYBORG, MATILDE, CRYPTIDS, BLACKHOUSE, IRIS, OLLAMA_URL } from './fleet-shapes'

let dir = ''
const write = (content: string) => fs.writeFileSync(path.join(dir, 'config.yaml'), content)

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-read-cascade-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readCascade', () => {
  it('cyborg: primary from model:, four fallbacks, primary not duplicated', () => {
    write(CYBORG)
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(c.fallbacks).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
      { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash-0731' },
      { provider: 'ollama', model: 'qwen3.5:9b', base_url: OLLAMA_URL },
    ])
    expect(c.primaryDuplicatedAsRow0).toBe(false)
    // The chain the editor shows: primary first, then every fallback row.
    expect(cascadeChain(c).map((e) => e.model)).toEqual([
      'z-ai/glm-5.3', 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6', 'deepseek/deepseek-v4-flash-0731', 'qwen3.5:9b',
    ])
  })

  it('matilde: kimi-k3 is the primary and glm-5.3 is the FIRST FALLBACK — not a mismatch', () => {
    write(MATILDE)
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'openrouter', model: 'moonshotai/kimi-k3' })
    expect(c.fallbacks[0]).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(c.primaryDuplicatedAsRow0).toBe(false)
    expect(cascadeChain(c)).toHaveLength(6)
    expect(cascadeChain(c)[0].model).toBe('moonshotai/kimi-k3')
  })

  it('cryptids: the HSM-saved duplicate row 0 is reported as the convention and dropped from the chain', () => {
    write(CRYPTIDS)
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(c.fallbacks).toHaveLength(3)
    expect(c.primaryDuplicatedAsRow0).toBe(true)
    expect(cascadeChain(c)).toEqual([
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
    ])
  })

  it('blackhouse: duplicate only → a one-entry chain', () => {
    write(BLACKHOUSE)
    const c = readCascade(dir)
    expect(c.primaryDuplicatedAsRow0).toBe(true)
    expect(cascadeChain(c)).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
  })

  it('iris: passthrough keys under model: (api_mode) do not disturb the primary', () => {
    write(IRIS)
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(c.primaryDuplicatedAsRow0).toBe(false)
    expect(cascadeChain(c).map((e) => e.model)).toEqual(['z-ai/glm-5.3', 'moonshotai/kimi-k3', 'claude-sonnet-4-6'])
  })

  it('the duplicate match is provider case-insensitive and ignores a trailing comment on the value', () => {
    write('model:\n  provider: OpenRouter\n  default: z-ai/glm-5.3  # pinned\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.3\n')
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'OpenRouter', model: 'z-ai/glm-5.3' })
    expect(c.primaryDuplicatedAsRow0).toBe(true)
  })

  it('a row 0 with the same model under a different provider is NOT the duplicate', () => {
    write('model:\n  provider: zai\n  default: glm-5.3\nfallback_providers:\n  - provider: openrouter\n    model: glm-5.3\n')
    expect(readCascade(dir).primaryDuplicatedAsRow0).toBe(false)
  })

  it('model.base_url rides on the primary; a flow-form model block is read the same way', () => {
    write(`model: {provider: custom, default: qwen3:30b, base_url: "${OLLAMA_URL}"}\nfallback_providers: []\n`)
    const c = readCascade(dir)
    expect(c.primary).toEqual({ provider: 'custom', model: 'qwen3:30b', base_url: OLLAMA_URL })
    expect(c.fallbacks).toEqual([])
    expect(c.primaryDuplicatedAsRow0).toBe(false)
  })

  it('no default: key → primary null (a fallback: or auxiliary model is never promoted); chain = the rows', () => {
    write('model:\n  provider: anthropic\n  fallback: claude-haiku-4-5\nauxiliary:\n  vision:\n    model: gpt-4o\nfallback_providers:\n  - provider: anthropic\n    model: claude-sonnet-4-6\n')
    const c = readCascade(dir)
    expect(c.primary).toBeNull()
    expect(c.primaryDuplicatedAsRow0).toBe(false)
    expect(cascadeChain(c)).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
  })

  it('no config.yaml → empty cascade', () => {
    expect(readCascade(dir)).toEqual({ primary: null, fallbacks: [], primaryDuplicatedAsRow0: false })
    expect(cascadeChain(readCascade(dir))).toEqual([])
  })
})
