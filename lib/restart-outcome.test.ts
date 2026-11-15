// @vitest-environment node
/**
 * A save and the restart that applies it are two steps. These helpers carry
 * the restart's result to the operator, so a failed restart is never reported
 * as "restarting".
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { failedRestarts, requestRestart, restartEach, restartFailureMessage } from './restart-outcome'

afterEach(() => vi.unstubAllGlobals())

describe('restartEach', () => {
  it('records a failure and still restarts the agents after it', () => {
    const restart = vi.fn((id: string) => {
      if (id === 'h_b') throw new Error('no compose file')
    })
    expect(restartEach(['h_a', 'h_b', 'h_c'], 'recreate', restart)).toEqual([
      { harnessId: 'h_a', ok: true },
      { harnessId: 'h_b', ok: false, error: 'no compose file' },
      { harnessId: 'h_c', ok: true },
    ])
    expect(restart).toHaveBeenCalledTimes(3)
    expect(restart).toHaveBeenCalledWith('h_c', 'recreate')
  })
})

describe('failedRestarts', () => {
  it('keeps only the failures', () => {
    const body = { id: 'k1', restarts: [{ harnessId: 'h_a', ok: true }, { harnessId: 'h_b', ok: false, error: 'boom' }] }
    expect(failedRestarts(body)).toEqual([{ harnessId: 'h_b', ok: false, error: 'boom' }])
  })

  it('reads a body with no restarts field as no failures', () => {
    for (const body of [null, undefined, {}, { restarts: 'x' }, { restarts: [null, 3] }]) {
      expect(failedRestarts(body)).toEqual([])
    }
  })
})

describe('restartFailureMessage', () => {
  it('is null when nothing failed', () => {
    expect(restartFailureMessage('Key saved', [])).toBeNull()
  })

  it('says the save went through and names the agent and the reason', () => {
    const msg = restartFailureMessage('Key rotated', [{ harnessId: 'h_a', ok: false, error: 'boom' }], () => 'alpha')
    expect(msg).toBe('Key rotated, but the restart of alpha failed: boom. Restart it to apply the change.')
  })

  it('counts several failures', () => {
    const msg = restartFailureMessage('Key rotated', [
      { harnessId: 'h_a', ok: false, error: 'boom' },
      { harnessId: 'h_b', ok: false, error: 'other' },
    ])
    expect(msg).toBe('Key rotated, but 2 restarts failed (h_a, h_b): boom. Restart them to apply the change.')
  })
})

describe('requestRestart', () => {
  const respond = (status: number, body: unknown) =>
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status < 400, status, json: async () => body })))

  it('reports a started restart', async () => {
    respond(200, { ok: true })
    expect(await requestRestart('h_a', 'quick')).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledWith('/api/harnesses/h_a/restart', expect.objectContaining({ method: 'POST', body: '{"mode":"quick"}' }))
  })

  it('treats "already restarting" as started', async () => {
    respond(409, { error: 'Restart already in progress' })
    expect(await requestRestart('h_a', 'recreate')).toEqual({ ok: true })
  })

  it('reports the server error when the restart fails', async () => {
    respond(500, { error: 'no compose file' })
    expect(await requestRestart('h_a', 'quick')).toEqual({ ok: false, error: 'no compose file' })
  })

  it('reports a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    expect(await requestRestart('h_a', 'quick')).toEqual({ ok: false, error: 'offline' })
  })
})
