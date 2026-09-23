// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Storage } from '../storage'
import {
  ModelFreshnessService,
  cacheFileFor,
  parseOpenRouterModels,
  parseAnthropicModels,
  parseZaiModels,
  OPENROUTER_MODELS_URL,
  ANTHROPIC_MODELS_URL,
  ZAI_MODELS_URL,
} from '../model-freshness'
import type { Key } from '@/lib/types'

let dir: string
let storage: Storage
let now = 1_000_000_000_000

const keyRow = (provider: string, id = `k_${provider}`): Key => ({ id, provider, maskedValue: '••••', assignedTo: [], health: 'good' })

function keys(rows: Key[], values: Record<string, string> = {}) {
  return {
    list: vi.fn(() => rows),
    getDecryptedValue: vi.fn((id: string) => values[id]),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const OR_BODY = {
  data: [
    { id: 'z-ai/glm-5.3', canonical_slug: 'z-ai/glm-5.3-20260816', created: 1787086655, expiration_date: null, pricing: { prompt: '0.00000091', completion: '0.00000286' } },
    { id: 'deepseek/deepseek-v3.2', canonical_slug: 'deepseek/deepseek-v3.2-20251201', created: 1764594642, expiration_date: '2026-09-28', pricing: { prompt: '0.000000269', completion: '0.0000004' } },
    { id: '~z-ai/glm-latest', canonical_slug: '~z-ai/glm-latest', created: 1787100000, alias_target: { slug: 'z-ai/glm-5.3' } },
  ],
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-model-freshness-'))
  storage = new Storage(dir)
  now = 1_000_000_000_000
  delete process.env.MODEL_LIST_TTL_MS
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  delete process.env.MODEL_LIST_TTL_MS
})

function svc(fetchImpl: typeof fetch, k = keys([])) {
  return new ModelFreshnessService(storage, k, { fetchImpl, now: () => now })
}

describe('parsers', () => {
  it('OpenRouter rows → LiveModel with numeric pricing, canonical, expiration', () => {
    const rows = parseOpenRouterModels(OR_BODY)!
    expect(rows[0]).toEqual({
      id: 'z-ai/glm-5.3',
      canonical: 'z-ai/glm-5.3-20260816',
      created: 1787086655,
      expiration: null,
      pricing: { prompt: 0.00000091, completion: 0.00000286 },
    })
    expect(rows[1].expiration).toBe('2026-09-28')
    expect(rows[2].id).toBe('~z-ai/glm-latest')
  })

  it('Anthropic rows → created from created_at; no pricing', () => {
    const rows = parseAnthropicModels({ data: [{ id: 'claude-sonnet-4-6', created_at: '2026-02-17T00:00:00Z', display_name: 'Claude Sonnet 4.6', type: 'model' }] })!
    expect(rows[0]).toEqual({ id: 'claude-sonnet-4-6', created: Date.parse('2026-02-17T00:00:00Z') / 1000, expiration: null, pricing: null })
  })

  it('Z.ai accepts data[] or models[] and returns null for anything else', () => {
    expect(parseZaiModels({ data: [{ id: 'glm-5.2' }] })![0].id).toBe('glm-5.2')
    expect(parseZaiModels({ models: [{ id: 'glm-5.3', created: 5 }] })![0]).toEqual({ id: 'glm-5.3', expiration: null, pricing: null, created: 5 })
    expect(parseZaiModels({ error: 'nope' })).toBeNull()
    expect(parseZaiModels('garbage')).toBeNull()
  })
})

describe('fetchLiveModels', () => {
  it('OpenRouter needs no key: fetches, parses, caches to model-lists/openrouter.json', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OR_BODY)) as unknown as typeof fetch
    const list = await svc(fetchImpl).fetchLiveModels('openrouter')
    expect(list?.models.map((m) => m.id)).toEqual(['z-ai/glm-5.3', 'deepseek/deepseek-v3.2', '~z-ai/glm-latest'])
    expect(list?.fetchedAt).toBe(now)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(OPENROUTER_MODELS_URL)
    expect(fs.existsSync(path.join(dir, cacheFileFor('openrouter')))).toBe(true)
  })

  it('cache hit within TTL: no network call', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OR_BODY)) as unknown as typeof fetch
    const s = svc(fetchImpl)
    await s.fetchLiveModels('openrouter')
    now += 30 * 60 * 1000 // 30 min later, TTL 1h
    const again = await s.fetchLiveModels('openrouter')
    expect(again?.models).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('TTL expiry refetches (env MODEL_LIST_TTL_MS honoured)', async () => {
    process.env.MODEL_LIST_TTL_MS = '1000'
    const fetchImpl = vi.fn(async () => jsonResponse(OR_BODY)) as unknown as typeof fetch
    const s = svc(fetchImpl)
    await s.fetchLiveModels('openrouter')
    now += 1001
    await s.fetchLiveModels('openrouter')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('force bypasses the cache', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(OR_BODY)) as unknown as typeof fetch
    const s = svc(fetchImpl)
    await s.fetchLiveModels('openrouter')
    await s.fetchLiveModels('openrouter', { force: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('non-200 → null, nothing cached', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch
    expect(await svc(fetchImpl).fetchLiveModels('openrouter')).toBeNull()
    expect(fs.existsSync(path.join(dir, cacheFileFor('openrouter')))).toBe(false)
  })

  it('network error → null', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await svc(fetchImpl).fetchLiveModels('openrouter')).toBeNull()
  })

  it('unparseable body → null', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nope: true })) as unknown as typeof fetch
    expect(await svc(fetchImpl).fetchLiveModels('openrouter')).toBeNull()
  })

  it('Anthropic with no key → null and NO network call', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    expect(await svc(fetchImpl, keys([keyRow('openai')])).fetchLiveModels('anthropic')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('Anthropic sends x-api-key + anthropic-version and follows pagination', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes('after_id=claude-a')) {
        return jsonResponse({ data: [{ id: 'claude-b', created_at: '2026-01-02T00:00:00Z' }], has_more: false })
      }
      return jsonResponse({ data: [{ id: 'claude-a', created_at: '2026-01-01T00:00:00Z' }], has_more: true, last_id: 'claude-a' })
    }) as unknown as typeof fetch
    const k = keys([keyRow('anthropic')], { k_anthropic: 'sk-ant-api03-secret' })
    const list = await svc(fetchImpl, k).fetchLiveModels('anthropic')
    expect(list?.models.map((m) => m.id)).toEqual(['claude-a', 'claude-b'])
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(2)
    expect(String(calls[0][0]).startsWith(ANTHROPIC_MODELS_URL)).toBe(true)
    const headers = (calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-api03-secret')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    // the key never lands on disk
    expect(fs.readFileSync(path.join(dir, cacheFileFor('anthropic')), 'utf-8')).not.toContain('sk-ant-api03-secret')
  })

  it('Anthropic: skips an OAuth/Bearer token key (ANTHROPIC_TOKEN) and sends the first real API key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'claude-a' }], has_more: false })) as unknown as typeof fetch
    const k = keys([keyRow('anthropic', 'k_tok'), keyRow('anthropic', 'k_api')], {
      k_tok: 'sk-ant-oat01-token-secret',
      k_api: 'sk-ant-api03-real-secret',
    })
    const list = await svc(fetchImpl, k).fetchLiveModels('anthropic')
    expect(list?.models.map((m) => m.id)).toEqual(['claude-a'])
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls).toHaveLength(1)
    const headers = (calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-api03-real-secret')
  })

  it('Anthropic: only token keys configured → null, no request made', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] })) as unknown as typeof fetch
    const k = keys([keyRow('anthropic', 'k_tok'), keyRow('anthropic', 'k_cc')], { k_tok: 'sk-ant-oat01-x', k_cc: 'cc-y' })
    expect(await svc(fetchImpl, k).fetchLiveModels('anthropic')).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('Z.ai sends a Bearer key and fails soft on an unexpected shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ result: 'weird' })) as unknown as typeof fetch
    const k = keys([keyRow('zai')], { k_zai: 'glm-secret' })
    expect(await svc(fetchImpl, k).fetchLiveModels('zai')).toBeNull()
    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect(calls[0][0]).toBe(ZAI_MODELS_URL)
    expect(((calls[0][1] as RequestInit).headers as Record<string, string>).authorization).toBe('Bearer glm-secret')
  })
})

describe('isRetired', () => {
  const s = () => svc(vi.fn() as unknown as typeof fetch)
  const live = { provider: 'openrouter' as const, fetchedAt: 0, models: parseOpenRouterModels(OR_BODY)! }

  it('absent from the live list → retired', () => {
    expect(s().isRetired('z-ai/glm-5.2', live, '2026-09-22')).toBe(true)
  })
  it('present and unexpired → not retired', () => {
    expect(s().isRetired('z-ai/glm-5.3', live, '2026-09-22')).toBe(false)
  })
  it('expiration before today → retired; on/after today → not yet', () => {
    expect(s().isRetired('deepseek/deepseek-v3.2', live, '2026-09-22')).toBe(false)
    expect(s().isRetired('deepseek/deepseek-v3.2', live, '2026-09-29')).toBe(true)
  })
  it('no live list → never retired (fail-soft)', () => {
    expect(s().isRetired('anything', null)).toBe(false)
  })
})
