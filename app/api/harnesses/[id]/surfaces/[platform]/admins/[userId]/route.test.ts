/**
 * Tests for the is-admin check route the swarm_map_policy plugin calls.
 * GET /api/harnesses/:id/surfaces/:platform/admins/:userId → { is_admin }
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET } from './route'

vi.mock('@/lib/services', () => ({
  services: { surfaceAdmins: { isAdmin: vi.fn() } },
}))

import { services } from '@/lib/services'
const isAdmin = services.surfaceAdmins.isAdmin as ReturnType<typeof vi.fn>

function makeParams(id: string, platform: string, userId: string) {
  return { params: Promise.resolve({ id, platform, userId }) }
}

beforeEach(() => vi.clearAllMocks())

describe('GET is-admin', () => {
  it('returns { is_admin: true } (200) when the service says so', async () => {
    isAdmin.mockReturnValue(true)
    const res = await GET(new Request('http://x'), makeParams('h_sentinel', 'signal', '+64111'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ is_admin: true })
    expect(isAdmin).toHaveBeenCalledWith('h_sentinel', 'signal', '+64111')
  })

  it('returns { is_admin: false } (200, fail-closed) for a non-admin', async () => {
    isAdmin.mockReturnValue(false)
    const res = await GET(new Request('http://x'), makeParams('h_sentinel', 'signal', '+64999'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ is_admin: false })
  })

  it('URL-decodes the userId before checking', async () => {
    isAdmin.mockReturnValue(true)
    // A UUID has no reserved chars, but a "+64…" phone arrives percent-encoded.
    await GET(new Request('http://x'), makeParams('h_sentinel', 'signal', '%2B64111'))
    expect(isAdmin).toHaveBeenCalledWith('h_sentinel', 'signal', '+64111')
  })
})
