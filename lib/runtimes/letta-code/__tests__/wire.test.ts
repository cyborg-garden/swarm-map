// @vitest-environment node
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLineDecoder } from '../../../door/framing.ts'
import { createLettaCodeWire, DENIED, type GateCall, type LettaCodeProcess } from '../wire.ts'

/** A stand-in for the Letta Code child process: the test plays its side by hand. */
function fakeProcess(o: { init?: boolean } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const sent: Record<string, any>[] = []
  const decoder = createLineDecoder((r) => sent.push(r as Record<string, any>))
  stdin.on('data', (c) => decoder.push(c))
  let exit: (code: number | null) => void = () => {}
  const proc: LettaCodeProcess = { stdin, stdout, onExit: (cb) => { exit = cb }, kill: () => exit(null) }
  const emit = (record: unknown): void => { stdout.write(JSON.stringify(record) + '\n') }
  const init = (): void => emit({ type: 'system', subtype: 'init', agent_id: 'agent-1', conversation_id: 'conv-1' })
  if (o.init !== false) init()
  return { proc, sent, emit, init, exit: (code: number) => exit(code) }
}

const piece = (id: string, text: string) => ({ type: 'message', message_type: 'assistant_message', id, content: [{ type: 'text', text }] })
const result = (subtype = 'success') => ({ type: 'result', subtype, result: 'not what the shim reads' })
const asks = (id: string, tool = 'Bash', input: unknown = { command: 'ls' }) =>
  ({ type: 'control_request', request_id: `perm-${id}`, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_call_id: id } })
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))
const never = () => new Promise<boolean>(() => {})
const answers = (sent: Record<string, any>[]) => sent.filter((r) => r.type === 'control_response').map((r) => r.response)

