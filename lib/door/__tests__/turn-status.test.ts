// @vitest-environment node
//
// The status shown for one turn, on its own, with a connector that records
// what it is asked and a fake clock: what is sent, in what order, and that no
// timer outlives the turn.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SurfaceConnector } from '../connector.ts'
import { startTurnStatus, statusCode, STATUS_EMOJI } from '../turn-status.ts'

const room = { id: 'r-1', kind: 'channel' as const }
let calls: string[]
let typingWait: Promise<void>
const connector = (): SurfaceConnector => ({
  id: 'fake', connect: async () => {}, onEvent: () => {}, send: async () => ({ id: '', ts: '' }), facts: async () => ({}), close: async () => {},
  react: async (_room, messageId, emoji, on) => { calls.push(`${on ? '+' : '-'}${emoji} ${messageId}`) },
  typing: async () => { calls.push('typing'); await typingWait },
})
const start = (o: { paused?: () => boolean; reactions?: boolean; typing?: boolean } = {}) => startTurnStatus({
  reactions: o.reactions ?? true, typing: o.typing ?? true, typingEveryMs: 8000, connector: connector(), room, messageId: 'm-1',
  paused: o.paused ?? (() => false), failed: () => {},
})

beforeEach(() => { vi.useFakeTimers(); calls = []; typingWait = Promise.resolve() })
afterEach(() => { vi.useRealTimers() })

describe('turn status, on its own', () => {
  it('[U:turn-status] no timer outlives the turn, however it ends', async () => {
    for (const finish of [(s: ReturnType<typeof start>) => s.end('done'), (s: ReturnType<typeof start>) => s.end('failed'), (s: ReturnType<typeof start>) => s.end('gone'), (s: ReturnType<typeof start>) => s.quiet()]) {
      const before = vi.getTimerCount()
      const s = start()
      expect(vi.getTimerCount()).toBe(before + 1)
      finish(s)
      expect(vi.getTimerCount()).toBe(before)
      s.end('gone')
    }
    // With typing off there is no timer at all.
    start({ typing: false })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('[U:turn-status] typing about every interval, none while paused, one at a time, and none once quiet', async () => {
    let paused = false
    typingWait = new Promise(() => {}) // a typing call that never comes back
    const s = start({ reactions: false, paused: () => paused })
    expect(calls).toEqual(['typing'])
    await vi.advanceTimersByTimeAsync(8000 * 3)
    expect(calls).toEqual(['typing']) // the first is still on its way, so no second is stacked behind it
    typingWait = Promise.resolve()
    calls = []
    const t = start({ reactions: false, paused: () => paused })
    await vi.advanceTimersByTimeAsync(8000 * 2)
    expect(calls).toEqual(['typing', 'typing', 'typing'])
    paused = true
    await vi.advanceTimersByTimeAsync(8000 * 3)
    expect(calls).toHaveLength(3)
    paused = false
    await vi.advanceTimersByTimeAsync(8000)
    expect(calls).toHaveLength(4)
    t.quiet()
    await vi.advanceTimersByTimeAsync(8000 * 3)
    expect(calls).toHaveLength(4)
    s.end('gone'); t.end('gone')
  })

  it('[U:turn-status] the reaction says how it ended, the new one before the old one is taken off, and only once', async () => {
    const done = start({ typing: false })
    done.end('done')
    done.end('failed')
    await vi.runAllTimersAsync()
    expect(calls).toEqual([`+${STATUS_EMOJI.working} m-1`, `+${STATUS_EMOJI.done} m-1`, `-${STATUS_EMOJI.working} m-1`])
    calls = []
    start({ typing: false }).end('gone')
    await vi.runAllTimersAsync()
    expect(calls).toEqual([`+${STATUS_EMOJI.working} m-1`])
  })

  it('[U:turn-status] a call that fails, and a report of it that fails too, leave nothing unhandled', async () => {
    const reported: string[] = []
    const broken: SurfaceConnector = { ...connector(), react: async () => { throw new Error('discord: PUT failed with status 403') }, typing: async () => { throw new Error('x') } }
    const s = startTurnStatus({
      reactions: true, typing: true, typingEveryMs: 8000, connector: broken, room, messageId: 'm-1', paused: () => false,
      failed: (what) => { reported.push(what); throw new Error('the receipt could not be written') },
    })
    await vi.advanceTimersByTimeAsync(8000 * 2)
    s.end('failed')
    await vi.runAllTimersAsync()
    // Once per kind, and the door is still standing: vitest fails the run on an unhandled rejection.
    expect(reported.sort()).toEqual(['reaction', 'typing'])
  })

  it('[U:turn-status] a failure is reported by its code, never its text', () => {
    expect(statusCode(new Error('discord: PUT failed with status 403'))).toBe('403')
    expect(statusCode(new Error('discord: rate limited for longer than this connector will wait (PUT)'))).toBe('rate-limited')
    expect(statusCode(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout')
    expect(statusCode(new Error('SECRET words from somewhere'))).toBe('error')
    expect(statusCode('not an error')).toBe('error')
  })
})
