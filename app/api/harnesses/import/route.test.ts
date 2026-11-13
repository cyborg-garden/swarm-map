// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ nameTaken: vi.fn(), importFromDir: vi.fn() }))
vi.mock('@/lib/services', () => ({
  services: { harness: { nameTaken: h.nameTaken, importFromDir: h.importFromDir }, keys: {} },
}))
vi.mock('@/lib/services/base-package', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/services/base-package')>()),
  loadBasePackage: () => ({ version: 'test' }),
  validateSelection: () => undefined,
  assignBasePackageKeys: () => [],
}))

import { POST } from './route'

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/harnesses/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

describe('POST /api/harnesses/import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.nameTaken.mockReturnValue(false)
    h.importFromDir.mockResolvedValue({ id: 'h_new', name: 'new', sourceDir: '/s', destDir: '/d', changes: {} })
  })

  it('answers 409 for a name a stored agent already has, without starting the import', async () => {
    h.nameTaken.mockReturnValue(true)
    const res = await post({ dataDir: '/some/dir', name: 'Taken' })
    expect(res.status).toBe(409)
    expect(h.nameTaken).toHaveBeenCalledWith('Taken')
    expect(h.importFromDir).not.toHaveBeenCalled()
  })

  it('answers 400 when name or dataDir is not a string, without starting the import', async () => {
    for (const body of [{ dataDir: '/d', name: 42 }, { dataDir: ['/d'], name: 'x' }, { name: 'x' }, { dataDir: '/d' }]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(h.importFromDir).not.toHaveBeenCalled()
  })

  it('imports under a free name', async () => {
    const res = await post({ dataDir: '/some/dir', name: 'new' })
    expect(res.status).toBe(201)
    expect(h.importFromDir).toHaveBeenCalledWith('/some/dir', 'new', expect.anything())
  })
})
