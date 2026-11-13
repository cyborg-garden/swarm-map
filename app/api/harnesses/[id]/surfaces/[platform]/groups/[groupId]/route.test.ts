/**
 * Tests for the group routes the swarm_map_policy plugin calls.
 * GET  /api/harnesses/:id/surfaces/:platform/groups/:groupId → { allowed }
 * POST /api/harnesses/:id/surfaces/:platform/groups/:groupId → group-invite approval
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GET, POST } from './route'

vi.mock('@/lib/services', () => ({
  services: {
    surfaceAdmins: { isGroupAllowed: vi.fn(), approveGroupInvite: vi.fn() },
    harness: { restart: vi.fn() },
  },
}))

import { services } from '@/lib/services'
const isGroupAllowed = services.surfaceAdmins.isGroupAllowed as ReturnType<typeof vi.fn>
const approveGroupInvite = services.surfaceAdmins.approveGroupInvite as ReturnType<typeof vi.fn>
const restart = services.harness.restart as ReturnType<typeof vi.fn>

function makeParams(id: string, platform: string, groupId: string) {
  return { params: Promise.resolve({ id, platform, groupId }) }
}

beforeEach(() => vi.clearAllMocks())

describe('GET is-group-allowed', () => {
  it('returns { allowed: true } (200) when the service allows the group', async () => {
    isGroupAllowed.mockReturnValue(true)
    const res = await GET(new Request('http://x'), makeParams('h_seraph', 'signal', 'g1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true })
    expect(isGroupAllowed).toHaveBeenCalledWith('h_seraph', 'signal', 'g1')
  })

  it('returns { allowed: false } (200, fail-closed) for an unlisted group', async () => {
    isGroupAllowed.mockReturnValue(false)
    const res = await GET(new Request('http://x'), makeParams('h_seraph', 'signal', 'gX'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: false })
  })
})

describe('POST group-invite approval', () => {
  function makePost(addedByUserId?: unknown, rawBody?: string) {
    return new Request('http://x', {
      method: 'POST',
      body: rawBody ?? JSON.stringify({ addedByUserId }),
    })
  }

  it('approves, recreates the container, and reports restarted when the allowlist was updated', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: true, updated: true, harnessId: 'h_seraph' })
    const res = await POST(makePost('111'), makeParams('h_seraph', 'telegram', '-100777'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approved: true, restarted: true })
    expect(approveGroupInvite).toHaveBeenCalledWith('h_seraph', 'telegram', '-100777', '111')
    // env_file is only read at container creation — a recreate must follow the write.
    expect(restart).toHaveBeenCalledWith('h_seraph', 'recreate')
  })

  it('reports restarted:false (still approved) when the recreate fails', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: true, updated: true, harnessId: 'h_seraph' })
    restart.mockImplementationOnce(() => { throw new Error('no compose file') })
    const res = await POST(makePost('111'), makeParams('h_seraph', 'telegram', '-100777'))
    expect(await res.json()).toEqual({ approved: true, restarted: false })
  })

  it('approves without a restart when the group is already allowed', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: true, updated: false, harnessId: 'h_seraph' })
    const res = await POST(makePost('111'), makeParams('h_seraph', 'telegram', '-100777'))
    expect(await res.json()).toEqual({ approved: true, already_allowed: true })
    expect(restart).not.toHaveBeenCalled()
  })

  it('returns { approved: false, reason } (200) when the adder is not an admin', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: false, reason: 'not an admin' })
    const res = await POST(makePost('222'), makeParams('h_seraph', 'telegram', '-100777'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ approved: false, reason: 'not an admin' })
    expect(restart).not.toHaveBeenCalled()
  })

  it('recreates the agent the service resolved, not the id in the URL', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: true, updated: true, harnessId: 'h_seraph_doer' })
    await POST(makePost('111'), makeParams('seraph-doer', 'telegram', '-100777'))
    expect(restart).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledWith('h_seraph_doer', 'recreate')
  })

  it('404 and no recreate when the service knows no such agent', async () => {
    approveGroupInvite.mockReturnValue({ ok: false, status: 404, error: 'Unknown agent' })
    const res = await POST(makePost('111'), makeParams('h_seraph-x', 'telegram', '-100777'))
    expect(res.status).toBe(404)
    expect(restart).not.toHaveBeenCalled()
  })

  it('maps service validation failures to 400', async () => {
    approveGroupInvite.mockReturnValue({ ok: false, status: 400, error: 'Invalid group id' })
    const res = await POST(makePost('111'), makeParams('h_seraph', 'telegram', 'bad,id'))
    expect(res.status).toBe(400)
  })

  it('rejects a malformed JSON body with 400', async () => {
    const res = await POST(makePost(undefined, 'not-json'), makeParams('h_seraph', 'telegram', '-100777'))
    expect(res.status).toBe(400)
    expect(approveGroupInvite).not.toHaveBeenCalled()
  })

  it('passes a non-string addedByUserId through as empty (service 400s it)', async () => {
    approveGroupInvite.mockReturnValue({ ok: false, status: 400, error: 'addedByUserId is required' })
    const res = await POST(makePost(42), makeParams('h_seraph', 'telegram', '-100777'))
    expect(res.status).toBe(400)
    expect(approveGroupInvite).toHaveBeenCalledWith('h_seraph', 'telegram', '-100777', '')
  })

  it('URL-decodes the groupId (signal ids are base64 with url-encoded chars)', async () => {
    approveGroupInvite.mockReturnValue({ ok: true, approved: true, updated: false, harnessId: 'h_seraph' })
    await POST(makePost('111'), makeParams('h_seraph', 'signal', 'abc%2Bdef%3D%3D'))
    expect(approveGroupInvite).toHaveBeenCalledWith('h_seraph', 'signal', 'abc+def==', '111')
  })
})
