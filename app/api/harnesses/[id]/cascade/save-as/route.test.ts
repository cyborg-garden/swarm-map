// @vitest-environment node
/**
 * Tests for POST /api/harnesses/:id/cascade/save-as — snapshot a harness's
 * current cascade (primary from model:, then the fallback_providers rows)
 * into the named cascade library.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { tmpDir, agentDir, mockGet } = await vi.hoisted(async () => {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-saveas-route-'))
  const agentDir = path.join(tmpDir, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  return {
    tmpDir,
    agentDir,
    mockGet: vi.fn((id: string) =>
      id === 'h_test' ? { id: 'h_test', name: 'test', serviceName: 'hermes-test' } : undefined
    ),
  }
})

vi.mock('@/lib/services', async () => {
  const { Storage } = await import('@/lib/services/storage')
  const { AuditService } = await import('@/lib/services/audit')
  const { CascadeLibraryService } = await import('@/lib/services/cascades')
  const storage = new Storage(tmpDir)
  const audit = new AuditService(storage)
  return {
    services: {
      storage,
      audit,
      cascades: new CascadeLibraryService(storage, audit),
      harness: { get: (id: string) => mockGet(id), restart: vi.fn(), updateConfig: vi.fn() },
    },
  }
})

vi.mock('@/lib/services/harness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/harness')>(
    '@/lib/services/harness'
  )
  return { ...actual, guessDataDir: vi.fn(() => agentDir) }
})

import { POST } from './route'
import { services } from '@/lib/services'

const configPath = path.join(agentDir, 'config.yaml')

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}
function post(body: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_test/cascade/save-as', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Harness cascade save-as', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fs.rmSync(path.join(tmpDir, 'cascades.json'), { force: true })
    fs.writeFileSync(
      configPath,
      [
        'model:',
        '  provider: anthropic',
        '  default: claude-sonnet-4-6',
        'fallback_providers:',
        '  - provider: anthropic',
        '    model: claude-sonnet-4-6',
        '    api_key: sk-ant-SECRET-IN-CONFIG',
        '  - provider: ollama',
        '    model: qwen3:30b',
        '    base_url: http://host.docker.internal:11434/v1',
        '',
      ].join('\n')
    )
  })
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('snapshots the current fallback_providers into the library (201), stripping api_key', async () => {
    const res = await POST(post({ name: 'from-test' }), makeParams('h_test'))
    expect(res.status).toBe(201)
    const rec = await res.json()
    expect(rec.name).toBe('from-test')
    expect(rec.sourceHarness).toBe('h_test')
    expect(rec.chain).toEqual([
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
    ])
    expect(JSON.stringify(rec)).not.toContain('SECRET')
    expect(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8')).not.toContain('SECRET')
    expect(services.cascades.get('from-test')).toBeDefined()
  })

  it('409 on an existing name unless overwrite:true', async () => {
    services.cascades.save({ name: 'from-test', chain: [{ provider: 'openai', model: 'gpt-5' }] })
    expect((await POST(post({ name: 'from-test' }), makeParams('h_test'))).status).toBe(409)
    expect(services.cascades.get('from-test')?.chain[0].provider).toBe('openai')

    const ow = await POST(post({ name: 'from-test', overwrite: true }), makeParams('h_test'))
    expect(ow.status).toBe(201)
    expect(services.cascades.get('from-test')?.chain[0].provider).toBe('anthropic')
  })

  it('a bare primary (no fallback_providers) is a one-entry chain and saves', async () => {
    fs.writeFileSync(configPath, 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')
    const res = await POST(post({ name: 'bare' }), makeParams('h_test'))
    expect(res.status).toBe(201)
    expect((await res.json()).chain).toEqual([{ provider: 'anthropic', model: 'claude-sonnet-4-6' }])
  })

  it('the snapshot starts with the primary even when the file does not repeat it as row 0 (cyborg-shaped)', async () => {
    fs.writeFileSync(
      configPath,
      ['model:', '  provider: openrouter', '  default: z-ai/glm-5.3', 'fallback_providers:', '  - provider: anthropic', '    model: claude-sonnet-4-6', ''].join('\n')
    )
    const res = await POST(post({ name: 'cyborg' }), makeParams('h_test'))
    expect(res.status).toBe(201)
    expect((await res.json()).chain).toEqual([
      { provider: 'openrouter', model: 'z-ai/glm-5.3' },
      { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    ])
  })

  it('400 when the harness has neither a primary nor fallback_providers', async () => {
    fs.writeFileSync(configPath, 'platforms: {}\n')
    const res = await POST(post({ name: 'empty' }), makeParams('h_test'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/no model cascade/i)
    expect(services.cascades.list()).toEqual([])
  })

  it('400 on a missing/invalid name; 404 on an unknown harness', async () => {
    expect((await POST(post({}), makeParams('h_test'))).status).toBe(400)
    expect((await POST(post({ name: '   ' }), makeParams('h_test'))).status).toBe(400)
    expect((await POST(post({ name: 'x' }), makeParams('h_missing'))).status).toBe(404)
    expect(services.cascades.list()).toEqual([])
  })
})
