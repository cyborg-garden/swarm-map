// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockHarness } = vi.hoisted(() => ({
  mockHarness: { listRetired: vi.fn(), list: vi.fn() },
}))
vi.mock('@/lib/services', () => ({ services: { harness: mockHarness } }))

import { GET } from './route'

describe('GET /api/harnesses/retired', () => {
  beforeEach(() => {
    mockHarness.listRetired.mockReset()
    mockHarness.list.mockReset()
  })

  it('returns the labelled rows and never runs container discovery', async () => {
    const rows = [{ id: 'h_old', name: 'old', runtime: 'letta', reason: 'retired', note: 'Retired runtime' }]
    mockHarness.listRetired.mockReturnValue(rows)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(rows)
    expect(mockHarness.list).not.toHaveBeenCalled()
  })

  it('returns an empty list when there are none', async () => {
    mockHarness.listRetired.mockReturnValue([])
    expect(await (await GET()).json()).toEqual([])
  })

  it('reports a storage failure as a 500 with an empty list, like GET /api/harnesses', async () => {
    mockHarness.listRetired.mockImplementation(() => {
      throw new Error('disk gone')
    })
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'disk gone', retired: [] })
  })
})
