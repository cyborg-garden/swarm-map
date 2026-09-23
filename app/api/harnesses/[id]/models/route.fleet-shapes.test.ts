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
import { CYBORG, MATILDE, CRYPTIDS, IRIS, P2, FLEET_SHAPES, OLLAMA_URL } from '@/lib/services/__tests__/fleet-shapes'

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

describe('PUT { chain } on a file with rows but no primary: promoting a fallback is an opt-in, never an accident (review round 2)', () => {
  const NO_PRIMARY = 'model:\n  provider: openrouter\nfallback_providers:\n  - provider: openrouter\n    model: z-ai/glm-5.2\n  - provider: openrouter\n    model: moonshotai/kimi-k3\n'

  it('GET reports primaryEntry null and the chain is the rows alone', async () => {
    seed(NO_PRIMARY)
    const g = await get()
    expect(g.primaryEntry).toBeNull()
    expect(g.chain.map((r: { model: string }) => r.model)).toEqual(['z-ai/glm-5.2', 'moonshotai/kimi-k3'])
  })

  it('a { chain } save without set_primary → 409 no-primary-in-file, file untouched (same refusal as the scheduler / manual apply)', async () => {
    seed(NO_PRIMARY)
    const g = await get()
    const res = await put({ chain: [g.chain[1], g.chain[0]], expected_chain: g.chain })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/^no-primary-in-file: /)
    expect(onDisk()).toBe(NO_PRIMARY)
    expect(readCascade(tmpDir).primary).toBeNull()
  })

  it('with set_primary: true the operator opts in: chain[0] is written to model.default and the rest are the rows', async () => {
    seed(NO_PRIMARY)
    const g = await get()
    const res = await put({ chain: [g.chain[1], g.chain[0]], expected_chain: g.chain, set_primary: true })
    expect(res.status).toBe(200)
    const after = readCascade(tmpDir)
    expect(after.primary).toEqual({ provider: 'openrouter', model: 'moonshotai/kimi-k3' })
    expect(after.fallbacks).toEqual([{ provider: 'openrouter', model: 'z-ai/glm-5.2' }])
    expect(after.primaryDuplicatedAsRow0).toBe(false)
  })

  it('a file with NO model section and no rows (fresh agent) takes a { chain } without the opt-in — nothing is promoted', async () => {
    seed('platforms:\n  discord:\n    enabled: true\n')
    const res = await put({ chain: [{ provider: 'anthropic', model: 'claude-sonnet-4-6' }] })
    expect(res.status).toBe(200)
    expect(readCascade(tmpDir).primary).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' })
  })
})

describe('P2: scalar model: with root provider / base_url siblings, through the route', () => {
  it('GET chain[0] carries the root provider and base_url; a GET → PUT { chain } round trip is byte-identical', async () => {
    seed(P2)
    const g = await get()
    expect(g.primaryEntry).toEqual({ provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL })
    expect(g.chain[0]).toEqual({ provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL })
    expect(g.provider).toBe('ollama')
    const res = await put({ chain: g.chain, expected_chain: g.chain })
    expect(res.status).toBe(200)
    expect(onDisk()).toBe(P2)
  })

  it('promoting the anthropic fallback over the ollama primary leaves no root base_url behind and keeps the ollama row', async () => {
    seed(P2)
    const g = await get()
    const res = await put({ chain: [g.chain[1], g.chain[0]], expected_chain: g.chain })
    expect(res.status).toBe(200)
    const after = onDisk()
    expect(after).not.toMatch(/^(base_url|provider|api_base):/m)
    expect(after.startsWith('model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')).toBe(true)
    expect(readCascade(tmpDir).fallbacks).toEqual([{ provider: 'ollama', model: 'qwen3:30b', base_url: OLLAMA_URL }])
  })
})

describe('PUT { fallback_providers }: a row equal to the primary is never written as a fallback', () => {
  it('cyborg (primary not duplicated): a body row equal to model.default is dropped, the file does not flip to the duplicate convention', async () => {
    seed(CYBORG)
    const rows = readFallbackProviders(tmpDir)
    const res = await put({ fallback_providers: [{ provider: 'openrouter', model: 'z-ai/glm-5.3' }, ...rows], expected_fallback_providers: rows })
    expect(res.status).toBe(200)
    expect(onDisk()).toBe(CYBORG)
    expect(readCascade(tmpDir).primaryDuplicatedAsRow0).toBe(false)
  })
})
