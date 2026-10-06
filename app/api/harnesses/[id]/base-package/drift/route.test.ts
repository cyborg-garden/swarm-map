// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@/lib/services', () => ({
  services: { harness: { basePackageDrift: vi.fn(), syncArtifacts: vi.fn() }, keys: { list: vi.fn() } },
}))

import { GET } from './route'
import { services } from '@/lib/services'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe('GET /api/harnesses/:id/base-package/drift', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the report and never calls sync (report-only)', async () => {
    ;(services.harness.basePackageDrift as any).mockReturnValue({ ok: false, findings: [{ id: 'required-key-missing' }] })
    const res = await GET(new Request('http://localhost/x'), params('h_cyborg_public'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false })
    expect(services.harness.basePackageDrift).toHaveBeenCalledWith('h_cyborg_public', services.keys)
    expect(services.harness.syncArtifacts).not.toHaveBeenCalled()
  })

  it('maps not-found to 404', async () => {
    ;(services.harness.basePackageDrift as any).mockImplementation(() => { throw new Error('Harness h_x not found') })
    const res = await GET(new Request('http://localhost/x'), params('h_x'))
    expect(res.status).toBe(404)
  })
})
