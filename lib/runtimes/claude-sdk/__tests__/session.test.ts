// @vitest-environment node
//
// The pump, driven by a stand-in for the SDK. What must hold: a reply is only
// what the SDK says a finished turn said, a tool runs only on the exact
// answer yes, and a session that is not what it was started as is stopped.
import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_VERSION } from '../caps.ts'
import type { PermissionResult, SdkOptions } from '../sdk.ts'
import { createClaudeSession, DENIED, NeverStarted, type ClaudeSessionOptions } from '../session.ts'
import { claudeSdkOptions } from '../shim.ts'
import { done, init, stubSdk, type Play } from './stub-sdk.ts'

const options = (tools: string[] = ['Bash']) => claudeSdkOptions({ tools, model: 'scripted', cwd: '/cell/work', env: {} })
const session = (play: Play, o: Partial<ClaudeSessionOptions> = {}, tools?: string[]) => {
  const stub = stubSdk(play)
  return { stub, session: createClaudeSession(stub.sdk, options(tools), { onGate: async () => false, ...o }) }
}
/** A turn in which the SDK asks about one tool, and says what it was told. */
const asks = (tool = 'Bash', input: Record<string, unknown> = { command: 'ls' }): Play => async function* (_text, o: SdkOptions) {
  yield init(o)
  const answer = await o.canUseTool!(tool, input, { signal: new AbortController().signal })
  yield done(JSON.stringify(answer))
}
const answerOf = (text: string): PermissionResult => JSON.parse(text)

