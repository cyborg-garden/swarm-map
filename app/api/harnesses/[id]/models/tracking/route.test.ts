// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  harness: undefined as { id: string; name: string; modelTracking?: Record<string, boolean> } | undefined,
  updateConfig: vi.fn(),
  auditAppend: vi.fn(),
}))
const { updateConfig, auditAppend } = state

vi.mock('@/lib/services', () => ({
  services: {
    harness: { get: (id: string) => (state.harness && state.harness.id === id ? state.harness : undefined), updateConfig: state.updateConfig },
    audit: { append: state.auditAppend },
  },
}))

import { PUT } from './route'

const put = (id: string, body: unknown) =>
  PUT(new Request(`http://localhost/api/harnesses/${id}/models/tracking`, { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })

describe('PUT /api/harnesses/[id]/models/tracking', () => {
  beforeEach(() => {
    state.harness = { id: 'h_test', name: 'test', modelTracking: { 'openrouter/moonshotai/kimi-k2.7-code': true } }
    updateConfig.mockReset()
    auditAppend.mockReset()
  })

  it('404 for an unknown harness', async () => {
    expect((await put('h_nope', { 'openrouter/z-ai/glm-5.2': true })).status).toBe(404)
  })

  it('merges true/false into modelTracking (false removes the key), persists, audits', async () => {
    const res = await put('h_test', { 'openrouter/z-ai/glm-5.2': true, 'openrouter/moonshotai/kimi-k2.7-code': false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ modelTracking: { 'openrouter/z-ai/glm-5.2': true } })
    expect(updateConfig).toHaveBeenCalledWith('h_test', { modelTracking: { 'openrouter/z-ai/glm-5.2': true } })
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({ who: 'api', what: 'models:tracking', target: 'test' }))
  })

  it('refuses tracking an ollama entry', async () => {
    const res = await put('h_test', { 'ollama/qwen3:30b': true })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('ollama')
    expect(updateConfig).not.toHaveBeenCalled()
  })

  it('rejects malformed keys, non-boolean values and non-object bodies', async () => {
    expect((await put('h_test', { 'no-slash': true })).status).toBe(400)
    expect((await put('h_test', { '/leading': true })).status).toBe(400)
    expect((await put('h_test', { 'openrouter/x': 'yes' })).status).toBe(400)
    expect((await put('h_test', ['openrouter/x'])).status).toBe(400)
    expect(updateConfig).not.toHaveBeenCalled()
  })
})
