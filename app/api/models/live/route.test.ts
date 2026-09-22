// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const fetchLiveModels = vi.fn()
vi.mock('@/lib/services', () => ({
  services: { modelFreshness: { fetchLiveModels: (...a: unknown[]) => fetchLiveModels(...a) } },
}))

import { GET } from './route'

const req = (qs: string) => new Request(`http://localhost/api/models/live${qs}`)

describe('GET /api/models/live', () => {
  beforeEach(() => fetchLiveModels.mockReset())

  it('400 on a missing or unknown provider', async () => {
    expect((await GET(req(''))).status).toBe(400)
    expect((await GET(req('?provider=ollama'))).status).toBe(400)
    expect(fetchLiveModels).not.toHaveBeenCalled()
  })

  it('returns {provider, fetchedAt, models} from the freshness service', async () => {
    fetchLiveModels.mockResolvedValue({ provider: 'openrouter', fetchedAt: 123, models: [{ id: 'z-ai/glm-5.3' }] })
    const res = await GET(req('?provider=openrouter'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ provider: 'openrouter', fetchedAt: 123, models: [{ id: 'z-ai/glm-5.3' }] })
    expect(fetchLiveModels).toHaveBeenCalledWith('openrouter', { force: false })
  })

  it('204 when there is no live information (fail-soft)', async () => {
    fetchLiveModels.mockResolvedValue(null)
    const res = await GET(req('?provider=anthropic'))
    expect(res.status).toBe(204)
  })

  it('force=1 bypasses the cache', async () => {
    fetchLiveModels.mockResolvedValue({ provider: 'zai', fetchedAt: 1, models: [] })
    await GET(req('?provider=zai&force=1'))
    expect(fetchLiveModels).toHaveBeenCalledWith('zai', { force: true })
  })
})
