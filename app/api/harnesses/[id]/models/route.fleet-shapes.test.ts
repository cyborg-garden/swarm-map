// @vitest-environment node
/**
 * PUT /api/harnesses/:id/models `{ fallback_providers }` over the REAL fleet
 * shapes (lib/services/__tests__/fleet-shapes.ts), on disk, with the real
 * readers — no mocked readCascade.
 *
 * The body names the file section it rewrites: the fallback_providers rows.
 * The primary (model:) is never touched by it. GET's `fallbackProviders` is
 * the raw block, so a GET → PUT round trip is a byte-identical no-op on every
 * shape. Before this suite the route took rows[0] as the primary, so the
 * round trip rewrote model.default to the first fallback on cyborg, matilde
 * and iris (3 of 5 fleet agents) and the real primary vanished from the file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

let tmpDir = ''

vi.mock('@/lib/services', () => ({
  services: {
    harness: {
      get: vi.fn((id: string) => (id === 'h_test' ? { id: 'h_test', name: 'test', serviceName: 'hermes-test' } : undefined)),
      updateConfig: vi.fn(),
    },
    audit: { append: vi.fn() },
  },
}))

vi.mock('@/lib/services/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/harness')>()),
  guessDataDir: vi.fn(() => tmpDir),
  readAgentEnvVarNames: vi.fn(() => new Set<string>(['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'])),
}))

import { GET, PUT } from './route'
import { readCascade, readFallbackProviders } from '@/lib/services/harness'
import { CYBORG, MATILDE, CRYPTIDS, IRIS, FLEET_SHAPES, OLLAMA_URL } from '@/lib/services/__tests__/fleet-shapes'

const params = { params: Promise.resolve({ id: 'h_test' }) }
const configPath = () => path.join(tmpDir, 'config.yaml')
const seed = (content: string) => fs.writeFileSync(configPath(), content)
const onDisk = () => fs.readFileSync(configPath(), 'utf-8')
const put = (body: unknown) =>
  PUT(new Request('http://localhost/api/harnesses/h_test/models', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params)
const get = async () => (await GET(new Request('http://localhost/api/harnesses/h_test/models'), params)).json()

beforeEach(() => {
  vi.clearAllMocks()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-models-route-fleet-'))
})
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

describe('PUT { fallback_providers } is fallback-only: the primary survives on every fleet shape', () => {
  it.each(Object.keys(FLEET_SHAPES))('%s: GET.fallbackProviders → PUT fallback_providers (+ expected) is a byte-identical no-op', async (name) => {
    seed(FLEET_SHAPES[name])
    const before = readCascade(tmpDir)
    const g = await get()
    const res = await put({ fallback_providers: g.fallbackProviders, expected_fallback_providers: g.fallbackProviders })
    expect(res.status).toBe(200)
    expect(onDisk()).toBe(FLEET_SHAPES[name])
    expect(readCascade(tmpDir).primary).toEqual(before.primary)
  })

  it('cyborg: reordering the rows keeps model.default = z-ai/glm-5.3 and writes exactly the rows sent', async () => {
    seed(CYBORG)
    const rows = readFallbackProviders(tmpDir)
    const reordered = [rows[1], rows[0], rows[2], rows[3]]
    const res = await put({ fallback_providers: reordered, expected_fallback_providers: rows })
    expect(res.status).toBe(200)
    const after = readCascade(tmpDir)
    expect(after.primary).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(after.fallbacks).toEqual(reordered)
    // The model: section is untouched, byte for byte.
    expect(onDisk().split('\n').slice(0, 4)).toEqual(CYBORG.split('\n').slice(0, 4))
    expect(onDisk()).not.toContain('default: claude-sonnet-4-6')
  })

  it('matilde: a pre-#244 tab that swaps two fallbacks does not demote kimi-k3', async () => {
    seed(MATILDE)
    const rows = readFallbackProviders(tmpDir)
    const body = [rows[1], rows[0], ...rows.slice(2)]
    const res = await put({ fallback_providers: body, expected_fallback_providers: rows })
    expect(res.status).toBe(200)
    expect(onDisk()).toContain('  default: moonshotai/kimi-k3\n')
    expect(onDisk()).not.toContain('default: z-ai/glm-5.3')
    expect(readCascade(tmpDir).primary!.model).toBe('moonshotai/kimi-k3')
    expect(readFallbackProviders(tmpDir)).toEqual(body)
    expect((await res.json()).chain[0].model).toBe('moonshotai/kimi-k3')
  })

  it('iris: the primary (with its api_mode) survives a raw-rows round trip with the rows reversed', async () => {
    seed(IRIS)
    const rows = readFallbackProviders(tmpDir)
    const res = await put({ fallback_providers: [rows[1], rows[0]], expected_fallback_providers: rows })
    expect(res.status).toBe(200)
    expect(onDisk()).toContain('model:\n  provider: openrouter\n  default: z-ai/glm-5.3\n  api_mode: chat\n')
    expect(readFallbackProviders(tmpDir)).toEqual([rows[1], rows[0]])
  })

  it('cryptids (primary duplicated as row 0): the primary keeps its row 0; a row equal to the primary is never written twice', async () => {
    seed(CRYPTIDS)
    const rows = readFallbackProviders(tmpDir)
    // An old tab "drags sonnet to the top" — it cannot change the primary through this body.
    const res = await put({ fallback_providers: [rows[1], rows[0], rows[2]], expected_fallback_providers: rows })
    expect(res.status).toBe(200)
    const after = readCascade(tmpDir)
    expect(after.primary).toEqual({ provider: 'openrouter', model: 'z-ai/glm-5.3' })
    expect(after.primaryDuplicatedAsRow0).toBe(true)
    expect(after.fallbacks).toEqual([
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL },
    ])
    expect((onDisk().match(/z-ai\/glm-5\.3/g) ?? []).length).toBe(2) // `default:` + the one duplicate row
  })

  it('a file with no primary at all → 409 pointing at { chain }, nothing written', async () => {
    const cfg = 'model:\n  provider: openrouter\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.2\n'
    seed(cfg)
    const res = await put({ fallback_providers: [{ provider: 'openrouter', model: 'moonshotai/kimi-k3' }] })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/chain/)
    expect(onDisk()).toBe(cfg)
  })

  it('a stale expected_fallback_providers is still refused with 409 before the primary is considered', async () => {
    seed(CYBORG)
    const rows = readFallbackProviders(tmpDir)
    const res = await put({ fallback_providers: rows, expected_fallback_providers: [rows[0]] })
    expect(res.status).toBe(409)
    expect(onDisk()).toBe(CYBORG)
  })
})
