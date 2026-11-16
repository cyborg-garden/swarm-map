// A watcher for a harness the tripwire cannot be loaded into. The tripwire
// (tripwire.ts, child-tripwire.ts) is JavaScript, loaded into a Node process.
// A harness that is a compiled program has no place for it. What such a
// harness can be given is a proxy: it is told, in its environment, to send
// its HTTP traffic through this one. The proxy passes on a request to this
// machine and counts it, and refuses and records a request to anywhere else.
//
// What it shows is narrower than the tripwire, and the difference matters:
// - It sees only traffic the harness chose to send through a proxy. A
//   program that ignores its proxy settings, or opens a raw socket, or asks
//   DNS directly, is not seen. The tripwire stops those; this cannot.
// - So "nothing was recorded" means "its HTTP client reached for nothing
//   else", not "it reached for nothing else". Only the sealed Docker cell
//   shows the second.
// - `carried` is its proof of life: a watcher that carried no request saw
//   nothing, and that is reported as a failure, never read as "all quiet".
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { isLoopback } from './tripwire.ts'

export interface WatchProxy {
  /** What to put in HTTP_PROXY and HTTPS_PROXY. */
  url: string
  /** Requests to this machine that went through it. */
  carried(): number
  /** Every request it refused because it was for somewhere else. */
  attempts(): string[]
  /** The same two, counted from now on: one proxy can watch one harness run after another. */
  mark(): { carried(): number; attempts(): string[] }
  close(): void
}

/** The environment that sends a harness's HTTP traffic through the proxy at `url`: all of it, loopback included. */
export function watchProxyEnv(url: string): Record<string, string> {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url }
}

export function startWatchProxy(): Promise<WatchProxy> {
  const attempts: string[] = []
  let carried = 0
  const sockets = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    let target: URL
    try { target = new URL(req.url ?? '') } catch { res.writeHead(400).end(); return }
    if (target.protocol !== 'http:' || !isLoopback(target.hostname)) {
      attempts.push(`${req.method ?? 'GET'} ${target.protocol}//${target.host}`)
      res.writeHead(403, { 'content-type': 'text/plain' }).end('watch proxy: not this machine')
      return
    }
    carried++
    const headers = { ...req.headers }
    delete headers['proxy-connection']
    const upstream = http.request({
      path: target.pathname + target.search, method: req.method, headers,
      createConnection: () => net.connect({ host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 80) }),
    }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end() })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  })
  // A tunnel (what an https request asks a proxy for): to this machine it is opened, to anywhere else it is refused and recorded.
  server.on('connect', (req, socket) => {
    const [host, port] = (req.url ?? '').split(/:(?=\d+$)/)
    if (!isLoopback(host)) {
      attempts.push(`CONNECT ${req.url ?? ''}`)
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
      return
    }
    carried++
    const upstream = net.connect({ host: host.replace(/^\[|\]$/g, ''), port: Number(port) }, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        carried: () => carried,
        attempts: () => [...attempts],
        mark: () => {
          const from = { carried, attempts: attempts.length }
          return { carried: () => carried - from.carried, attempts: () => attempts.slice(from.attempts) }
        },
        close: () => { for (const socket of sockets) socket.destroy(); server.close() },
      })
    })
  })
}

/** Send one request the way a program told to use a proxy would: to the proxy if `env` names one, else straight to where it is going. */
export function requestVia(
  env: Record<string, string | undefined>, url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<http.IncomingMessage> {
  const target = new URL(url)
  const proxy = env.HTTP_PROXY ?? env.http_proxy
  const via = proxy ? new URL(proxy) : undefined
  return new Promise((resolve, reject) => {
    const to = via ?? target
    const req = http.request({
      path: via ? url : target.pathname + target.search,
      method: init.method ?? 'GET', headers: { host: target.host, ...init.headers },
      // The connection is opened by hand so that what is dialled is plainly a host and a port.
      createConnection: () => net.connect({ host: to.hostname.replace(/^\[|\]$/g, ''), port: Number(to.port || 80) }),
    }, resolve)
    req.on('error', reject)
    req.end(init.body)
  })
}
