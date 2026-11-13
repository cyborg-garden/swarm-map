// The Pi RPC pump: one `pi --mode rpc` child process, driven over its stdin
// and stdout. Checked against Pi 1.5.2.
//
// - A prompt is finished at `agent_settled`, never at `agent_end` (retries
//   and follow-ups can still come after `agent_end`).
// - The reply is the last finished assistant message that is not a tool call.
// - The in-cell gate asks "may I run this tool?" through Pi's extension UI
//   channel: a `select` whose title starts with GATE_PREFIX. Only the exact
//   answer `allow` lets the tool run.
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { createLineDecoder, encodeLine } from '../../door/framing.ts'

export const GATE_PREFIX = 'swarm-gate:v1:'

export interface PiProcess {
  stdin: Writable
  stdout: Readable
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface GateCall { tool: string; input: unknown; callId: string }
export interface PiTurnResult { text: string; aborted: boolean }

export interface PiRpc {
  /** Send one prompt and wait until Pi has truly finished. One at a time. */
  prompt(message: string): Promise<PiTurnResult>
  close(): void
}

interface PiRecord {
  type?: string
  id?: string
  method?: string
  title?: string
  success?: boolean
  error?: string
  aborted?: boolean
  message?: { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] }
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

export function createPiRpc(proc: PiProcess, opts: { onGate: (call: GateCall) => Promise<boolean> }): PiRpc {
  let current: { id: string; text: string; resolve: (r: PiTurnResult) => void; reject: (e: Error) => void } | undefined
  const send = (record: unknown): void => { proc.stdin.write(encodeLine(record)) }

  const gate = async (id: string, title: string): Promise<void> => {
    let allow = false
    try {
      const call = JSON.parse(title.slice(GATE_PREFIX.length)) as GateCall
      allow = (await opts.onGate(call)) === true
    } catch {
      allow = false // unreadable request, or no answer: the tool does not run
    }
    send({ type: 'extension_ui_response', id, value: allow ? 'allow' : 'deny' })
  }

  const decoder = createLineDecoder((raw) => {
    const r = raw as PiRecord
    switch (r.type) {
      case 'extension_ui_request':
        if (!r.id || !DIALOGS.has(r.method ?? '')) return // notices need no answer
        if (r.method === 'select' && r.title?.startsWith(GATE_PREFIX)) void gate(r.id, r.title)
        else send({ type: 'extension_ui_response', id: r.id, cancelled: true }) // nobody is here to answer a dialog
        return
      case 'response':
        if (current && r.id === current.id && r.success === false) {
          const turn = current
          current = undefined
          turn.reject(new Error(`pi refused the prompt: ${r.error ?? 'unknown error'}`))
        }
        return
      case 'message_end': {
        if (!current || r.message?.role !== 'assistant' || r.message.stopReason === 'toolUse') return
        const text = (r.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
        if (text !== '') current.text = text
        return
      }
      case 'agent_settled': {
        if (!current) return
        const turn = current
        current = undefined
        turn.resolve(r.aborted ? { text: '', aborted: true } : { text: turn.text, aborted: false })
        return
      }
      default:
    }
  })
  proc.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  proc.onExit((code) => {
    if (!current) return
    const turn = current
    current = undefined
    turn.reject(new Error(`pi exited (${code}) before the turn settled`))
  })

  return {
    prompt(message) {
      if (current) return Promise.reject(new Error('pi is busy with another turn'))
      return new Promise<PiTurnResult>((resolve, reject) => {
        const id = randomUUID()
        current = { id, text: '', resolve, reject }
        send({ id, type: 'prompt', message })
      })
    },
    close: () => proc.kill(),
  }
}
