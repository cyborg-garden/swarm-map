/**
 * Tests for GET /api/surfaces/signal
 *
 * Regression (#57): the route called listSurfaces() with NO harness-name list,
 * so it fell back to a hardcoded DEFAULT_HARNESS_NAMES list. A harness whose
 * data-dir name isn't in that list (e.g. harbor) never produced a Signal
 * surface, so its pinStatus was never populated — the Surfaces tab showed
 * "Registration Lock: not set" even though the PIN was saved to keys.json.
 *
 * The route must pass the LIVE harness names from harness.list() so every
 * existing harness's Signal surface is considered.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn<() => Array<{ id: string; name: string }>>())
const listSurfacesMock = vi.hoisted(() =>
  vi.fn<(names?: string[]) => unknown[]>(() => []),
)
const checkPinHealthMock = vi.hoisted(() =>
  vi.fn<(accounts: string[], harnessAccounts: Array<{ phone: string; harnessId: string }>) => Promise<Record<string, string>>>(
    async () => ({}),
  ),
)
const getPinStatusMock = vi.hoisted(() => vi.fn<(phone: string) => string>(() => 'not-set'))

vi.mock('@/lib/env-helpers', () => ({
  getSignalDaemonUrl: () => 'http://localhost:8080',
}))

vi.mock('@/lib/services', () => ({
  services: {
    harness: { list: listMock },
    config: { listSurfaces: listSurfacesMock },
    signalPin: { checkPinHealth: checkPinHealthMock, getPinStatus: getPinStatusMock },
  },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  listSurfacesMock.mockReturnValue([])
  getPinStatusMock.mockReturnValue('not-set')
  // Daemon unhealthy by default → exercises the keys-only getPinStatus branch
  fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
})

describe('GET /api/surfaces/signal', () => {
  it('passes live harness names — including non-default ones — to listSurfaces', async () => {
    listMock.mockReturnValue([
      { id: 'h_personal', name: 'personal' },
      { id: 'h_harbor', name: 'harbor' },
    ])

    await GET()

    expect(listSurfacesMock).toHaveBeenCalledTimes(1)
    const namesArg = listSurfacesMock.mock.calls[0][0]
    expect(namesArg).toBeDefined()
    expect(namesArg).toContain('harbor')
    expect(namesArg).toContain('personal')
  })

  it('populates pinStatus for a non-default harness whose Signal surface is connected', async () => {
    // harbor is NOT in DEFAULT_HARNESS_NAMES — the bug missed it entirely.
    listMock.mockReturnValue([{ id: 'h_harbor', name: 'harbor' }])
    listSurfacesMock.mockReturnValue([
      {
        id: 'int_sg_harbor',
        platform: 'signal',
        name: 'Signal',
        status: 'connected',
        config: { phone: '+15551234567', url: 'http://localhost:8080' },
        harnessIds: ['h_harbor'],
      },
    ])
    getPinStatusMock.mockReturnValue('locked')

    const res = await GET()
    const body = await res.json()

    expect(body.pinStatus['+15551234567']).toBe('locked')
    expect(getPinStatusMock).toHaveBeenCalledWith('+15551234567')
  })

  it('uses checkPinHealth when the daemon is healthy', async () => {
    listMock.mockReturnValue([{ id: 'h_harbor', name: 'harbor' }])
    listSurfacesMock.mockReturnValue([
      {
        id: 'int_sg_harbor',
        platform: 'signal',
        name: 'Signal',
        status: 'connected',
        config: { phone: '+15551234567', url: 'http://localhost:8080' },
        harnessIds: ['h_harbor'],
      },
    ])
    // healthy check, then listAccounts RPC
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: [{ number: '+15551234567' }] }) })
    checkPinHealthMock.mockResolvedValue({ '+15551234567': 'locked' })

    const res = await GET()
    const body = await res.json()

    expect(checkPinHealthMock).toHaveBeenCalledTimes(1)
    expect(body.pinStatus['+15551234567']).toBe('locked')
  })
})
