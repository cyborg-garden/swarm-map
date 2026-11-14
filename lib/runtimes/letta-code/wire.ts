// The Letta Code pump: one headless Letta Code process, driven over its
// stdin and stdout as JSON lines (`--input-format stream-json --output-format
// stream-json`). Checked against Letta Code 0.34.60.
//
// - The process says which agent and conversation it is in one `system` /
//   `init` record. Nothing is sent to it before that.
// - A turn is one `user` line in. It is finished at the `result` record, and
//   only there: `stop_reason` records come once per model call, and one of
//   them (`requires_approval`) means the turn is still going.
// - The reply is the last assistant message that no tool call followed.
// - Started in strict permission mode, Letta Code asks before every tool: a
//   `control_request` of subtype `can_use_tool`. It then waits for as long as
//   it takes. It has no timeout of its own, so the veto's timeout is here:
//   whoever is asked gets `vetoTimeoutMs`, and after that the answer is no.
//   Only the exact answer `true` lets the tool run. A question that comes
//   when no turn is open is answered no without asking anyone.
import type { Readable, Writable } from 'node:stream'
import { createLineDecoder, encodeLine } from '../../door/framing.ts'

export interface LettaCodeProcess {
  stdin: Writable
  stdout: Readable
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface GateCall { tool: string; input: unknown; callId: string }
export interface TurnResult { text: string; aborted: boolean }
export interface Started { agentId: string; conversationId: string }

export interface LettaCodeWire {
  /** Which agent and conversation the process is. Rejects if it stops, or says nothing in time. */
  started(): Promise<Started>
  /** Send one message and wait until Letta Code has truly finished. One at a time. */
  prompt(message: string): Promise<TurnResult>
  close(): void
}

export interface LettaCodeWireOptions {
  onGate: (call: GateCall) => Promise<boolean>
  /** How long a tool call waits for its answer before the answer is no. Default 30 seconds. */
  vetoTimeoutMs?: number
  /** How long the process has, from its start, to say which agent it is. Default 30 seconds. */
  startMs?: number
}

interface WireRecord {
  type?: string
  subtype?: string
  agent_id?: string
  conversation_id?: string
  request_id?: string
  request?: { subtype?: string; tool_name?: string; input?: unknown; tool_call_id?: string }
  message_type?: string
  id?: string
  content?: string | { type?: string; text?: string }[]
}

export const DENIED = 'swarm gate: not allowed'

export function createLettaCodeWire(proc: LettaCodeProcess, opts: LettaCodeWireOptions): LettaCodeWire {
  let current: { text: string; messageId?: string; resolve: (r: TurnResult) => void; reject: (e: Error) => void } | undefined
  const send = (record: unknown): void => { proc.stdin.write(encodeLine(record)) }

  let settleStart: { resolve: (s: Started) => void; reject: (e: Error) => void }
  const start = new Promise<Started>((resolve, reject) => { settleStart = { resolve, reject } })
  start.catch(() => {}) // a caller may never ask
  const startTimer = setTimeout(() => settleStart.reject(new Error('Letta Code did not say it had started in time')), opts.startMs ?? 30_000)
  startTimer.unref?.()

  const gate = async (requestId: string, request: NonNullable<WireRecord['request']>): Promise<void> => {
    let allow = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Asked outside a turn: nobody is asked, and the answer is no.
      if (!current) throw new Error('no turn is open')
      const call: GateCall = { tool: String(request.tool_name ?? ''), input: request.input, callId: String(request.tool_call_id ?? '') }
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), opts.vetoTimeoutMs ?? 30_000) })
      allow = (await Promise.race([opts.onGate(call), late])) === true
    } catch {
      allow = false // unreadable request, or no answer: the tool does not run
    } finally {
      clearTimeout(timer)
    }
    send({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: allow ? { behavior: 'allow' } : { behavior: 'deny', message: DENIED } },
    })
  }

  const textOf = (content: WireRecord['content']): string =>
    typeof content === 'string' ? content : (content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')

  const decoder = createLineDecoder((raw) => {
    const r = raw as WireRecord
    switch (r.type) {
      case 'system':
        if (r.subtype === 'init' && typeof r.agent_id === 'string' && typeof r.conversation_id === 'string') {
          clearTimeout(startTimer)
          settleStart.resolve({ agentId: r.agent_id, conversationId: r.conversation_id })
        }
        return
      case 'control_request':
        if (typeof r.request_id !== 'string') return
        if (r.request?.subtype === 'can_use_tool') void gate(r.request_id, r.request)
        // Anything else it asks of whoever started it: nobody is here to answer.
        else send({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: 'not supported' } })
        return
      case 'message':
        if (!current) return
        if (r.message_type === 'assistant_message') {
          // One message arrives in pieces that share an id.
          if (r.id !== current.messageId) { current.messageId = r.id; current.text = '' }
          current.text += textOf(r.content)
        } else if (r.message_type === 'tool_call_message' || r.message_type === 'tool_return_message') {
          // What it said before a tool call is not its answer.
          current.messageId = undefined
          current.text = ''
        }
        return
      case 'result': {
        if (!current) return
        const turn = current
        current = undefined
        if (r.subtype === 'success') turn.resolve({ text: turn.text, aborted: false })
        else if (r.subtype === 'interrupted') turn.resolve({ text: '', aborted: true })
        else turn.reject(new Error('Letta Code ended the turn with an error'))
        return
      }
      default:
    }
  })
  proc.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  proc.onExit((code) => {
    clearTimeout(startTimer)
    const gone = new Error(`Letta Code exited (${code}) before the turn was finished`)
    settleStart.reject(gone) // no effect if it already started
    if (!current) return
    const turn = current
    current = undefined
    turn.reject(gone)
  })

  return {
    started: () => start,
    prompt(message) {
      if (current) return Promise.reject(new Error('Letta Code is busy with another turn'))
      return new Promise<TurnResult>((resolve, reject) => {
        const turn = { text: '', resolve, reject }
        current = turn
        start.then(() => {
          if (current === turn) send({ type: 'user', message: { role: 'user', content: message } })
        }, (err: Error) => {
          if (current !== turn) return // it exited while we waited; the turn was already rejected
          current = undefined
          reject(err)
        })
      })
    },
    close: () => { clearTimeout(startTimer); proc.kill() },
  }
}
