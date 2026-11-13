// The Pi RPC pump: one `pi --mode rpc` child process, driven over its stdin
// and stdout. Checked against Pi 1.5.2.
//
// - A prompt is finished at `agent_settled`, never at `agent_end` (retries
//   and follow-ups can still come after `agent_end`).
// - The reply is the last finished assistant message that is not a tool call.
// - The in-cell gate asks "may I run this tool?" through Pi's extension UI
//   channel: a `select` whose title starts with GATE_PREFIX. Only the exact
//   answer `allow` lets the tool run.
// - The gate says it is loaded with a `notify` whose message is GATE_READY.
//   Until that arrives no prompt is written to Pi at all. If it does not
//   arrive in time, every prompt is refused for the life of this process:
//   a Pi with no gate would run every tool it was started with, unasked.
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { createLineDecoder, encodeLine } from '../../door/framing.ts'

export const GATE_PREFIX = 'swarm-gate:v1:'
export const GATE_READY = 'swarm-gate:v1:ready'

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
  /** An object on `message_end`; plain text on a `notify`. */
  message?: string | { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] }
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])

export interface PiRpcOptions {
  onGate: (call: GateCall) => Promise<boolean>
  /** How long the gate has, from process start, to announce itself. Default 15 seconds. */
  gateReadyMs?: number
}

export function createPiRpc(proc: PiProcess, opts: PiRpcOptions): PiRpc {
  let current: { id: string; text: string; resolve: (r: PiTurnResult) => void; reject: (e: Error) => void } | undefined
  const send = (record: unknown): void => { proc.stdin.write(encodeLine(record)) }

  // Settles once: true when the gate announced itself in time, false otherwise.
  let gateSettled: (loaded: boolean) => void = () => {}
  const gateLoaded = new Promise<boolean>((resolve) => { gateSettled = resolve })
  const gateTimer = setTimeout(() => gateSettled(false), opts.gateReadyMs ?? 15_000)
  gateTimer.unref?.()

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
        if (r.method === 'notify' && r.message === GATE_READY) { clearTimeout(gateTimer); gateSettled(true); return }
        if (!r.id || !DIALOGS.has(r.method ?? '')) return // other notices need no answer
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
        const m = typeof r.message === 'object' ? r.message : undefined
        if (!current || m?.role !== 'assistant' || m.stopReason === 'toolUse') return
        const text = (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
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
    clearTimeout(gateTimer)
    gateSettled(false) // no effect if it already announced
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
        const turn = { id, text: '', resolve, reject }
        current = turn
        void gateLoaded.then((loaded) => {
          if (current !== turn) return // Pi exited while we waited; the turn was already rejected
          if (loaded) return send({ id, type: 'prompt', message })
          current = undefined
          reject(new Error('the tool gate did not announce itself, so Pi is sent no turn'))
        })
      })
    },
    close: () => { clearTimeout(gateTimer); proc.kill() },
  }
}
