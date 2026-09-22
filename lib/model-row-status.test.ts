import { describe, it, expect } from 'vitest'
import { rowKey, isTrackableProvider, isRetiredIn } from './model-row-status'

describe('model-row-status helpers', () => {
  it('rowKey matches the server tracking key ("provider/model")', () => {
    expect(rowKey({ provider: 'openrouter', model: 'z-ai/glm-5.2' })).toBe('openrouter/z-ai/glm-5.2')
  })

  it('only the live-list providers are trackable', () => {
    expect(isTrackableProvider('openrouter')).toBe(true)
    expect(isTrackableProvider('Anthropic')).toBe(true)
    expect(isTrackableProvider('zai')).toBe(true)
    expect(isTrackableProvider('ollama')).toBe(false)
    expect(isTrackableProvider('bedrock')).toBe(false)
    expect(isTrackableProvider('custom')).toBe(false)
  })

  it('isRetiredIn is fail-soft: no live list → never retired', () => {
    expect(isRetiredIn(null, 'claude-3-opus', '2026-09-22')).toBe(false)
  })

  it('isRetiredIn: absent from the list or past expiration → retired', () => {
    const live = { models: [{ id: 'a', expiration: null }, { id: 'b', expiration: '2026-01-01' }, { id: 'c', expiration: '2030-01-01' }] }
    expect(isRetiredIn(live, 'a', '2026-09-22')).toBe(false)
    expect(isRetiredIn(live, 'b', '2026-09-22')).toBe(true)
    expect(isRetiredIn(live, 'c', '2026-09-22')).toBe(false)
    expect(isRetiredIn(live, 'zzz', '2026-09-22')).toBe(true)
  })
})
