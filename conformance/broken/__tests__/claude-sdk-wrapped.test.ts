// @vitest-environment node
//
// "The gate removed", as the Docker cell's C10 needs it for this harness: every call is still put to
// the door, and runs whatever the door says. So the shim sees every question, and only the veto is gone.
import { describe, expect, it } from 'vitest'
import { createClaudeSession } from '../../../lib/runtimes/claude-sdk/session.ts'
import { claudeSdkOptions } from '../../../lib/runtimes/claude-sdk/shim.ts'
import { done, init, stubSdk } from '../../../lib/runtimes/claude-sdk/__tests__/stub-sdk.ts'
import { wrappedSdk } from '../claude-sdk-wrapped.ts'

describe('a broken Claude SDK whose veto is gone', () => {
  it('[U:claude-sdk-must-fail] ignores-answers: the door is asked about every call, says no, and the call runs all the same', async () => {
    const stub = stubSdk(async function* (_text, o) {
      yield init(o)
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } }
      const answer = await o.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_1' })
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ran' }] } }
      yield done(answer.behavior)
    })
    const asked: string[] = []
    const session = createClaudeSession(wrappedSdk(stub.sdk, 'ignores-answers'),
      claudeSdkOptions({ tools: ['Bash'], model: 'scripted', cwd: '/cell/work', env: {} }),
      { onGate: async (call) => { asked.push(call.tool); return false } })
    expect(await session.prompt('hello')).toEqual({ text: 'allow' })
    expect(asked).toEqual(['Bash'])
    // Everything else it was started with is as the shim gave it.
    expect(stub.started[0].settings).toEqual({ permissions: { ask: ['Bash'] } })
    expect(stub.started[0].permissionMode).toBe('default')
    session.close()
  })
})
