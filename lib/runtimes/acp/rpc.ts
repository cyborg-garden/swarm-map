// JSON-RPC 2.0 over a child's stdin and stdout, one record per line. This is
// the transport the Agent Client Protocol uses when a client starts an agent
// as a subprocess (agentclientprotocol.com, protocol version 1). Both ends
// send requests: the client asks the agent to start a session and run a
// prompt, and the agent asks the client for permission to run a tool.
//
// It decides nothing. A request the client side has no handler for is
// answered with "method not found", so an agent that asks for something the
// client never offered (a file read, a terminal) gets an error, not silence.
import type { Readable, Writable } from 'node:stream'
import { createLineDecoder, encodeLine } from '../../door/framing.ts'

export interface AcpProcess {
  stdin: Writable
  stdout: Readable
  onExit(cb: (code: number | null) => void): void
  kill(): void
}

export interface RpcError { code: number; message: string }

export class RpcFailure extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

/** The JSON-RPC error code for a method nobody offered. */
export const METHOD_NOT_FOUND = -32601
const INTERNAL = -32603

export type RequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown

export interface RpcPeer {
  /** Send a request and wait for its answer. Rejects on an error answer, on a timeout, or when the process ends. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>
  notify(method: string, params: unknown): void
  /** The one handler for requests from the other side. Throw RpcFailure to answer with an error. */
  onRequest(handler: RequestHandler): void
  onNotification(cb: (method: string, params: unknown) => void): void
  /** Resolves when the process has ended. */
  readonly ended: Promise<void>
  close(): void
}

interface Record {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  result?: unknown
  error?: { code?: unknown; message?: unknown }
}

const isId = (v: unknown): v is string | number => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))

export function createRpcPeer(proc: AcpProcess): RpcPeer {
  let nextId = 1
  let over = false
  const waiting = new Map<string | number, { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout }>()
  let handler: RequestHandler = () => { throw new RpcFailure(METHOD_NOT_FOUND, 'Method not found') }
  const listeners: ((method: string, params: unknown) => void)[] = []
  let markEnded!: () => void
  const ended = new Promise<void>((resolve) => { markEnded = resolve })

  const write = (record: unknown): void => {
    if (over) return
    try { proc.stdin.write(encodeLine(record)) } catch { /* the process is gone; its exit settles everything */ }
  }

  const end = (): void => {
    if (over) return
    over = true
    for (const [id, w] of waiting) {
      clearTimeout(w.timer)
      waiting.delete(id)
      w.reject(new Error('the agent process ended'))
    }
    markEnded()
  }

  const answer = async (id: string | number, method: string, params: unknown): Promise<void> => {
    try {
      const result = await handler(method, params)
      write({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (err) {
      const failure = err instanceof RpcFailure ? err : new RpcFailure(INTERNAL, 'Internal error')
      write({ jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message } })
    }
  }

  const decoder = createLineDecoder((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
    const r = raw as Record
    if (r.jsonrpc !== '2.0') return
    if (typeof r.method === 'string') {
      if (isId(r.id)) void answer(r.id, r.method, r.params)
      else for (const cb of listeners) cb(r.method, r.params)
      return
    }
    if (!isId(r.id)) return
    const w = waiting.get(r.id)
    if (!w) return
    waiting.delete(r.id)
    clearTimeout(w.timer)
    if (r.error !== undefined) {
      const code = typeof r.error?.code === 'number' ? r.error.code : INTERNAL
      const message = typeof r.error?.message === 'string' ? r.error.message : 'error'
      w.reject(new RpcFailure(code, message))
    } else {
      w.resolve(r.result)
    }
  })
  proc.stdout.on('data', (chunk: Buffer) => decoder.push(chunk))
  proc.stdout.on('error', () => {})
  proc.stdin.on('error', () => {})
  proc.onExit(() => end())

  return {
    request(method, params, timeoutMs) {
      if (over) return Promise.reject(new Error('the agent process ended'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const w: { resolve(v: unknown): void; reject(e: Error): void; timer?: NodeJS.Timeout } = { resolve, reject }
        if (timeoutMs !== undefined) {
          w.timer = setTimeout(() => {
            if (waiting.delete(id)) reject(new Error(`no answer to ${method} in time`))
          }, timeoutMs)
        }
        waiting.set(id, w)
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) { write({ jsonrpc: '2.0', method, params }) },
    onRequest(h) { handler = h },
    onNotification(cb) { listeners.push(cb) },
    ended,
    close() {
      end()
      try { proc.kill() } catch { /* already gone */ }
    },
  }
}
