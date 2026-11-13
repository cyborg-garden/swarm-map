// The sidecar's end of the brain protocol. It listens for the one shim in its
// cell, and talks to nobody who has not said hello with this cell's token.
import { timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { createLineDecoder, encodeLine } from './framing.ts'
import { capsProblem, PROTOCOL_VERSION, type Capabilities, type FromShim, type ToShim } from './protocol.ts'

export interface ShimLink {
  send(msg: ToShim): void
  onMessage(cb: (msg: FromShim) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface BrainServer {
  port: number
  /** Resolves once a shim has said hello and been accepted. */
  connected(): Promise<void>
  close(): Promise<void>
}

export interface BrainServerOptions {
  /** Per-cell token. The shim must present it in `hello`. */
  token: string
  onShim: (link: ShimLink, caps: Capabilities) => void
  onRefused?: (why: string) => void
  host?: string
  port?: number
  helloTimeoutMs?: number
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createBrainServer(opts: BrainServerOptions): Promise<BrainServer> {
  const sockets = new Set<net.Socket>()
  let current: net.Socket | undefined
  let announce: (() => void) | undefined
  let accepted = new Promise<void>((resolve) => { announce = resolve })

  const server = net.createServer((socket) => {
    sockets.add(socket)
    let greeted = false
    const listeners: ((msg: FromShim) => void)[] = []
    const closers: (() => void)[] = []

    const refuse = (why: string): void => {
      opts.onRefused?.(why)
      socket.destroy()
    }
    const helloTimer = setTimeout(() => { if (!greeted) refuse('no hello in time') }, opts.helloTimeoutMs ?? 5000)

    const decoder = createLineDecoder((record) => {
      const msg = record as FromShim
      if (!greeted) {
        if (msg === null || typeof msg !== 'object' || msg.t !== 'hello') return refuse('first message was not hello')
        if ((msg.protocol as number) !== PROTOCOL_VERSION) return refuse(`unsupported protocol ${msg.protocol}`)
        if (typeof msg.token !== 'string' || !sameToken(msg.token, opts.token)) return refuse('wrong token')
        if (current) return refuse('a shim is already connected')
        const problem = capsProblem(msg.caps)
        if (problem) return refuse(`bad capabilities: ${problem}`)
        greeted = true
        current = socket
        clearTimeout(helloTimer)
        opts.onShim({
          send: (out) => { if (!socket.destroyed) socket.write(encodeLine(out)) },
          onMessage: (cb) => { listeners.push(cb) },
          onClose: (cb) => { closers.push(cb) },
          close: () => socket.destroy(),
        }, msg.caps)
        announce?.()
        return
      }
      for (const cb of listeners) cb(msg)
    })

    socket.on('data', (chunk) => { if (!socket.destroyed) decoder.push(chunk) })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(helloTimer)
      sockets.delete(socket)
      if (current === socket) {
        current = undefined
        accepted = new Promise<void>((resolve) => { announce = resolve })
        for (const cb of closers) cb()
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        connected: () => accepted,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}
