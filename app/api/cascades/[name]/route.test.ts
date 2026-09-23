// @vitest-environment node
/**
 * Tests for GET/PUT/DELETE /api/cascades/:name.
 *
 * PUT accepts { name?: string (rename), chain?: [...] (replace chain) }.
 * Either or both; neither is a 400.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { tmpDir } = await vi.hoisted(async () => {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  return { tmpDir: fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-cascade-item-route-')) }
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

import { GET, PUT, DELETE } from './route'
import { services } from '@/lib/services'

const ENTRIES = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'anthropic', model: 'claude-haiku-4-5' },
]

function makeParams(name: string) {
  return { params: Promise.resolve({ name }) }
}
function req(method: string, body?: unknown): Request {
  return new Request('http://localhost/api/cascades/x', {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Cascades API — item', () => {
  beforeEach(() => {
    fs.rmSync(path.join(tmpDir, 'cascades.json'), { force: true })
    services.cascades.save({ name: 'fleet', chain: ENTRIES, sourceHarness: 'h_a' })
  })
  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET returns the record (case-insensitive) or 404', async () => {
    const ok = await GET(req('GET'), makeParams('FLEET'))
    expect(ok.status).toBe(200)
    expect((await ok.json()).name).toBe('fleet')

    const missing = await GET(req('GET'), makeParams('nope'))
    expect(missing.status).toBe(404)
  })

  it('PUT {chain} replaces the chain', async () => {
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const res = await PUT(req('PUT', { chain: next }), makeParams('fleet'))
    expect(res.status).toBe(200)
    expect((await res.json()).chain).toEqual(next)
    expect(services.cascades.get('fleet')?.chain).toEqual(next)
  })

  it('PUT {name} renames; the old name is gone', async () => {
    const res = await PUT(req('PUT', { name: 'fleet-v2' }), makeParams('fleet'))
    expect(res.status).toBe(200)
    expect((await res.json()).name).toBe('fleet-v2')
    expect(services.cascades.get('fleet')).toBeUndefined()
    expect(services.cascades.get('fleet-v2')?.chain).toEqual(ENTRIES)
  })

  it('PUT {name, chain} does both', async () => {
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const res = await PUT(req('PUT', { name: 'renamed', chain: next }), makeParams('fleet'))
    expect(res.status).toBe(200)
    const rec = await res.json()
    expect(rec.name).toBe('renamed')
    expect(rec.chain).toEqual(next)
    expect(services.cascades.list()).toHaveLength(1)
  })

  it('PUT rename onto an existing name is 409 and changes nothing', async () => {
    services.cascades.save({ name: 'other', chain: ENTRIES })
    const res = await PUT(req('PUT', { name: 'OTHER' }), makeParams('fleet'))
    expect(res.status).toBe(409)
    expect(services.cascades.get('fleet')).toBeDefined()
    expect(services.cascades.get('other')).toBeDefined()
  })

  it('PUT {name: conflicting, chain} is 409 and the chain are NOT replaced (atomic)', async () => {
    services.cascades.save({ name: 'other', chain: ENTRIES })
    const auditBefore = services.audit.query({ what: 'cascade:save' }).length
    const next = [{ provider: 'openai', model: 'gpt-5' }]
    const res = await PUT(req('PUT', { name: 'OTHER', chain: next }), makeParams('fleet'))
    expect(res.status).toBe(409)
    expect(services.cascades.get('fleet')?.chain).toEqual(ENTRIES)
    expect(services.cascades.get('other')?.chain).toEqual(ENTRIES)
    expect(services.audit.query({ what: 'cascade:save' })).toHaveLength(auditBefore)
  })

  it('PUT {name, chain: invalid} is 400 and the rename does NOT happen (atomic)', async () => {
    const res = await PUT(req('PUT', { name: 'renamed', chain: [{ provider: 'anthropic', model: '' }] }), makeParams('fleet'))
    expect(res.status).toBe(400)
    expect(services.cascades.get('fleet')?.chain).toEqual(ENTRIES)
    expect(services.cascades.get('renamed')).toBeUndefined()
  })

  it('PUT with neither name nor chain is 400; empty chain is 400; bad JSON is 400', async () => {
    expect((await PUT(req('PUT', {}), makeParams('fleet'))).status).toBe(400)
    expect((await PUT(req('PUT', { chain: [] }), makeParams('fleet'))).status).toBe(400)
    const bad = new Request('http://localhost/api/cascades/fleet', {
      method: 'PUT',
      body: '{nope',
      headers: { 'content-type': 'application/json' },
    })
    expect((await PUT(bad, makeParams('fleet'))).status).toBe(400)
    expect(services.cascades.get('fleet')?.chain).toEqual(ENTRIES)
  })

  it('PUT on a missing cascade is 404', async () => {
    const res = await PUT(req('PUT', { chain: ENTRIES }), makeParams('ghost'))
    expect(res.status).toBe(404)
  })

  it('DELETE removes the cascade, audits cascade:delete, 404 when missing', async () => {
    const res = await DELETE(req('DELETE'), makeParams('FLEET'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(services.cascades.get('fleet')).toBeUndefined()
    const log = services.audit.query({ what: 'cascade:delete' })
    expect(log[0].meta).toMatchObject({ name: 'fleet' })

    const again = await DELETE(req('DELETE'), makeParams('fleet'))
    expect(again.status).toBe(404)
  })
})
