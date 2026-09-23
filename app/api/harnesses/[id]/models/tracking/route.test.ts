// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'

const state = vi.hoisted(() => ({
  harness: undefined as { id: string; name: string; modelTracking?: Record<string, boolean> } | undefined,
  updateConfig: vi.fn(),
  auditAppend: vi.fn(),
  // What config.yaml currently holds: the primary (model:) and the fallback_providers rows.
  primary: null as { provider: string; model: string } | null,
  rows: [] as Array<{ provider: string; model: string }>,
}))
const { updateConfig, auditAppend } = state

vi.mock('@/lib/services', () => ({
  services: {
    harness: { get: (id: string) => (state.harness && state.harness.id === id ? state.harness : undefined), updateConfig: state.updateConfig },
    audit: { append: state.auditAppend },
  },
}))

vi.mock('@/lib/services/harness', async (importOriginal) => {
  const { cascadeChain, sameCascadeRow } = await importOriginal<typeof import('@/lib/services/harness')>()
  return {
    guessDataDir: () => '/tmp/hsm-tracking-test',
    cascadeChain,
    readCascade: () => ({
      primary: state.primary,
      fallbacks: state.rows,
      primaryDuplicatedAsRow0: !!state.primary && state.rows.length > 0 && sameCascadeRow(state.rows[0], state.primary),
    }),
  }
})

import { PUT } from './route'

const put = (id: string, body: unknown) =>
  PUT(new Request(`http://localhost/api/harnesses/${id}/models/tracking`, { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })

describe('PUT /api/harnesses/[id]/models/tracking', () => {
  beforeEach(() => {
    state.harness = { id: 'h_test', name: 'test', modelTracking: { 'openrouter/moonshotai/kimi-k2.7-code': true } }
    // HSM-saved shape: the primary is repeated as row 0.
    state.primary = { provider: 'openrouter', model: 'z-ai/glm-5.2' }
    state.rows = [
      { provider: 'openrouter', model: 'z-ai/glm-5.2' },
      { provider: 'openrouter', model: 'moonshotai/kimi-k2.7-code' },
      { provider: 'ollama', model: 'qwen3:30b' },
    ]
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

  // Audit: a stale UI must not record intent for a row that no longer exists
  // (the scheduler may have rotated it) — the key would orphan silently.
  it('the PRIMARY can be tracked even when the file does not repeat it as a fallback_providers row', async () => {
    state.primary = { provider: 'openrouter', model: 'moonshotai/kimi-k3' }
    state.rows = [{ provider: 'openrouter', model: 'z-ai/glm-5.2' }]
    const res = await put('h_test', { 'openrouter/moonshotai/kimi-k3': true })
    expect(res.status).toBe(200)
    expect(updateConfig).toHaveBeenCalledWith('h_test', { modelTracking: { 'openrouter/moonshotai/kimi-k2.7-code': true, 'openrouter/moonshotai/kimi-k3': true } })
  })

  it('refuses tracking a key that matches no current chain entry; clearing one is always allowed', async () => {
    const res = await put('h_test', { 'openrouter/z-ai/glm-5.3': true })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('openrouter/z-ai/glm-5.3')
    expect(updateConfig).not.toHaveBeenCalled()

    const clear = await put('h_test', { 'openrouter/z-ai/glm-5.3': false, 'openrouter/moonshotai/kimi-k2.7-code': false })
    expect(clear.status).toBe(200)
    expect(await clear.json()).toEqual({ modelTracking: {} })
  })
})
