// @vitest-environment node
//
// The watcher for a harness that is a compiled program: a proxy it is told to
// use. It must carry a request to this machine, and refuse and record a
// request to anywhere else without ever making it.
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../tripwire.ts'
import { requestVia, startWatchProxy, watchProxyEnv, type WatchProxy } from '../watch-proxy.ts'

armTripwire()

let proxy: WatchProxy | undefined
let target: http.Server | undefined
afterEach(() => {
  proxy?.close()
  target?.close()
  proxy = target = undefined
  // The proxy itself never reached past this machine either: a refused request is not made.
  expect(tripwireAttempts()).toEqual([])
})

const text = async (res: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of res) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}
async function listen(): Promise<string> {
  target = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => res.end(`${req.method} ${req.url} ${req.headers['x-mark'] ?? ''} ${Buffer.concat(chunks).toString('utf8')}`))
  })
  await new Promise<void>((resolve) => target!.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(target.address() as AddressInfo).port}`
}

describe('watch proxy', () => {
  it('[U:watch-proxy] names itself for both kinds of request, in both spellings programs read', async () => {
    proxy = await startWatchProxy()
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(watchProxyEnv(proxy.url)).toEqual({ HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url, https_proxy: proxy.url })
  })

  it('[U:watch-proxy] carries a request to this machine, whole, and counts it', async () => {
    proxy = await startWatchProxy()
    const base = await listen()
    const res = await requestVia(watchProxyEnv(proxy.url), `${base}/v1/messages?beta=true`, { method: 'POST', headers: { 'x-mark': 'kept' }, body: 'the body' })
    expect(res.statusCode).toBe(200)
    expect(await text(res)).toBe('POST /v1/messages?beta=true kept the body')
    expect(proxy.carried()).toBe(1)
    expect(proxy.attempts()).toEqual([])
    // Counted from a mark, an earlier run's traffic is not this run's.
    const mark = proxy.mark()
    expect([mark.carried(), mark.attempts()]).toEqual([0, []])
    await text(await requestVia(watchProxyEnv(proxy.url), `${base}/again`))
    await requestVia(watchProxyEnv(proxy.url), 'http://192.0.2.1:9/')
    expect([mark.carried(), mark.attempts()]).toEqual([1, ['GET http://192.0.2.1:9']])
    expect(proxy.carried()).toBe(2)
  })

  it('[U:watch-proxy] refuses and records a request to anywhere else, and never makes it', async () => {
    proxy = await startWatchProxy()
    // 192.0.2.1 is TEST-NET-1: reserved for documentation and never routed.
    const res = await requestVia(watchProxyEnv(proxy.url), 'http://192.0.2.1:9/phone-home')
    expect(res.statusCode).toBe(403)
    const named = await requestVia(watchProxyEnv(proxy.url), 'http://telemetry.example.invalid/v1/events', { method: 'POST', body: '{}' })
    expect(named.statusCode).toBe(403)
    expect(proxy.attempts()).toEqual(['GET http://192.0.2.1:9', 'POST http://telemetry.example.invalid'])
    expect(proxy.carried()).toBe(0)
  })

  it('[U:watch-proxy] refuses and records a tunnel to anywhere else, which is what an https request asks for', async () => {
    proxy = await startWatchProxy()
    const port = Number(new URL(proxy.url).port)
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ method: 'CONNECT', path: 'api.example.invalid:443', createConnection: () => net.connect({ host: '127.0.0.1', port }) })
      req.on('connect', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 0) })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
    expect(proxy.attempts()).toEqual(['CONNECT api.example.invalid:443'])
  })

  it('[U:watch-proxy] with no proxy named, a request goes straight to where it was going, and the watcher sees nothing', async () => {
    proxy = await startWatchProxy()
    const base = await listen()
    expect(await text(await requestVia({}, `${base}/direct`))).toBe('GET /direct  ')
    expect(proxy.carried()).toBe(0)
  })
})
