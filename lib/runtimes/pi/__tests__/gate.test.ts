// @vitest-environment node
//
// The in-cell tool gate, run directly. The fake Pi and the real Pi both load
// this same file, but only a direct test can reach every way it must say no:
// a timeout, a cancel, a thrown error, a missing channel, a near-miss answer.
import { afterEach, describe, expect, it } from 'vitest'
import swarmGate from '../cell/gate.ts'
import { GATE_PREFIX, GATE_READY } from '../rpc.ts'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>

/** Loads the gate the way Pi does and hands back what it registered. */
function load() {
  const handlers: Record<string, Handler> = {}
  swarmGate({ on: (name: string, handler: Handler) => { handlers[name] = handler } } as never)
  return handlers
}

const call = { toolName: 'bash', toolCallId: 'call-1', input: { command: 'rm -rf /' } }
function ui(answer: () => Promise<string | undefined>) {
  const asked: { title: string; options: string[]; opts?: { timeout?: number } }[] = []
  const notices: string[] = []
  return {
    asked, notices,
    ctx: {
      hasUI: true,
      ui: {
        select: (title: string, options: string[], opts?: { timeout?: number }) => { asked.push({ title, options, opts }); return answer() },
        notify: (message: string) => { notices.push(message) },
      },
    },
  }
}
const blocked = { block: true, reason: expect.stringContaining('swarm gate') }

afterEach(() => { delete process.env.SWARM_GATE_TIMEOUT_MS })

describe('the Pi tool gate', () => {
  it('[U:pi-gate] says it is loaded as soon as the session starts', async () => {
    const u = ui(async () => 'allow')
    await load().session_start({ reason: 'startup' }, u.ctx)
    expect(u.notices).toEqual([GATE_READY])
  })

  it('[U:pi-gate] asks the sidecar about the exact call, and lets it run only on the exact answer allow', async () => {
    const u = ui(async () => 'allow')
    expect(await load().tool_call(call, u.ctx)).toBeUndefined()
    expect(u.asked).toEqual([{
      title: GATE_PREFIX + JSON.stringify({ tool: 'bash', input: { command: 'rm -rf /' }, callId: 'call-1' }),
      options: ['allow', 'deny'], opts: { timeout: 30_000 },
    }])
  })

  it.each([
    ['deny', 'deny'],
    ['nothing: a timeout or a cancel', undefined],
    ['a near miss', 'Allow'],
    ['a near miss', 'allow '],
    ['a near miss', 'yes'],
    ['an empty answer', ''],
    ['something that is not text', true as never],
  ])('[U:pi-gate] blocks on %s', async (_what, answer) => {
    expect(await load().tool_call(call, ui(async () => answer).ctx)).toEqual(blocked)
  })

  it('[U:pi-gate] blocks when asking throws, and when there is no channel to ask on', async () => {
    expect(await load().tool_call(call, ui(async () => { throw new Error('ui gone') }).ctx)).toEqual(blocked)
    const noUi = ui(async () => 'allow')
    expect(await load().tool_call(call, { ...noUi.ctx, hasUI: false })).toEqual(blocked)
    expect(noUi.asked).toEqual([])
    expect(await load().tool_call(call, undefined)).toEqual(blocked)
    // An input that cannot be written down as JSON cannot be asked about.
    const loop: Record<string, unknown> = {}
    loop.self = loop
    expect(await load().tool_call({ ...call, input: loop }, ui(async () => 'allow').ctx)).toEqual(blocked)
  })

  it('[U:pi-gate] takes its timeout from the environment, and falls back to 30 seconds on nonsense', async () => {
    for (const [value, want] of [['250', 250], ['0', 30_000], ['-5', 30_000], ['soon', 30_000]] as const) {
      process.env.SWARM_GATE_TIMEOUT_MS = value
      const u = ui(async () => 'deny')
      await load().tool_call(call, u.ctx)
      expect(u.asked[0].opts).toEqual({ timeout: want })
    }
  })
})
