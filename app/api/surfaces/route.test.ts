/**
 * Tests for GET /api/surfaces
 *
 * Regression: listSurfaces() was called with no arguments, so it fell back to
 * a hardcoded DEFAULT_HARNESS_NAMES list. Harnesses added later (e.g. harbor,
 * grey-duck) were never iterated, so their connected surfaces never rendered —
 * the UI showed them as "not connected" even when fully configured.
 *
 * The route must pass the LIVE harness names from harness.list() so every
 * existing harness is considered, not just a hardcoded subset.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const listMock = vi.hoisted(() => vi.fn<() => Array<{ id: string; name: string }>>())
const listSurfacesMock = vi.hoisted(() =>
  vi.fn<(names?: string[]) => unknown[]>(() => []),
)

vi.mock('@/lib/services', () => ({
  services: {
    harness: { list: listMock },
    config: { listSurfaces: listSurfacesMock },
  },
}))

import { GET } from './route'

beforeEach(() => {
  vi.clearAllMocks()
  listSurfacesMock.mockReturnValue([])
})

describe('GET /api/surfaces', () => {
  it('passes live harness names — including non-default ones — to listSurfaces', async () => {
    listMock.mockReturnValue([
      { id: 'h_personal', name: 'personal' },
      { id: 'h_harbor', name: 'harbor' },
      { id: 'h_grey_duck', name: 'grey-duck' },
    ])

    await GET()

    expect(listSurfacesMock).toHaveBeenCalledTimes(1)
    const namesArg = listSurfacesMock.mock.calls[0][0]
    expect(namesArg).toBeDefined()
    expect(namesArg).toContain('harbor')
    expect(namesArg).toContain('grey-duck')
    expect(namesArg).toContain('personal')
  })

  it('returns whatever listSurfaces produces', async () => {
    listMock.mockReturnValue([{ id: 'h_personal', name: 'personal' }])
    const surfaces = [{ id: 'int_sg_personal', platform: 'signal' }]
    listSurfacesMock.mockReturnValue(surfaces)

    const res = await GET()
    const body = await res.json()
    expect(body).toEqual(surfaces)
  })
})