describe('the Claude Agent SDK pump: turns', () => {
  it('[U:claude-sdk-session] a turn ends at the result record, and its reply is that record\'s text', async () => {
    const { session: s, stub } = session(function* (text, o) { yield init(o); yield { type: 'assistant' }; yield done(`you said ${text}`) })
    expect(await s.prompt('hello')).toEqual({ text: 'you said hello' })
    expect(await s.prompt('again')).toEqual({ text: 'you said again' })
    expect(stub.sent).toEqual([{ session: 0, text: 'hello' }, { session: 0, text: 'again' }])
    expect(stub.started).toHaveLength(1)
    expect(s.sessionId()).toBe('session-1')
  })

  it('[U:claude-sdk-session] a failed model call is not a reply: the SDK writes the error where a reply would be, under the subtype success', async () => {
    const { session: s } = session(function* (_text, o) { yield init(o); yield done('API Error: 402 Monthly budget spent.', { is_error: true }) })
    await expect(s.prompt('hello')).rejects.toThrow('the SDK ended the turn with an error')
  })

  it.each([
    ['another subtype', { subtype: 'error_during_execution' }],
    ['no text at all', { result: undefined }],
    ['no word on whether it failed', { is_error: undefined }],
    ['is_error set to something that is not the plain value false', { is_error: 'false' as never }],
  ])('[U:claude-sdk-session] a result with %s is not a reply either', async (_what, patch) => {
    const { session: s } = session(function* (_text, o) { yield init(o); yield done('looks fine', patch) })
    await expect(s.prompt('hello')).rejects.toThrow('the SDK ended the turn with an error')
  })

  it('[U:claude-sdk-session] a turn the SDK ends without first saying it has started is not a reply, whatever it says: its version and its tools were never checked', async () => {
    for (const patch of [{}, { is_error: true }, { subtype: 'error_during_execution', is_error: true }]) {
      const { session: s } = session(function* () { yield done('looks fine', patch) })
      const failed = await s.prompt('hello').then(() => undefined, (err: Error) => err)
      expect(failed, JSON.stringify(patch)).toBeInstanceOf(NeverStarted)
    }
    // Positive control: the same record after it has said so is a reply.
    const { session: s } = session(function* (_text, o) { yield init(o); yield done('looks fine') })
    expect(await s.prompt('hello')).toEqual({ text: 'looks fine' })
    // And an ordinary failed turn is not taken for a session that never started.
    const { session: failing } = session(function* (_text, o) { yield init(o); yield done('API Error', { is_error: true }) })
    const err = await failing.prompt('hello').then(() => undefined, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(NeverStarted)
  })

  it('[U:claude-sdk-session] a session that ends, or throws, before its turn is finished fails the turn', async () => {
    const ends = session(function* (_text, o) { yield init(o); return 'end' })
    await expect(ends.session.prompt('hello')).rejects.toThrow('ended before the turn was finished')
    const throws = session(function* (_text, o) { yield init(o); throw new Error('the process died') })
    await expect(throws.session.prompt('hello')).rejects.toThrow('the process died')
    await expect(throws.session.prompt('again')).rejects.toThrow('closed')
  })

  it('[U:claude-sdk-session] a session that never says it has started is given up on, and stopped', async () => {
    const { session: s, stub } = session(async function* () { await new Promise((resolve) => setTimeout(resolve, 2000)) }, { startMs: 60 })
    await expect(s.prompt('hello')).rejects.toThrow('did not say it had started in time')
    expect(stub.closed).toEqual([0])
  })

  it('[U:claude-sdk-session] one turn at a time', async () => {
    const { session: s } = session(async function* (_text, o) { yield init(o); await new Promise((resolve) => setTimeout(resolve, 40)); yield done('slow') })
    const first = s.prompt('one')
    await expect(s.prompt('two')).rejects.toThrow('busy')
    expect(await first).toEqual({ text: 'slow' })
  })

  it('[U:claude-sdk-session] a session that reports a tool it was not started with is stopped before anything more is sent', async () => {
    for (const reported of [['Bash', 'WebFetch'], ['Read'], []]) {
      const { session: s, stub } = session(function* (_text, o) { yield init(o, { tools: reported }); yield done('too late') })
      await expect(s.prompt('hello')).rejects.toThrow('started with tools the turn was not offered')
      expect(stub.closed).toEqual([0])
      await expect(s.prompt('again')).rejects.toThrow('closed')
    }
    // Positive control: the same tools in another order are the same tools.
    const same = session(function* (_text, o) { yield init(o, { tools: ['Read', 'Bash'] }); yield done('fine') }, {}, ['Bash', 'Read'])
    expect(await same.session.prompt('hello')).toEqual({ text: 'fine' })
  })

  it('[U:claude-sdk-version] a session that turns out to run another version of Claude Code is stopped', async () => {
    for (const version of ['2.1.326', undefined, `${CLAUDE_CODE_VERSION} `]) {
      const { session: s, stub } = session(function* (_text, o) { yield init(o, { claude_code_version: version }); yield done('too late') })
      await expect(s.prompt('hello')).rejects.toThrow('not the pinned version')
      expect(stub.closed).toEqual([0])
    }
  })
})

describe('the Claude Agent SDK pump: the veto', () => {
  it('[U:claude-sdk-session] a tool runs only on the exact answer yes, and is handed back the input it asked with', async () => {
    const seen: unknown[] = []
    const { session: s } = session(asks('Bash', { command: 'ls' }), { onGate: async (call) => { seen.push(call); return true } })
    expect(answerOf((await s.prompt('go')).text)).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } })
    expect(seen).toEqual([{ tool: 'Bash', input: { command: 'ls' } }])
  })

  it.each([
    ['false', async () => false],
    ['the word yes', async () => 'yes' as never],
    ['the number one', async () => 1 as never],
    ['an object that says allow', async () => ({ allow: true }) as never],
    ['nothing', async () => undefined as never],
    ['an error', async () => { throw new Error('the link is down') }],
  ])('[U:claude-sdk-session] %s is a no', async (_what, onGate) => {
    const { session: s } = session(asks(), { onGate })
    expect(answerOf((await s.prompt('go')).text)).toEqual({ behavior: 'deny', message: DENIED })
  })

  it('[U:claude-sdk-session] no answer in time is a no, and the SDK is told so without waiting any longer', async () => {
    const { session: s } = session(asks(), { onGate: () => new Promise(() => {}), vetoTimeoutMs: 60 })
    const started = Date.now()
    expect(answerOf((await s.prompt('go')).text)).toEqual({ behavior: 'deny', message: DENIED })
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('[U:claude-sdk-session] a yes that comes after the time is up changes nothing', async () => {
    const { session: s } = session(asks(), { onGate: () => new Promise((resolve) => setTimeout(() => resolve(true), 200)), vetoTimeoutMs: 40 })
    expect(answerOf((await s.prompt('go')).text)).toEqual({ behavior: 'deny', message: DENIED })
  })

  it('[U:claude-sdk-session] asked when no turn is open, the answer is no and nobody is asked', async () => {
    let asked = 0
    let late: Promise<PermissionResult> | undefined
    const { session: s } = session(function* (_text, o) {
      yield init(o)
      yield done('finished')
      // The turn is over. Asking about a tool now is asking with no turn live.
      late = o.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal })
    }, { onGate: async () => { asked++; return true } })
    expect(await s.prompt('go')).toEqual({ text: 'finished' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await late).toEqual({ behavior: 'deny', message: DENIED })
    expect(asked).toBe(0)
  })

  it('[U:claude-sdk-session] closing a session stops the SDK, and it is sent nothing more', async () => {
    const { session: s, stub } = session(function* (_text, o) { yield init(o); yield done('ok') })
    await s.prompt('one')
    s.close()
    expect(stub.closed).toEqual([0])
    await expect(s.prompt('two')).rejects.toThrow('closed')
    expect(stub.sent).toHaveLength(1)
  })
})
