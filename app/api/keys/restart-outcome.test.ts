// @vitest-environment node
/**
 * Adding, rotating, reassigning or deleting a key saves first and then
 * recreates the affected agents. The response says whether each recreate
 * started, so a client can tell "saved and applied" from "saved, not applied".
 * Runs the real KeysService against a temp home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const holder = vi.hoisted(() => ({ svc: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: holder.svc }))

import { POST } from './route'
import { PUT, DELETE } from './[id]/route'
import { KeysService } from '@/lib/services/keys'
import { Storage } from '@/lib/services/storage'
import { AuditService } from '@/lib/services/audit'

let home: string
let store: string
let prevHome: string | undefined
let keys: KeysService
let restart: ReturnType<typeof vi.fn>

const VALUE = 'test-value-0000000000000001'
const ROTATED = 'test-value-0000000000000002'
const json = (method: string, body: unknown) =>
  new Request('http://localhost/api/keys', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const envOf = () => fs.readFileSync(path.join(home, '.hermes-alpha', '.env'), 'utf-8')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-restart-home-'))
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-restart-store-'))
  prevHome = process.env.HOME
  process.env.HOME = home
  fs.mkdirSync(path.join(home, '.hermes-alpha'))
  fs.writeFileSync(path.join(home, '.hermes-alpha', '.env'), 'KEEP=1\n')
  const storage = new Storage(store)
  keys = new KeysService(storage, new AuditService(storage))
  restart = vi.fn()
  holder.svc.keys = keys
  holder.svc.harness = { get: (id: string) => (id === 'h_alpha' ? { id, name: 'alpha' } : undefined), restart }
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(store, { recursive: true, force: true })
})

const failRestarts = () => restart.mockImplementation(() => { throw new Error('compose file missing') })
const FAILED = [{ harnessId: 'h_alpha', ok: false, error: 'compose file missing' }]
const STARTED = [{ harnessId: 'h_alpha', ok: true }]

async function addKey() {
  const res = await POST(json('POST', { provider: 'openai', value: VALUE, assignedTo: ['h_alpha'] }))
  return { res, body: await res.json() }
}

describe('POST /api/keys', () => {
  it('reports a started restart', async () => {
    const { res, body } = await addKey()
    expect(res.status).toBe(201)
    expect(body.restarts).toEqual(STARTED)
  })

  it('still saves the key when the restart fails, and says the restart failed', async () => {
    failRestarts()
    const { res, body } = await addKey()
    expect(res.status).toBe(201)
    expect(body.provider).toBe('openai')
    expect(body.restarts).toEqual(FAILED)
    expect(envOf()).toContain(VALUE)
  })

  it('reports no restarts for a key assigned to nobody', async () => {
    const res = await POST(json('POST', { provider: 'openai', value: VALUE }))
    expect((await res.json()).restarts).toEqual([])
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('PUT /api/keys/:id', () => {
  it('reports a failed restart after a rotation that was saved', async () => {
    const { body: key } = await addKey()
    failRestarts()
    const res = await PUT(json('PUT', { value: ROTATED }), params(key.id))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.provider).toBe('openai')
    expect(body.restarts).toEqual(FAILED)
    expect(envOf()).toContain(ROTATED)
  })

  it('reports a failed restart after an assignment change', async () => {
    const { body: key } = await addKey()
    failRestarts()
    const res = await PUT(json('PUT', { assignedTo: [] }), params(key.id))
    expect((await res.json()).restarts).toEqual(FAILED)
  })

  it('reports no restarts for a metadata-only edit', async () => {
    const { body: key } = await addKey()
    restart.mockClear()
    const res = await PUT(json('PUT', { budgetUsd: 20 }), params(key.id))
    const body = await res.json()
    expect(body.budgetUsd).toBe(20)
    expect(body.restarts).toEqual([])
    expect(restart).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/keys/:id', () => {
  it('reports a failed restart after the key is removed', async () => {
    const { body: key } = await addKey()
    failRestarts()
    const res = await DELETE(json('DELETE', {}), params(key.id))
    expect(await res.json()).toEqual({ ok: true, restarts: FAILED })
    expect(envOf()).not.toContain(VALUE)
  })
})
