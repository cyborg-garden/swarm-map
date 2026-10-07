// @vitest-environment node
/**
 * Tests for POST /api/keys/:id/resync. The key store is real (tmp HOME + tmp
 * storage); only the harness restart is mocked. The property that matters:
 * only agents whose .env changed are recreated, and none other is touched.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

const { tmpHome, tmpStore, mockRestart } = await vi.hoisted(async () => {
  const fs = await import('fs')
  const path = await import('path')
  const os = await import('os')
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-resync-route-home-'))
  const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-map-resync-route-store-'))
  return { tmpHome, tmpStore, mockRestart: vi.fn() }
})

vi.mock('@/lib/services', async () => {
  const { Storage } = await import('@/lib/services/storage')
  const { AuditService } = await import('@/lib/services/audit')
  const { KeysService } = await import('@/lib/services/keys')
  const storage = new Storage(tmpStore)
  const audit = new AuditService(storage)
  return {
    services: {
      keys: new KeysService(storage, audit),
      harness: { restart: (id: string, mode: string) => mockRestart(id, mode) },
    },
  }
})

import { POST } from './route'
import { services } from '@/lib/services'

const CAP = 'CAP-0123456789abcdef0123456789abcdef'
const prevHome = process.env.HOME

function seed(p: string, body: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}
const call = (id: string, body?: unknown) =>
  POST(
    new Request('http://x/api/keys/' + id + '/resync', {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  )

describe('POST /api/keys/:id/resync', () => {
  let keyId: string
  beforeEach(() => {
    process.env.HOME = tmpHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
    fs.mkdirSync(tmpStore, { recursive: true })
    mockRestart.mockReset()
    seed(path.join(tmpHome, '.hermes', '.env'), 'CUSTOM_API_KEY=' + CAP + '\n')
    seed(path.join(tmpHome, '.hermes-nimbleco', '.env'), 'CAPSOLVER_API_KEY=' + CAP + '\n')
    keyId = services.keys.add({
      provider: 'custom', name: 'capsolver', envVar: 'CAPSOLVER_API_KEY', value: CAP,
      assignedTo: ['h_personal', 'h_nimbleco'],
    }).id
  })
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpStore, { recursive: true, force: true })
  })

  it('recreates only the agent whose .env changed', async () => {
    const res = await call(keyId, { harnesses: ['h_personal'] })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.changed).toEqual(['h_personal'])
    expect(json.recreated).toEqual(['h_personal'])
    expect(mockRestart).toHaveBeenCalledTimes(1)
    expect(mockRestart).toHaveBeenCalledWith('h_personal', 'recreate')
    expect(fs.readFileSync(path.join(tmpHome, '.hermes', '.env'), 'utf-8')).toMatch(/^CAPSOLVER_API_KEY=/m)
    expect(fs.existsSync(path.join(tmpHome, '.hermes-personal'))).toBe(false)
  })

  it('with no body resyncs every assigned agent, recreating nothing already correct', async () => {
    const json = await (await call(keyId)).json()
    expect(json.changed).toEqual(['h_personal'])
    expect(mockRestart).not.toHaveBeenCalledWith('h_nimbleco', expect.anything())
  })

  it('does not echo the key value', async () => {
    const text = await (await call(keyId)).text()
    expect(text).not.toContain(CAP)
  })

  it('400s on a malformed harness list and touches nothing', async () => {
    const res = await call(keyId, { harnesses: 'h_personal' })
    expect(res.status).toBe(400)
    expect(mockRestart).not.toHaveBeenCalled()
  })

  it('404s an unknown key', async () => {
    expect((await call('k_nope')).status).toBe(404)
  })
})
