// @vitest-environment node
/**
 * GET /api/harnesses/:id/analytics?days=N — thin wrapper over the analytics
 * service. The contract that matters: a pending harness (migrated, no
 * snapshot) is reported as `pending: true`, never as a zero series; `days` is
 * clamped server-side; an unknown harness is a 404.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const getHarnessAnalytics = vi.fn()
vi.mock('@/lib/services', () => ({
  services: { analytics: { getHarnessAnalytics: (...a: unknown[]) => getHarnessAnalytics(...a) } },
}))

import { GET } from './route'

function call(id: string, query = '') {
  const req = new Request(`http://localhost/api/harnesses/${id}/analytics${query}`)
  return GET(req, { params: Promise.resolve({ id }) })
}

const sample = {
  harnessId: 'h_iris', days: [{ date: '2026-09-22', cost: 1.5, tokens: 10, sessions: 1, toolCalls: 2, byModel: {}, bySource: { cli: 1 } }],
  topTools: [], topUsers: [], costStatus: 'estimated', stale: false,
}

describe('GET /api/harnesses/:id/analytics', () => {
  beforeEach(() => { getHarnessAnalytics.mockReset() })

  it('returns the service result with the default 30-day window', async () => {
    getHarnessAnalytics.mockReturnValue(sample)
    const res = await call('h_iris')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(sample)
    expect(getHarnessAnalytics).toHaveBeenCalledWith('h_iris', 30)
  })

  it('passes a valid days query through and clamps bad ones', async () => {
    getHarnessAnalytics.mockReturnValue(sample)
    await call('h_iris', '?days=7')
    expect(getHarnessAnalytics).toHaveBeenLastCalledWith('h_iris', 7)
    await call('h_iris', '?days=abc')
    expect(getHarnessAnalytics).toHaveBeenLastCalledWith('h_iris', 30)
    await call('h_iris', '?days=0')
    expect(getHarnessAnalytics).toHaveBeenLastCalledWith('h_iris', 30)
    await call('h_iris', '?days=99999')
    expect(getHarnessAnalytics).toHaveBeenLastCalledWith('h_iris', 365)
  })

  it('reports a pending harness as pending, not as a zero series', async () => {
    getHarnessAnalytics.mockReturnValue(null)
    const res = await call('h_iris')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ harnessId: 'h_iris', pending: true })
    expect(body.days).toBeUndefined()
  })

  it('404s for an unknown harness', async () => {
    getHarnessAnalytics.mockImplementation(() => { throw new Error('harness not found: h_nope') })
    const res = await call('h_nope')
    expect(res.status).toBe(404)
    expect((await res.json()).error).toMatch(/not found/)
  })

  it('500s on any other service failure', async () => {
    getHarnessAnalytics.mockImplementation(() => { throw new Error('disk on fire') })
    const res = await call('h_iris')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('disk on fire')
  })
})
