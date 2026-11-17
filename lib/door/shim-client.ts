// The shim's end of the brain protocol, shared by every shim. It dials the
// sidecar, says hello, and turns "may I run this tool?" into a promise that
// resolves to no unless the sidecar says yes in time. A shim must never run a
// tool on any other answer.
import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { createLineDecoder, encodeLine } from './framing.ts'
import { PROTOCOL_VERSION, type Capabilities, type FromShim, type ToShim } from './protocol.ts'

/** `hash` comes with a yes: the hash of the call the sidecar said yes to. */
export interface ToolAnswer { allow: boolean; reason?: string; hash?: string }

export interface WebAnswer { ok: boolean; text?: string; reason?: string }

export interface ShimClient {
  send(msg: FromShim): void
  onMessage(cb: (msg: ToShim) => void): void
  /** Ask the sidecar. Timeout, a lost link, or anything but an explicit yes is a no. */
  /** `named` is told the id the call is put to the door under: a web call's page is asked for by it. */
  requestTool(turnId: string, tool: string, input: unknown, named?: (callId: string) => void): Promise<ToolAnswer>
  /** Ask the door to fetch the page for a web call it said yes to. Timeout or a lost link is a failure. */
  webFetch(callId: string, url: string, timeoutMs?: number): Promise<WebAnswer>
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
    const pages = new Map<string, (answer: WebAnswer) => void>()

    const decoder = createLineDecoder((record) => {
      const msg = record as ToShim
      if (msg.t === 'tool_verdict') {
        // Only a pending call can be answered, and only once.
        waiting.get(msg.callId)?.({
          allow: msg.allow === true, ...(msg.reason ? { reason: msg.reason } : {}),
          ...(msg.allow === true && typeof msg.hash === 'string' ? { hash: msg.hash } : {}),
        })
        return
      }
      if (msg.t === 'web_result') {
        pages.get(msg.callId)?.({
          ok: msg.ok === true, ...(typeof msg.text === 'string' ? { text: msg.text } : {}), ...(typeof msg.reason === 'string' ? { reason: msg.reason } : {}),
        })
        return
      }
      for (const cb of listeners) cb(msg)
    })

    socket.on('data', (chunk) => decoder.push(chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      for (const answer of [...waiting.values()]) answer({ allow: false, reason: 'link closed' })
      for (const answer of [...pages.values()]) answer({ ok: false, reason: 'link closed' })
    })
    socket.on('connect', () => {
      socket.off('error', reject)
      socket.on('error', () => {})
      const send = (msg: FromShim): void => { if (!socket.destroyed) socket.write(encodeLine(msg)) }
      send({ t: 'hello', token: opts.token, protocol: PROTOCOL_VERSION, caps: opts.caps })
      resolve({
        send,
        onMessage: (cb) => { listeners.push(cb) },
        requestTool: (turnId, tool, input, named) => new Promise<ToolAnswer>((done) => {
          const callId = randomUUID()
          named?.(callId)
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
        webFetch: (callId, url, timeoutMs) => new Promise<WebAnswer>((done) => {
          if (pages.has(callId)) return done({ ok: false, reason: 'already asked' })
          const finish = (answer: WebAnswer): void => {
            if (!pages.delete(callId)) return
            clearTimeout(timer)
            done(answer)
          }
          const timer = setTimeout(() => finish({ ok: false, reason: 'no answer in time' }), timeoutMs ?? 30_000)
          pages.set(callId, finish)
          if (socket.destroyed) return finish({ ok: false, reason: 'link closed' })
          send({ t: 'web_fetch', callId, url })
        }),
        close: () => socket.destroy(),
      })
    })
  })
}
