// @vitest-environment node
/**
 * Tests for GET/POST /api/cascades — the named cascade library collection.
 *
 * services.cascades is a REAL CascadeLibraryService over a tmpdir so the
 * route's status mapping is exercised against real service behaviour
 * (409 conflict, 400 invalid) rather than a stub that agrees with itself.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { tmpDir } = await vi.hoisted(async () => {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  return { tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascades-route-')) }
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
      harness: { get: vi.fn(), restart: vi.fn(), updateConfig: vi.fn() },
    },
  }
})

import { GET, POST } from './route'
import { services } from '@/lib/services'

const ENTRIES = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'ollama', model: 'qwen3:30b', base_url: 'http://host.docker.internal:11434/v1' },
]

function post(body: unknown, raw = false): Request {
  return new Request('http://localhost/api/cascades', {
    method: 'POST',
    body: raw ? (body as string) : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Cascades API — collection', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmpDir, 'cascades.json'), { force: true })
  })
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET returns an empty list initially', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST creates a cascade (201) and GET lists it', async () => {
    const res = await POST(post({ name: 'fleet', entries: ENTRIES, sourceHarness: 'h_a' }))
    expect(res.status).toBe(201)
    const rec = await res.json()
    expect(rec.name).toBe('fleet')
    expect(rec.entries).toEqual(ENTRIES)
    expect(rec.sourceHarness).toBe('h_a')

    const list = await (await GET()).json()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('fleet')
  })

  it('POST with an existing name is 409 unless overwrite:true', async () => {
    await POST(post({ name: 'fleet', entries: ENTRIES }))
    const dup = await POST(post({ name: 'FLEET', entries: ENTRIES }))
    expect(dup.status).toBe(409)
    expect((await dup.json()).error).toMatch(/already exists/)

    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const ow = await POST(post({ name: 'FLEET', entries: next, overwrite: true }))
    expect(ow.status).toBe(201)
    expect((await ow.json()).entries).toEqual(next)
    expect(await (await GET()).json()).toHaveLength(1)
  })

  it('POST rejects an invalid body (400): bad JSON, missing name, empty entries', async () => {
    expect((await POST(post('{not json', true))).status).toBe(400)
    expect((await POST(post({ entries: ENTRIES }))).status).toBe(400)
    expect((await POST(post({ name: 'x', entries: [] }))).status).toBe(400)
    expect(await (await GET()).json()).toEqual([])
  })

  it('POST never stores api_key', async () => {
    const res = await POST(
      post({ name: 'leak', entries: [{ provider: 'anthropic', model: 'm', api_key: 'sk-ant-SECRET' }] })
    )
    expect(res.status).toBe(201)
    expect(JSON.stringify(await res.json())).not.toContain('SECRET')
    expect(fs.readFileSync(path.join(tmpDir, 'cascades.json'), 'utf-8')).not.toContain('SECRET')
  })

  it('POST audits cascade:save', async () => {
    await POST(post({ name: 'fleet', entries: ENTRIES, sourceHarness: 'h_a' }))
    const log = services.audit.query({ what: 'cascade:save' })
    expect(log.length).toBeGreaterThanOrEqual(1)
    expect(log[0].meta).toMatchObject({ name: 'fleet', harness: 'h_a' })
  })
})
