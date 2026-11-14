// The shim's end of the brain protocol, shared by every shim. It dials the
// sidecar, says hello, and turns "may I run this tool?" into a promise that
// resolves to no unless the sidecar says yes in time. A shim must never run a
// tool on any other answer.
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { createLineDecoder, encodeLine } from './framing.ts'
import { PROTOCOL_VERSION, type Capabilities, type FromShim, type ToShim } from './protocol.ts'

export interface ToolAnswer { allow: boolean; reason?: string }

export interface ShimClient {
  send(msg: FromShim): void
  onMessage(cb: (msg: ToShim) => void): void
  /** Ask the sidecar. Timeout, a lost link, or anything but an explicit yes is a no. */
  requestTool(turnId: string, tool: string, input: unknown): Promise<ToolAnswer>
  close(): void
}

export interface ShimClientOptions {
  host: string
  port: number
  token: string
  caps: Capabilities
  verdictTimeoutMs?: number
}

export function connectShim(opts: ShimClientOptions): Promise<ShimClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: opts.host, port: opts.port })
    const listeners: ((msg: ToShim) => void)[] = []
    const waiting = new Map<string, (answer: ToolAnswer) => void>()

    const decoder = createLineDecoder((record) => {
      const msg = record as ToShim
      if (msg.t === 'tool_verdict') {
        // Only a pending call can be answered, and only once.
        waiting.get(msg.callId)?.({ allow: msg.allow === true, ...(msg.reason ? { reason: msg.reason } : {}) })
        return
      }
      for (const cb of listeners) cb(msg)
    })

    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      for (const answer of [...waiting.values()]) answer({ allow: false, reason: 'link closed' })
    })
    socket.on('connect', () => {
      socket.off('error', reject)
      socket.on('error', () => {})
      const send = (msg: FromShim): void => { if (!socket.destroyed) socket.write(encodeLine(msg)) }
      send({ t: 'hello', token: opts.token, protocol: PROTOCOL_VERSION, caps: opts.caps })
      resolve({
        send,
        onMessage: (cb) => { listeners.push(cb) },
        requestTool: (turnId, tool, input) => new Promise<ToolAnswer>((done) => {
          const callId = randomUUID()
          const finish = (answer: ToolAnswer): void => {
            if (!waiting.delete(callId)) return
            clearTimeout(timer)
            done(answer)
          }
          const timer = setTimeout(() => finish({ allow: false, reason: 'no verdict in time' }), opts.verdictTimeoutMs ?? 30_000)
          waiting.set(callId, finish)
          if (socket.destroyed) return finish({ allow: false, reason: 'link closed' })
          send({ t: 'tool_request', callId, turnId, tool, input })
        }),
        close: () => socket.destroy(),
      })
    })
  })
}
