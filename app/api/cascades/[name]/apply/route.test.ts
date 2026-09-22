// @vitest-environment node
/**
 * Tests for POST /api/cascades/:name/apply — port a saved cascade onto a harness.
 *
 * The single most important property: applying a cascade whose provider has
 * no credential on the target harness must 400 with the validation message,
 * write NOTHING to config.yaml, and NEVER restart the agent. The writer is
 * real (config.yaml in a tmpdir); only harness lookup / .env names are mocked.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { tmpDir, agentDir, mockEnvVars, mockRestart, mockGet } = await vi.hoisted(async () => {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-apply-route-'))
  const agentDir = path.join(tmpDir, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  return {
    tmpDir,
    agentDir,
    mockEnvVars: vi.fn(() => new Set<string>(['ANTHROPIC_API_KEY'])),
    mockRestart: vi.fn(),
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
      harness: {
        get: (id: string) => mockGet(id),
        restart: (id: string, mode: string) => mockRestart(id, mode),
        updateConfig: vi.fn(),
      },
    },
  }
})

vi.mock('@/lib/services/harness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/harness')>(
    '@/lib/services/harness'
  )
  return {
    ...actual,
    guessDataDir: vi.fn(() => agentDir),
    readAgentEnvVarNames: vi.fn(() => mockEnvVars()),
  }
})

import { POST } from './route'
import { services } from '@/lib/services'
import { readFallbackProviders } from '@/lib/services/harness'

const configPath = path.join(agentDir, 'config.yaml')
const GOOD = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
]
const NEEDS_OPENROUTER = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
]

function makeParams(name: string) {
  return { params: Promise.resolve({ name }) }
}
function post(body: unknown): Request {
  return new Request('http://localhost/api/cascades/x/apply', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Cascades API — apply', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnvVars.mockReturnValue(new Set<string>(['ANTHROPIC_API_KEY']))
    fs.rmSync(path.join(tmpDir, 'cascades.json'), { force: true })
    fs.rmSync(path.join(tmpDir, 'audit.jsonl'), { force: true })
    fs.rmSync(configPath, { force: true })
    services.cascades.save({ name: 'good', entries: GOOD })
    services.cascades.save({ name: 'needs-openrouter', entries: NEEDS_OPENROUTER })
  })
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // THE property.
  it('400s with the validation message, writes nothing and never restarts when the harness lacks the provider key', async () => {
    fs.writeFileSync(configPath, 'model:\n  provider: anthropic\n  default: claude-sonnet-4-6\n')
    const before = fs.readFileSync(configPath, 'utf-8')

    const res = await POST(post({ harnessId: 'h_test' }), makeParams('needs-openrouter'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/^Invalid model cascade:/)
    expect(json.error).toContain('openrouter')
    expect(json.error).toContain('moonshotai/kimi-k2.7-code')

    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before)
    expect(services.harness.updateConfig).not.toHaveBeenCalled()
    expect(mockRestart).not.toHaveBeenCalled()
    expect(services.audit.query({ what: 'cascade:apply' })).toEqual([])
  })

  it('happy path: writes config.yaml, audits cascade:apply, and quick-restarts the harness', async () => {
    const res = await POST(post({ harnessId: 'h_test' }), makeParams('GOOD'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toMatchObject({
      ok: true,
      name: 'good',
      harness: 'h_test',
      restarted: true,
      applied: { provider: 'anthropic', primary: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6', 'claude-haiku-4-5'] },
    })
    expect(readFallbackProviders(agentDir)).toEqual(GOOD)
    expect(services.harness.updateConfig).toHaveBeenCalledWith('h_test', {
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    })
    expect(mockRestart).toHaveBeenCalledTimes(1)
    expect(mockRestart).toHaveBeenCalledWith('h_test', 'quick')

    const log = services.audit.query({ what: 'cascade:apply' })
    expect(log).toHaveLength(1)
    expect(log[0].who).toBe('api')
    expect(log[0].target).toBe('h_test')
    expect(log[0].meta).toMatchObject({ name: 'good', harness: 'h_test' })
  })

  it('restart:false writes but does not restart', async () => {
    const res = await POST(post({ harnessId: 'h_test', restart: false }), makeParams('good'))
    expect(res.status).toBe(200)
    expect((await res.json()).restarted).toBe(false)
    expect(fs.existsSync(configPath)).toBe(true)
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it('a restart failure after a successful write is reported, not hidden (still 200)', async () => {
    mockRestart.mockImplementationOnce(() => {
      throw new Error('no compose file')
    })
    const res = await POST(post({ harnessId: 'h_test' }), makeParams('good'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.restarted).toBe(false)
    expect(json.restartError).toBe('no compose file')
    expect(readFallbackProviders(agentDir)).toEqual(GOOD)
  })

  it('404 for an unknown cascade; 404 for an unknown harness; neither writes or restarts', async () => {
    expect((await POST(post({ harnessId: 'h_test' }), makeParams('ghost'))).status).toBe(404)
    expect((await POST(post({ harnessId: 'h_missing' }), makeParams('good'))).status).toBe(404)
    expect(fs.existsSync(configPath)).toBe(false)
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it('400 when harnessId is missing or the body is not JSON', async () => {
    expect((await POST(post({}), makeParams('good'))).status).toBe(400)
    const bad = new Request('http://localhost/api/cascades/good/apply', {
      method: 'POST',
      body: '{nope',
      headers: { 'content-type': 'application/json' },
    })
    expect((await POST(bad, makeParams('good'))).status).toBe(400)
    expect(fs.existsSync(configPath)).toBe(false)
    expect(mockRestart).not.toHaveBeenCalled()
  })
})
