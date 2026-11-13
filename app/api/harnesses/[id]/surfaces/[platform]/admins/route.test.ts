/**
 * Tests for the surface admin list/set routes.
 *
 * GET /api/harnesses/:id/surfaces/:platform/admins
 * PUT /api/harnesses/:id/surfaces/:platform/admins   body: { admins, actor }
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, PUT } from './route'

vi.mock('@/lib/services', () => ({
  services: {
    surfaceAdmins: {
      listAdmins: vi.fn(),
      setAdmins: vi.fn(),
    },
    harness: { restart: vi.fn() },
  },
}))

import { services } from '@/lib/services'

const listAdmins = services.surfaceAdmins.listAdmins as ReturnType<typeof vi.fn>
const setAdmins = services.surfaceAdmins.setAdmins as ReturnType<typeof vi.fn>

function makeParams(id: string, platform: string) {
  return { params: Promise.resolve({ id, platform }) }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET admins', () => {
  it('returns the admin list from the service', async () => {
    listAdmins.mockReturnValue({ platform: 'signal', admins: ['+64111'], source: 'allowlist', allowAllDm: false })
    const res = await GET(new Request('http://x'), makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ platform: 'signal', admins: ['+64111'], source: 'allowlist', allowAllDm: false })
    expect(listAdmins).toHaveBeenCalledWith('h_seraph', 'signal')
  })

  it('returns 400 for an unsupported platform', async () => {
    const res = await GET(new Request('http://x'), makeParams('h_seraph', 'whatsapp'))
    expect(res.status).toBe(400)
    expect(listAdmins).not.toHaveBeenCalled()
  })
})

describe('PUT admins', () => {
  it('200 + persisted list when the service authorizes', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph', admins: ['+64222'] })
    const req = new Request('http://x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admins: ['+64222'], actor: '+64111' }),
    })
    const res = await PUT(req, makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, admins: ['+64222'] })
    expect(setAdmins).toHaveBeenCalledWith('h_seraph', 'signal', ['+64222'], '+64111')
  })

  const putDiscord = () => PUT(new Request('http://x', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ admins: ['100000000000000001'], actor: '100000000000000001' }),
  }), makeParams('h_seraph', 'discord'))

  it('recreates the container when the .env changed, so the running bot gets the new DM list', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph', admins: ['100000000000000001'], dmEnvUpdated: true })
    const res = await putDiscord()
    expect(res.status).toBe(200)
    expect(services.harness.restart).toHaveBeenCalledWith('h_seraph', 'recreate')
    expect(await res.json()).toMatchObject({ success: true, restarted: true })
  })

  it('recreates the agent the service resolved, not the id in the URL', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph_doer', admins: ['100000000000000001'], dmEnvUpdated: true })
    await PUT(new Request('http://x', {
      method: 'PUT',
      body: JSON.stringify({ admins: ['100000000000000001'], actor: '100000000000000001' }),
    }), makeParams('seraph-doer', 'discord'))
    expect(services.harness.restart).toHaveBeenCalledTimes(1)
    expect(services.harness.restart).toHaveBeenCalledWith('h_seraph_doer', 'recreate')
  })

  it('404 and no recreate when the service knows no such agent', async () => {
    setAdmins.mockReturnValue({ ok: false, status: 404, error: 'Unknown agent' })
    const res = await putDiscord()
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Unknown agent' })
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('does not recreate when only the overlay changed', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph', admins: ['100000000000000001'] })
    await putDiscord()
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('still answers 200 when no container exists to recreate', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph', admins: ['100000000000000001'], dmEnvUpdated: true })
    vi.mocked(services.harness.restart).mockImplementationOnce(() => { throw new Error('no compose') })
    const res = await putDiscord()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ restarted: false })
  })

  it('passes a DM list warning on to the caller instead of reporting a clean save', async () => {
    setAdmins.mockReturnValue({ ok: true, harnessId: 'h_seraph', admins: ['100000000000000001'], dmEnvWarning: 'DM list not updated' })
    const res = await putDiscord()
    expect(await res.json()).toMatchObject({ success: true, warning: 'DM list not updated' })
    expect(services.harness.restart).not.toHaveBeenCalled()
  })

  it('403 when the service rejects a non-admin actor (self-escalation guard)', async () => {
    setAdmins.mockReturnValue({ ok: false, status: 403, error: 'actor is not an admin for this surface' })
    const req = new Request('http://x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admins: ['+64999'], actor: '+64999' }),
    })
    const res = await PUT(req, makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(403)
  })

  it('400 for malformed identities (service result)', async () => {
    setAdmins.mockReturnValue({ ok: false, status: 400, error: 'Invalid signal identity: bad' })
    const req = new Request('http://x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admins: ['bad'], actor: '+64111' }),
    })
    const res = await PUT(req, makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(400)
  })

  it('400 for invalid JSON body', async () => {
    const req = new Request('http://x', { method: 'PUT', body: 'not json' })
    const res = await PUT(req, makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(400)
    expect(setAdmins).not.toHaveBeenCalled()
  })

  it('passes an empty actor through to the service (which rejects it)', async () => {
    setAdmins.mockReturnValue({ ok: false, status: 400, error: 'actor is required' })
    const req = new Request('http://x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admins: ['+64222'] }),
    })
    const res = await PUT(req, makeParams('h_seraph', 'signal'))
    expect(res.status).toBe(400)
    expect(setAdmins).toHaveBeenCalledWith('h_seraph', 'signal', ['+64222'], '')
  })
})
