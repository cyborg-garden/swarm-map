// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getFleetAnalytics = vi.fn()
vi.mock('@/lib/services', () => ({
  services: { analytics: { getFleetAnalytics: (...a: unknown[]) => getFleetAnalytics(...a) } },
}))

import { GET } from './route'

const sample = { days: [], harnesses: [], costStatus: 'estimated', stale: false, pendingCount: 0 }

describe('GET /api/fleet/analytics', () => {
  beforeEach(() => { getFleetAnalytics.mockReset() })

  it('returns the fleet aggregate for the default 30-day window', async () => {
    getFleetAnalytics.mockReturnValue(sample)
    const res = await GET(new Request('http://localhost/api/fleet/analytics'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(sample)
    expect(getFleetAnalytics).toHaveBeenCalledWith(30)
  })

  it('clamps the days query', async () => {
    getFleetAnalytics.mockReturnValue(sample)
    await GET(new Request('http://localhost/api/fleet/analytics?days=90'))
    expect(getFleetAnalytics).toHaveBeenLastCalledWith(90)
    await GET(new Request('http://localhost/api/fleet/analytics?days=-4'))
    expect(getFleetAnalytics).toHaveBeenLastCalledWith(30)
  })

  it('500s with the error message when the service throws', async () => {
    getFleetAnalytics.mockImplementation(() => { throw new Error('boom') })
    const res = await GET(new Request('http://localhost/api/fleet/analytics'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('boom')
  })
})
