// @vitest-environment node
/**
 * Tests for POST /api/harnesses/:id/duplicate.
 *
 * The route pre-checks name existence before calling the service so a
 * duplicate-name collision surfaces as a 409. The service normalizes names to
 * a lowercase slug (toHarnessSlug) at creation, so the pre-check MUST build
 * the candidate id from the SLUGGED name — checking the raw name misses the
 * collision and the service's own guard then surfaces as a wrong 404.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const SRC = { id: 'h_src', name: 'src' }

const h = vi.hoisted(() => ({
  get: vi.fn(),
  duplicateOverlay: vi.fn(),
}))

vi.mock('@/lib/services', () => ({
  services: {
    harness: { get: h.get, duplicateOverlay: h.duplicateOverlay },
  },
}))

import { POST } from './route'

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

function makeRequest(name: unknown): Request {
  return new Request('http://localhost/api/harnesses/h_src/duplicate', {
    method: 'POST',
    body: JSON.stringify({ name }),
    headers: { 'content-type': 'application/json' },
  })
}

describe('Duplicate API — POST /api/harnesses/:id/duplicate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The source agent is listed; no other id is.
    h.get.mockImplementation((id: string) => (id === 'h_src' ? SRC : undefined))
    h.duplicateOverlay.mockResolvedValue({ id: 'h_new', name: 'new' })
  })

  it('pre-checks with the SLUGGED id so a case-variant collision is a 409, not a 404', async () => {
    // "mare" exists; the service would create "Mare" as slug "mare" and its
    // collision guard returns undefined → without a slug-aware pre-check the
    // user gets a misleading 404 "Source harness not found".
    h.get.mockImplementation((id: string) => (id === 'h_src' ? SRC : id === 'h_mare' ? { id: 'h_mare', name: 'mare' } : undefined))
    const res = await POST(makeRequest('Mare'), makeParams('h_src'))
    expect(res.status).toBe(409)
    expect(h.get).toHaveBeenCalledWith('h_mare')
    expect(h.duplicateOverlay).not.toHaveBeenCalled()
  })

  it('pre-checks multi-word names by their slugged id', async () => {
    h.get.mockImplementation((id: string) => (id === 'h_src' ? SRC : id === 'h_my_agent' ? { id: 'h_my_agent' } : undefined))
    const res = await POST(makeRequest('My Agent'), makeParams('h_src'))
    expect(res.status).toBe(409)
    expect(h.duplicateOverlay).not.toHaveBeenCalled()
  })

  it('rejects a name that slugs to nothing (400)', async () => {
    const res = await POST(makeRequest('!!!'), makeParams('h_src'))
    expect(res.status).toBe(400)
    expect(h.duplicateOverlay).not.toHaveBeenCalled()
  })

  it('duplicates and returns 201 when there is no collision', async () => {
    const res = await POST(makeRequest('fresh-name'), makeParams('h_src'))
    expect(res.status).toBe(201)
    expect(h.duplicateOverlay).toHaveBeenCalledWith('h_src', 'fresh-name')
  })

  it('returns 404 when the source harness is missing, without calling the service', async () => {
    const res = await POST(makeRequest('fresh-name'), makeParams('h_missing'))
    expect(res.status).toBe(404)
    expect(h.duplicateOverlay).not.toHaveBeenCalled()
  })

  it('returns 404 when the service finds no stored source row', async () => {
    h.duplicateOverlay.mockResolvedValue(undefined)
    const res = await POST(makeRequest('fresh-name'), makeParams('h_src'))
    expect(res.status).toBe(404)
  })

  it('returns 400 when name is missing', async () => {
    const res = await POST(makeRequest(undefined), makeParams('h_src'))
    expect(res.status).toBe(400)
  })
})
