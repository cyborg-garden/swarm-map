// @vitest-environment node
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLineDecoder } from '../../../door/framing.ts'
import { createPiRpc, GATE_READY, type PiProcess } from '../rpc.ts'

/**
 * A stand-in for the Pi child process: the test plays Pi's side by hand.
 * By default it announces the gate at once, as Pi does when the gate loads.
 */
function fakeProcess(o: { gate?: 'announced' | 'silent' } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const sent: Record<string, unknown>[] = []
  const decoder = createLineDecoder((r) => sent.push(r as Record<string, unknown>))
  stdin.on('data', (c) => decoder.push(c))
  let exit: (code: number | null) => void = () => {}
  const proc: PiProcess = { stdin, stdout, onExit: (cb) => { exit = cb }, kill: () => exit(null) }
  const emit = (record: unknown): void => { stdout.write(JSON.stringify(record) + '\n') }
  const announce = (): void => emit({ type: 'extension_ui_request', id: 'ready', method: 'notify', message: GATE_READY, notifyType: 'info' })
  if (o.gate !== 'silent') announce()
  return { proc, sent, emit, announce, exit: (code: number) => exit(code) }
}

const assistant = (text: string, stopReason = 'stop') =>
  ({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('Pi RPC pump', () => {
  it('[U:pi-rpc] sends a prompt and resolves with the final text only at agent_settled', async () => {
    const pi = fakeProcess()
    const rpc = createPiRpc(pi.proc, { onGate: async () => false })
    let settled = false
    const turn = rpc.prompt('hello').then((r) => { settled = true; return r })
    await tick()
    expect(pi.sent).toEqual([{ id: expect.any(String), type: 'prompt', message: 'hello' }])

    pi.emit({ id: pi.sent[0].id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
    pi.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } })
    pi.emit(assistant('', 'toolUse'))
    pi.emit(assistant('first answer'))
    pi.emit({ type: 'agent_end' })
    await tick()
    expect(settled).toBe(false) // agent_end is not the end: a retry or follow-up can still come
    pi.emit(assistant('final answer'))
    pi.emit({ type: 'agent_end' })
    pi.emit({ type: 'agent_settled', aborted: false })
    expect(await turn).toEqual({ text: 'final answer', aborted: false })
  })

  it('[U:pi-rpc] a record containing U+2028 is not split', async () => {
    const pi = fakeProcess()
    const rpc = createPiRpc(pi.proc, { onGate: async () => false })
    const turn = rpc.prompt('x')
    await tick()
    pi.emit(assistant('line one line two end'))
    pi.emit({ type: 'agent_settled', aborted: false })
    expect((await turn).text).toBe('line one line two end')
  })

  it('[U:pi-rpc] a gate request is put to the caller and answered with exactly allow or deny', async () => {
    const pi = fakeProcess()
    const asked: unknown[] = []
    const rpc = createPiRpc(pi.proc, { onGate: async (call) => { asked.push(call); return call.tool === 'read' } })
    const turn = rpc.prompt('x')
    await tick()
    const title = (tool: string) => 'swarm-gate:v1:' + JSON.stringify({ tool, input: { path: '/etc/hosts' }, callId: `c-${tool}` })
    pi.emit({ type: 'extension_ui_request', id: 'u1', method: 'select', title: title('read'), options: ['allow', 'deny'] })
    pi.emit({ type: 'extension_ui_request', id: 'u2', method: 'select', title: title('bash'), options: ['allow', 'deny'] })
    await tick()
    expect(asked).toEqual([
      { tool: 'read', input: { path: '/etc/hosts' }, callId: 'c-read' },
      { tool: 'bash', input: { path: '/etc/hosts' }, callId: 'c-bash' },
    ])
    expect(pi.sent.slice(1)).toEqual([
      { type: 'extension_ui_response', id: 'u1', value: 'allow' },
      { type: 'extension_ui_response', id: 'u2', value: 'deny' },
    ])
    pi.emit({ type: 'agent_settled', aborted: false })
    await turn
  })

  it('[U:pi-rpc] a gate request that cannot be read, or whose answer throws, is denied', async () => {
    const pi = fakeProcess()
    const rpc = createPiRpc(pi.proc, { onGate: async () => { throw new Error('sidecar gone') } })
    const turn = rpc.prompt('x')
    await tick()
    pi.emit({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'swarm-gate:v1:{not json', options: ['allow', 'deny'] })
    pi.emit({ type: 'extension_ui_request', id: 'u2', method: 'select', title: 'swarm-gate:v1:' + JSON.stringify({ tool: 'bash', input: {}, callId: 'c' }), options: ['allow', 'deny'] })
    await tick()
    expect(pi.sent.slice(1)).toEqual([
      { type: 'extension_ui_response', id: 'u1', value: 'deny' },
      { type: 'extension_ui_response', id: 'u2', value: 'deny' },
    ])
    pi.emit({ type: 'agent_settled', aborted: false })
    await turn
  })

  it('[U:pi-rpc] any other dialog from an extension is cancelled, and notices are ignored', async () => {
    const pi = fakeProcess()
    const rpc = createPiRpc(pi.proc, { onGate: async () => true })
    const turn = rpc.prompt('x')
    await tick()
    pi.emit({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Delete everything?' })
    pi.emit({ type: 'extension_ui_request', id: 'u2', method: 'select', title: 'Pick one', options: ['allow', 'deny'] })
    pi.emit({ type: 'extension_ui_request', id: 'u3', method: 'notify', message: 'fyi' })
    await tick()
    expect(pi.sent.slice(1)).toEqual([
      { type: 'extension_ui_response', id: 'u1', cancelled: true },
      { type: 'extension_ui_response', id: 'u2', cancelled: true },
    ])
    pi.emit({ type: 'agent_settled', aborted: false })
    await turn
  })

  it('[U:pi-gate-ready] no prompt is sent until the gate has announced itself', async () => {
    const pi = fakeProcess({ gate: 'silent' })
    const rpc = createPiRpc(pi.proc, { onGate: async () => true, gateReadyMs: 500 })
    const turn = rpc.prompt('hello')
    await tick()
    await tick()
    expect(pi.sent).toEqual([]) // nothing has reached Pi
    // Other notices, and a notice that only looks like it, do not count.
    pi.emit({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'fyi' })
    pi.emit({ type: 'extension_ui_request', id: 'n2', method: 'notify', message: `${GATE_READY} not` })
    pi.emit({ type: 'extension_ui_request', id: 'n3', method: 'setStatus', statusText: GATE_READY })
    await tick()
    expect(pi.sent).toEqual([])
    pi.announce()
    await tick()
    expect(pi.sent).toEqual([{ id: expect.any(String), type: 'prompt', message: 'hello' }])
    pi.emit(assistant('hi'))
    pi.emit({ type: 'agent_settled', aborted: false })
    expect(await turn).toEqual({ text: 'hi', aborted: false })
  })

  it('[U:pi-gate-ready] a Pi whose gate never announces itself is never sent a turn', async () => {
    const pi = fakeProcess({ gate: 'silent' })
    const rpc = createPiRpc(pi.proc, { onGate: async () => true, gateReadyMs: 40 })
    await expect(rpc.prompt('one')).rejects.toThrow('the tool gate did not announce itself')
    // It stays refused: a late announcement after the deadline does not open it.
    pi.announce()
    await tick()
    await expect(rpc.prompt('two')).rejects.toThrow('the tool gate did not announce itself')
    expect(pi.sent).toEqual([])
  })

  it('[U:pi-gate-ready] a Pi that exits before its gate announced rejects the turn and is sent nothing', async () => {
    const pi = fakeProcess({ gate: 'silent' })
    const rpc = createPiRpc(pi.proc, { onGate: async () => true, gateReadyMs: 5000 })
    const turn = rpc.prompt('one')
    await tick()
    pi.exit(1)
    await expect(turn).rejects.toThrow('pi exited (1) before the turn settled')
    expect(pi.sent).toEqual([])
  })

  it('[U:pi-rpc] a refused prompt, or Pi exiting mid-turn, rejects the turn', async () => {
    const a = fakeProcess()
    const refused = createPiRpc(a.proc, { onGate: async () => false }).prompt('x')
    await tick()
    a.emit({ id: a.sent[0].id, type: 'response', command: 'prompt', success: false, error: 'busy' })
    await expect(refused).rejects.toThrow('pi refused the prompt: busy')

    const b = fakeProcess()
    const died = createPiRpc(b.proc, { onGate: async () => false }).prompt('x')
    await tick()
    b.exit(1)
    await expect(died).rejects.toThrow('pi exited (1) before the turn settled')
  })

  it('[U:pi-rpc] an aborted run reports aborted and no text', async () => {
    const pi = fakeProcess()
    const turn = createPiRpc(pi.proc, { onGate: async () => false }).prompt('x')
    await tick()
    pi.emit(assistant('partial'))
    pi.emit({ type: 'agent_settled', aborted: true })
    expect(await turn).toEqual({ text: '', aborted: true })
  })
})