describe('Letta Code pump', () => {
  it('[U:letta-code-wire] nothing is sent until Letta Code has said which agent it is', async () => {
    const lc = fakeProcess({ init: false })
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => false })
    const turn = wire.prompt('hello')
    await tick()
    expect(lc.sent).toEqual([])
    lc.init()
    await tick()
    expect(lc.sent).toEqual([{ type: 'user', message: { role: 'user', content: 'hello' } }])
    expect(await wire.started()).toEqual({ agentId: 'agent-1', conversationId: 'conv-1' })
    lc.emit(result())
    await turn
  })

  it('[U:letta-code-wire] a turn ends at the result record and nowhere else, with the last thing it said', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => true })
    let settled = false
    const turn = wire.prompt('hello').then((r) => { settled = true; return r })
    await tick()
    lc.emit(piece('m1', 'let me look'))
    lc.emit({ type: 'message', message_type: 'stop_reason', stop_reason: 'requires_approval' })
    lc.emit({ type: 'message', message_type: 'tool_call_message', id: 'tool-call-1' })
    lc.emit({ type: 'message', message_type: 'tool_return_message', id: 'tool-return-1' })
    // One message comes in pieces that share an id.
    lc.emit(piece('m2', 'the ans'))
    lc.emit(piece('m2', 'wer'))
    lc.emit({ type: 'message', message_type: 'stop_reason', stop_reason: 'end_turn' })
    await tick()
    expect(settled).toBe(false) // a stop reason is per model call, not the end of the turn
    lc.emit(result())
    expect(await turn).toEqual({ text: 'the answer', aborted: false })
  })

  it('[U:letta-code-wire] what it said before a tool call is not its answer', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => true })
    const turn = wire.prompt('hello')
    await tick()
    lc.emit(piece('m1', 'running a tool now'))
    lc.emit({ type: 'message', message_type: 'tool_call_message', id: 'tool-call-1' })
    lc.emit(result())
    expect(await turn).toEqual({ text: '', aborted: false })
  })

  it('[U:letta-code-wire] a message whose content is plain text is read too, and a record containing U+2028 is not split', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => true })
    const turn = wire.prompt('x')
    await tick()
    lc.emit({ type: 'message', message_type: 'assistant_message', id: 'm1', content: 'line one line two' })
    lc.emit(result())
    expect((await turn).text).toBe('line one line two')
  })

  it('[U:letta-code-wire] a tool runs only when whoever is asked says exactly yes', async () => {
    const lc = fakeProcess()
    const seen: GateCall[] = []
    const verdicts: unknown[] = [true, false, 'allow', 1, undefined]
    const wire = createLettaCodeWire(lc.proc, { onGate: async (call) => { seen.push(call); return verdicts.shift() as boolean } })
    void wire.prompt('x')
    await tick()
    for (const id of ['a', 'b', 'c', 'd', 'e']) lc.emit(asks(id))
    await tick()
    expect(seen[0]).toEqual({ tool: 'Bash', input: { command: 'ls' }, callId: 'a' })
    expect(answers(lc.sent)).toEqual([
      { subtype: 'success', request_id: 'perm-a', response: { behavior: 'allow' } },
      ...['b', 'c', 'd', 'e'].map((id) => ({ subtype: 'success', request_id: `perm-${id}`, response: { behavior: 'deny', message: DENIED } })),
    ])
  })

  it('[U:letta-code-wire] an error while asking is a no', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => { throw new Error('link down') } })
    void wire.prompt('x')
    await tick()
    lc.emit(asks('a'))
    await tick()
    expect(answers(lc.sent)).toEqual([{ subtype: 'success', request_id: 'perm-a', response: { behavior: 'deny', message: DENIED } }])
  })

  it('[U:letta-code-wire] no answer in time is a no, and the no comes from here: Letta Code itself would wait for ever', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: never, vetoTimeoutMs: 40 })
    void wire.prompt('x')
    await tick()
    lc.emit(asks('a'))
    await tick(15)
    expect(answers(lc.sent)).toEqual([]) // still inside the wait
    await tick(60)
    expect(answers(lc.sent)).toEqual([{ subtype: 'success', request_id: 'perm-a', response: { behavior: 'deny', message: DENIED } }])
  })

  it('[U:letta-code-wire] a yes that comes after the wait ran out changes nothing', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: () => new Promise((resolve) => setTimeout(() => resolve(true), 80)), vetoTimeoutMs: 20 })
    void wire.prompt('x')
    await tick()
    lc.emit(asks('a'))
    await tick(120)
    expect(answers(lc.sent)).toEqual([{ subtype: 'success', request_id: 'perm-a', response: { behavior: 'deny', message: DENIED } }])
  })

  it('[U:letta-code-wire] anything else Letta Code asks of whoever started it is refused, and a request with no id is not answered', async () => {
    const lc = fakeProcess()
    let asked = 0
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => { asked++; return true } })
    void wire.prompt('x')
    await tick()
    lc.emit({ type: 'control_request', request_id: 'q1', request: { subtype: 'something_new' } })
    lc.emit({ type: 'control_request', request: { subtype: 'can_use_tool', tool_name: 'Bash' } })
    await tick()
    expect(asked).toBe(0)
    expect(answers(lc.sent)).toEqual([{ subtype: 'error', request_id: 'q1', error: 'not supported' }])
  })

  it('[U:letta-code-wire] a turn Letta Code ends with an error is an error, and one it says was interrupted has no reply', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => false })
    const failed = wire.prompt('x')
    await tick()
    lc.emit(piece('m1', 'half an answer'))
    lc.emit(result('error'))
    await expect(failed).rejects.toThrow(/ended the turn with an error/)
    const stopped = wire.prompt('y')
    await tick()
    lc.emit(piece('m2', 'half an answer'))
    lc.emit(result('interrupted'))
    expect(await stopped).toEqual({ text: '', aborted: true })
  })

  it('[U:letta-code-wire] a process that stops mid-turn fails the turn, and one that stops before it started fails every turn', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => false })
    const turn = wire.prompt('x')
    await tick()
    lc.exit(1)
    await expect(turn).rejects.toThrow(/exited \(1\)/)

    const dead = fakeProcess({ init: false })
    const deadWire = createLettaCodeWire(dead.proc, { onGate: async () => false })
    const first = deadWire.prompt('x')
    dead.exit(1)
    await expect(first).rejects.toThrow(/exited \(1\)/)
    await expect(deadWire.started()).rejects.toThrow(/exited/)
    expect(dead.sent).toEqual([])
  })

  it('[U:letta-code-wire] a process that never says it has started is sent nothing, and its turn is refused', async () => {
    const lc = fakeProcess({ init: false })
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => true, startMs: 30 })
    await expect(wire.prompt('x')).rejects.toThrow(/did not say it had started/)
    expect(lc.sent).toEqual([])
  })

  it('[U:letta-code-wire] one turn at a time', async () => {
    const lc = fakeProcess()
    const wire = createLettaCodeWire(lc.proc, { onGate: async () => false })
    void wire.prompt('x')
    await expect(wire.prompt('y')).rejects.toThrow(/busy/)
  })
})
