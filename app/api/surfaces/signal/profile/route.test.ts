// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const callSignalRpcMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/env-helpers', () => ({
  callSignalRpc: callSignalRpcMock,
}))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://localhost/api/surfaces/signal/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  callSignalRpcMock.mockReset()
})

describe('POST /api/surfaces/signal/profile', () => {
  it('calls updateProfile with account + given-name', async () => {
    callSignalRpcMock.mockResolvedValueOnce({ result: {} })
    const res = await POST(req({ phone: '+15551234567', displayName: 'Badger Hermes' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true })
    expect(callSignalRpcMock).toHaveBeenCalledWith('updateProfile', {
      account: '+15551234567',
      'given-name': 'Badger Hermes',
    })
  })

  it('400 when phone or displayName missing', async () => {
    const res = await POST(req({ phone: '+15551234567' }))
    expect(res.status).toBe(400)
    expect(callSignalRpcMock).not.toHaveBeenCalled()
  })

  it('500 when the daemon returns an error', async () => {
    callSignalRpcMock.mockResolvedValueOnce({ error: { code: -1, message: 'not registered' } })
    const res = await POST(req({ phone: '+15551234567', displayName: 'X' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ success: false })
  })
})
