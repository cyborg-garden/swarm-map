import { describe, it, expect, vi, afterEach } from 'vitest'

const listMock = vi.hoisted(() => vi.fn(() => [{ id: 'h_personal', name: 'personal' }, { id: 'h_agent_a', name: 'agent-a' }]))
const listSurfacesMock = vi.hoisted(() => vi.fn((names?: string[]) => {
  void names
  return [{ platform: 'signal', status: 'connected', config: { phone: '+15550000001' }, harnessIds: ['h_agent_a'] }]
}))
const bulkSetMock = vi.hoisted(() => vi.fn(async () => ({ locked: [], alreadyLocked: [], failed: [] })))

vi.mock('@/lib/services', () => ({
  services: {
    harness: { list: listMock },
    config: { listSurfaces: listSurfacesMock },
    signalPin: { bulkSet: bulkSetMock },
  },
}))

import { POST } from './route'

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('POST /api/surfaces/signal/pin/bulk-set', () => {
  it('maps phones using every live harness, not only the configured default list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ result: [{ number: '+15550000001' }] }))))
    const res = await POST()
    expect(res.status).toBe(200)
    expect(listSurfacesMock).toHaveBeenCalledWith(['personal', 'agent-a'])
    expect(bulkSetMock).toHaveBeenCalledWith(['+15550000001'], { '+15550000001': 'h_agent_a' })
  })
})
