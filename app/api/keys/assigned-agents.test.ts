// @vitest-environment node
/**
 * POST /api/keys and PUT /api/keys/:id take the agents a key is assigned to
 * in the request body. Each one is resolved to a listed agent before the key
 * is stored or any .env is written. Runs the real KeysService against a temp
 * home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const holder = vi.hoisted(() => ({ svc: {} as Record<string, unknown> }))
vi.mock('@/lib/services', () => ({ services: holder.svc }))

import { POST } from './route'
import { PUT } from './[id]/route'
import { KeysService } from '@/lib/services/keys'
import { Storage } from '@/lib/services/storage'
import { AuditService } from '@/lib/services/audit'

let home: string
let store: string
let prevHome: string | undefined
let keys: KeysService
let restart: ReturnType<typeof vi.fn>

const VALUE = 'test-value-0000000000000001'
const NOT_LISTED = ['h_real-agent', 'real-agent', 'h_REAL_AGENT', 'h_nobody']
const MALFORMED = ['../outside', 'x/../.hermes-real-agent', 'h_real_agent/', 'a/b', 42, null, { id: 'h_real_agent' }]

const envOf = (dir: string) => fs.readFileSync(path.join(home, dir, '.env'), 'utf-8')
const listing = () => fs.readdirSync(home).sort()
const json = (method: string, body: unknown) =>
  new Request('http://localhost/api/keys', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })
const openaiKeys = () => keys.list().filter((k) => k.provider === 'openai')

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-agents-home-'))
  store = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-agents-store-'))
  prevHome = process.env.HOME
  process.env.HOME = home
  for (const dir of ['.hermes-real-agent', '.hermes-dormant']) {
    fs.mkdirSync(path.join(home, dir))
    fs.writeFileSync(path.join(home, dir, '.env'), 'KEEP=1\n')
  }
  const storage = new Storage(store)
  keys = new KeysService(storage, new AuditService(storage))
  restart = vi.fn()
  holder.svc.keys = keys
  // One listed agent. `.hermes-dormant` is a directory with no listed agent.
  holder.svc.harness = { get: (id: string) => (id === 'h_real_agent' ? { id, name: 'real-agent' } : undefined), restart }
})
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(store, { recursive: true, force: true })
})

function expectUntouched(label: string) {
  expect(listing(), label).toEqual(['.hermes-dormant', '.hermes-real-agent'])
  expect(envOf('.hermes-real-agent'), label).toBe('KEEP=1\n')
  expect(envOf('.hermes-dormant'), label).toBe('KEEP=1\n')
  expect(restart, label).not.toHaveBeenCalled()
}

describe('POST /api/keys', () => {
  it.each(NOT_LISTED)('answers 404 for %s, stores no key and writes no .env', async (id) => {
    const res = await POST(json('POST', { provider: 'openai', value: VALUE, assignedTo: ['h_real_agent', id] }))
    expect(res.status).toBe(404)
    expect(openaiKeys()).toEqual([])
    expectUntouched(id)
  })

  it('answers 400 for a malformed entry, stores no key and writes no .env', async () => {
    for (const bad of MALFORMED) {
      const res = await POST(json('POST', { provider: 'openai', value: VALUE, assignedTo: ['h_real_agent', bad] }))
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect(openaiKeys(), JSON.stringify(bad)).toEqual([])
      expectUntouched(JSON.stringify(bad))
    }
    for (const notAList of ['h_real_agent', 5, { 0: 'h_real_agent' }]) {
      const res = await POST(json('POST', { provider: 'openai', value: VALUE, assignedTo: notAList }))
      expect(res.status, JSON.stringify(notAList)).toBe(400)
      expect(openaiKeys(), JSON.stringify(notAList)).toEqual([])
      expectUntouched(JSON.stringify(notAList))
    }
  })

  it('writes the key to a listed agent', async () => {
    const res = await POST(json('POST', { provider: 'openai', value: VALUE, assignedTo: ['h_real_agent'] }))
    expect(res.status).toBe(201)
    expect(envOf('.hermes-real-agent')).toContain(`OPENAI_API_KEY=${VALUE}`)
    expect(restart).toHaveBeenCalledWith('h_real_agent', 'recreate')
    expect(listing()).toEqual(['.hermes-dormant', '.hermes-real-agent'])
  })

  it('stores a key with no assignment', async () => {
    const res = await POST(json('POST', { provider: 'openai', value: VALUE }))
    expect(res.status).toBe(201)
    expectUntouched('unassigned')
  })
})

describe('PUT /api/keys/:id', () => {
  let keyId: string
  beforeEach(() => {
    keyId = keys.add({ provider: 'openai', value: VALUE, assignedTo: [] }).id
  })
  const assignedTo = () => keys.list().find((k) => k.id === keyId)?.assignedTo

  it.each(NOT_LISTED)('answers 404 for a new assignment to %s and changes nothing', async (id) => {
    const res = await PUT(json('PUT', { assignedTo: ['h_real_agent', id] }), params(keyId))
    expect(res.status).toBe(404)
    expect(assignedTo()).toEqual([])
    expectUntouched(id)
  })

  it('answers 400 for a malformed entry and changes nothing, with or without a new value', async () => {
    for (const bad of MALFORMED) {
      for (const extra of [{}, { value: 'test-value-0000000000000002' }]) {
        const res = await PUT(json('PUT', { ...extra, assignedTo: [bad] }), params(keyId))
        expect(res.status, JSON.stringify(bad)).toBe(400)
        expect(keys.getDecryptedValue(keyId), JSON.stringify(bad)).toBe(VALUE)
        expect(assignedTo(), JSON.stringify(bad)).toEqual([])
        expectUntouched(JSON.stringify(bad))
      }
    }
  })

  it('answers 404 when a rotation names an agent that is not listed, and keeps the old value', async () => {
    const res = await PUT(json('PUT', { value: 'test-value-0000000000000002', assignedTo: ['h_nobody'] }), params(keyId))
    expect(res.status).toBe(404)
    expect(keys.getDecryptedValue(keyId)).toBe(VALUE)
    expectUntouched('rotation')
  })

  it('assigns the key to a listed agent', async () => {
    const res = await PUT(json('PUT', { assignedTo: ['h_real_agent'] }), params(keyId))
    expect(res.status).toBe(200)
    expect(assignedTo()).toEqual(['h_real_agent'])
    expect(envOf('.hermes-real-agent')).toContain(`OPENAI_API_KEY=${VALUE}`)
  })

  it('keeps an assignment the key already holds, even to an agent that is no longer listed', async () => {
    keys.setAssignment(keyId, ['h_dormant'])
    const res = await PUT(json('PUT', { assignedTo: ['h_dormant', 'h_real_agent'] }), params(keyId))
    expect(res.status).toBe(200)
    expect(assignedTo()).toEqual(['h_dormant', 'h_real_agent'])
    // …and it can still be removed.
    const res2 = await PUT(json('PUT', { assignedTo: ['h_real_agent'] }), params(keyId))
    expect(res2.status).toBe(200)
    expect(envOf('.hermes-dormant')).not.toContain('OPENAI_API_KEY')
  })
})
