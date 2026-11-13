// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/services', () => ({
  services: { harness: { get: vi.fn((id: string) => ({ id })), reapplyUseCaseTemplate: vi.fn() } },
}))

import { POST } from './route'
import { services } from '@/lib/services'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}
function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_test/usecase/reapply', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('POST /api/harnesses/:id/usecase/reapply', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passes templateId through and returns the service result', async () => {
    ;(services.harness.reapplyUseCaseTemplate as any).mockResolvedValue({
      ok: true, serviceName: 'hermes-matilde', results: [], pluginsEnabled: ['matilde'], restarted: true,
    })
    const res = await POST(makeRequest({ templateId: 'matilde' }), makeParams('h_matilde'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, pluginsEnabled: ['matilde'], restarted: true })
    expect(services.harness.reapplyUseCaseTemplate).toHaveBeenCalledWith('h_matilde', 'matilde')
  })

  it('returns 400 when templateId is missing', async () => {
    const res = await POST(makeRequest({}), makeParams('h_matilde'))
    expect(res.status).toBe(400)
    expect(services.harness.reapplyUseCaseTemplate).not.toHaveBeenCalled()
  })

  it('maps a not-found error to 404', async () => {
    ;(services.harness.reapplyUseCaseTemplate as any).mockRejectedValue(new Error('Harness h_x not found'))
    const res = await POST(makeRequest({ templateId: 'matilde' }), makeParams('h_x'))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/not found/i) })
  })

  it('maps an unknown-template error to 400', async () => {
    ;(services.harness.reapplyUseCaseTemplate as any).mockRejectedValue(new Error('Unknown use-case template "nope"'))
    const res = await POST(makeRequest({ templateId: 'nope' }), makeParams('h_matilde'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/unknown use-case template/i) })
  })

  it('maps an unexpected error to 500', async () => {
    ;(services.harness.reapplyUseCaseTemplate as any).mockRejectedValue(new Error('disk exploded'))
    const res = await POST(makeRequest({ templateId: 'matilde' }), makeParams('h_matilde'))
    expect(res.status).toBe(500)
  })
})
