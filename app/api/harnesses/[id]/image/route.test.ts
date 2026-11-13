// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/services', () => ({
  services: { harness: { get: vi.fn((id: string) => ({ id })), imageStatus: vi.fn(), setAgentImage: vi.fn() } },
}))
import { GET, PUT } from './route'
import { services } from '@/lib/services'

const params = (id: string) => ({ params: Promise.resolve({ id }) })
const req = (body: unknown) => new Request('http://x/api/harnesses/h_a/image', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('GET /api/harnesses/:id/image', () => {
  beforeEach(() => vi.clearAllMocks())
  it('returns the version status', async () => {
    ;(services.harness.imageStatus as any).mockResolvedValue({ current: 'local-build', updateAvailable: true })
    const res = await GET(new Request('http://x'), params('h_a'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ updateAvailable: true })
  })
  it('404s on unknown harness', async () => {
    ;(services.harness.imageStatus as any).mockRejectedValue(new Error('Harness h_x not found'))
    expect((await GET(new Request('http://x'), params('h_x'))).status).toBe(404)
  })
})

describe('PUT /api/harnesses/:id/image', () => {
  beforeEach(() => vi.clearAllMocks())
  it('requires imageRef', async () => {
    const res = await PUT(req({}), params('h_a'))
    expect(res.status).toBe(400)
    expect(services.harness.setAgentImage).not.toHaveBeenCalled()
  })
  it('pins + recreates with the trimmed ref', async () => {
    ;(services.harness.setAgentImage as any).mockResolvedValue({ ok: true, ref: 'ghcr.io/x:1', digest: 'sha256:a' })
    const res = await PUT(req({ imageRef: '  ghcr.io/x:1 ' }), params('h_a'))
    expect(res.status).toBe(200)
    expect(services.harness.setAgentImage).toHaveBeenCalledWith('h_a', 'ghcr.io/x:1')
  })
  it('maps unknown harness to 404', async () => {
    ;(services.harness.setAgentImage as any).mockRejectedValue(new Error('Harness h_x not found'))
    expect((await PUT(req({ imageRef: 'x:1' }), params('h_x'))).status).toBe(404)
  })
})
