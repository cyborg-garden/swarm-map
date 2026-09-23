// @vitest-environment node
//
// The three fleet routes are thin wrappers over model-update-scheduler.ts
// (which has its own behavioural tests). These pin the HTTP contract:
// shapes, status codes, and that the apply route forwards the guard result
// unchanged.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { stored, settings, auditAppend, checkModelUpdates, applyModelUpdate } = vi.hoisted(() => ({
  stored: { report: null as unknown },
  settings: { enabled: false, mode: 'notify' as 'notify' | 'apply', intervalHours: 24, maxPriceMultiplier: 1.5 },
  auditAppend: vi.fn(),
  checkModelUpdates: vi.fn(),
  applyModelUpdate: vi.fn(),
}))

vi.mock('@/lib/services', () => ({
  services: {
    storage: { read: (_f: string, def: unknown) => stored.report ?? def },
    config: { getModelAutoUpdate: () => settings },
    audit: { append: auditAppend },
  },
}))
vi.mock('@/lib/services/model-update-scheduler', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/services/model-update-scheduler')>()
  return {
    ...mod,
    checkModelUpdates: (...a: unknown[]) => checkModelUpdates(...a),
    applyModelUpdate: (...a: unknown[]) => applyModelUpdate(...a),
  }
})

import { GET } from './route'
import { POST as CHECK } from './check/route'
import { POST as APPLY } from './apply/route'

const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  stored.report = null
  settings.enabled = false
  settings.mode = 'notify'
  auditAppend.mockReset()
  checkModelUpdates.mockReset()
  applyModelUpdate.mockReset()
})

describe('GET /api/fleet/model-updates', () => {
  it('empty shape before any check has run', async () => {
    expect(await (await GET()).json()).toEqual({ checkedAt: null, enabled: false, mode: 'notify', harnesses: [] })
  })
  it('returns the persisted report', async () => {
    stored.report = { checkedAt: 5, enabled: true, mode: 'notify', harnesses: [{ id: 'h_a', name: 'a', entries: [] }] }
    expect(await (await GET()).json()).toEqual(stored.report)
  })
})

describe('POST /api/fleet/model-updates/check', () => {
  it('runs the check report-only when the policy is not enabled+apply, and audits', async () => {
    checkModelUpdates.mockResolvedValue({ checkedAt: 1, enabled: false, mode: 'notify', harnesses: [] })
    const res = await post(CHECK, {})
    expect(res.status).toBe(200)
    expect(checkModelUpdates).toHaveBeenCalledWith(undefined, { apply: false })
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({ what: 'model-updates:check', meta: { apply: false, harnesses: 0 } }))
  })
  it('applies when enabled+apply, unless the body forces apply:false', async () => {
    settings.enabled = true
    settings.mode = 'apply'
    checkModelUpdates.mockResolvedValue({ checkedAt: 1, enabled: true, mode: 'apply', harnesses: [] })
    await post(CHECK, {})
    expect(checkModelUpdates).toHaveBeenLastCalledWith(undefined, { apply: true })
    await post(CHECK, { apply: false })
    expect(checkModelUpdates).toHaveBeenLastCalledWith(undefined, { apply: false })
  })
  it('500 with the error message when the check throws', async () => {
    checkModelUpdates.mockRejectedValue(new Error('disk full'))
    const res = await post(CHECK, {})
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('disk full')
  })
})

describe('POST /api/fleet/model-updates/apply', () => {
  it('400 when harnessId/from/to are missing', async () => {
    expect((await post(APPLY, { harnessId: 'h_a', from: 'x' })).status).toBe(400)
    expect((await post(APPLY, null)).status).toBe(400)
    expect(applyModelUpdate).not.toHaveBeenCalled()
  })
  it('forwards a successful apply', async () => {
    applyModelUpdate.mockResolvedValue({ ok: true, harnessId: 'h_a', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', priceRatio: 1.4 })
    const res = await post(APPLY, { harnessId: 'h_a', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, harnessId: 'h_a', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', priceRatio: 1.4 })
    expect(applyModelUpdate).toHaveBeenCalledWith({ harnessId: 'h_a', from: 'z-ai/glm-5.2', to: 'z-ai/glm-5.3', provider: undefined })
  })
  it('forwards a guard refusal with its status and message', async () => {
    applyModelUpdate.mockResolvedValue({ ok: false, status: 409, error: 'Blocked: restart-in-flight' })
    const res = await post(APPLY, { harnessId: 'h_a', from: 'a', to: 'b', provider: 'openrouter' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('Blocked: restart-in-flight')
  })
})
