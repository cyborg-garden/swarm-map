// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/services', () => ({
  services: { harness: { syncArtifacts: vi.fn() }, keys: { list: vi.fn(), setAssignment: vi.fn() } },
}))

import { POST } from './route'
import { services } from '@/lib/services'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}
function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_test/artifacts/sync', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/harnesses/:id/artifacts/sync', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes dryRun/force through and returns the service result', async () => {
    ;(services.harness.syncArtifacts as any).mockReturnValue({
      ok: true, serviceName: 'hermes-test', dryRun: true, results: [], pluginsEnabled: [], restarted: false,
    })
    const res = await POST(makeRequest({ dryRun: true, force: true }), makeParams('h_test'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true })
    expect(services.harness.syncArtifacts).toHaveBeenCalledWith('h_test', expect.objectContaining({ dryRun: true, force: true }))
  })

  it('defaults dryRun/force to false on empty body', async () => {
    ;(services.harness.syncArtifacts as any).mockReturnValue({ ok: true })
    await POST(new Request('http://localhost/x', { method: 'POST' }), makeParams('h_test'))
    expect(services.harness.syncArtifacts).toHaveBeenCalledWith('h_test', expect.objectContaining({ dryRun: false, force: false, includeVision: false }))
  })

  it('passes surface/packs through and hands over the key store by default', async () => {
    ;(services.harness.syncArtifacts as any).mockReturnValue({ ok: true })
    await POST(makeRequest({ surface: 'public', packs: ['community-member'] }), makeParams('h_test'))
    expect(services.harness.syncArtifacts).toHaveBeenCalledWith('h_test', expect.objectContaining({
      surface: 'public', packs: ['community-member'], keys: services.keys,
    }))
  })

  it('assignKeys:false applies without touching the key store', async () => {
    ;(services.harness.syncArtifacts as any).mockReturnValue({ ok: true })
    await POST(makeRequest({ assignKeys: false }), makeParams('h_test'))
    expect((services.harness.syncArtifacts as any).mock.calls[0][1].keys).toBeUndefined()
  })

  it('maps a refused pack/surface to 400', async () => {
    ;(services.harness.syncArtifacts as any).mockImplementation(() => { throw new Error('Pack "browser-ops" is not allowed on a public surface') })
    const res = await POST(makeRequest({ surface: 'public', packs: ['browser-ops'] }), makeParams('h_test'))
    expect(res.status).toBe(400)
  })

  it('maps a not-found error to 404', async () => {
    ;(services.harness.syncArtifacts as any).mockImplementation(() => { throw new Error('Harness h_x not found') })
    const res = await POST(makeRequest({}), makeParams('h_x'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) })
  })

  it('maps an unexpected error to 500', async () => {
    ;(services.harness.syncArtifacts as any).mockImplementation(() => { throw new Error('disk exploded') })
    const res = await POST(makeRequest({}), makeParams('h_test'))
    expect(res.status).toBe(500)
  })
})
