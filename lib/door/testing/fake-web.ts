// A fake web, for tests: one HTTP server on loopback that plays every site, a
// fake DNS that answers what a test tells it to, and a dial that reaches the
// server only for an address the fake DNS handed out as a public one. Nothing
// here can reach the real internet: a dial to any other address fails, and the
// door is never given the real DNS.
//
// It records every lookup, every dial and every request the server saw, with
// its headers, so a test can show what the door did and did not send.
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Dial, Resolve, WebFetchOptions } from '../web-fetch.ts'

export interface SeenRequest { host: string; path: string; method: string; headers: http.IncomingHttpHeaders }
export type Page = (req: http.IncomingMessage, res: http.ServerResponse) => void

export interface FakeWeb {
  /** What the door is handed: this DNS, this dial, plain http (there is no TLS in the fake). */
  options: WebFetchOptions
  /** Play a page at a host and path. */
  page(host: string, path: string, page: Page): void
  /** Make a name resolve to these addresses. Each answer can differ: pass a function. */
  name(host: string, addresses: string[] | (() => string[])): void
  /** Every request the server saw. */
  seen: SeenRequest[]
  /** Every address the door connected to. */
  dials: string[]
  lookups: string[]
  /** A fake of the search provider, on the same server: where it is, what to answer, and every search it was sent. */
  search: { endpoint: string; results(list: { title: string; url: string; description: string }[]): void; seen: { query: string; headers: http.IncomingHttpHeaders }[] }
  close(): Promise<void>
}

/** Addresses the fake hands out for a public site. Public in form; only ever dialled to loopback, by this file. */
export const FAKE_PUBLIC = ['2600:1f00::44', '2600:1f00::45']

export async function startFakeWeb(): Promise<FakeWeb> {
  const pages = new Map<string, Page>()
  const names = new Map<string, string[] | (() => string[])>()
  const seen: SeenRequest[] = []
  const dials: string[] = []
  const lookups: string[] = []
  const sockets = new Set<net.Socket>()
  const searched: FakeWeb['search']['seen'] = []
  let answer: { title: string; url: string; description: string }[] = []
  const server = http.createServer((req, res) => {
    const asked = new URL(req.url ?? '/', 'http://fake')
    if (asked.pathname === '/fake-search/res/v1/web/search') {
      searched.push({ query: asked.searchParams.get('q') ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ web: { results: answer } }))
      return
    }
    const host = String(req.headers.host ?? '')
    const path = (req.url ?? '/').split('?')[0]
    seen.push({ host, path, method: req.method ?? '', headers: req.headers })
    const page = pages.get(`${host}${path}`)
    if (!page) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not here'); return }
    page(req, res)
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  const resolve: Resolve = async (host) => {
    lookups.push(host)
    const answer = names.get(host)
    if (!answer) throw new Error('ENOTFOUND')
    return typeof answer === 'function' ? answer() : answer
  }
  const dial: Dial = ({ ip }) => {
    dials.push(ip)
    // Only an address the fake hands out for a public site reaches the server. Anything else goes nowhere.
    if (!FAKE_PUBLIC.includes(ip)) {
      const dead = new net.Socket()
      setImmediate(() => dead.destroy(new Error('the fake web has nothing at that address')))
      return dead
    }
    return net.connect({ host: '127.0.0.1', port })
  }

  return {
    options: { resolve, dial, schemes: ['http:'] },
    page: (host, path, page) => { pages.set(`${host}${path}`, page) },
    name: (host, addresses) => { names.set(host, addresses) },
    seen, dials, lookups,
    search: { endpoint: `http://127.0.0.1:${port}/fake-search/res/v1/web/search`, results: (list) => { answer = list }, seen: searched },
    close: () => new Promise<void>((done) => {
      for (const s of sockets) s.destroy()
      server.close(() => done())
    }),
  }
}

/** A page of HTML holding `text`. */
export const html = (text: string): Page => (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><title>t</title><script>var hidden = "SCRIPT-TEXT"</script><style>p{}</style></head><body><h1>Page</h1><p>${text}</p></body></html>`)
}
/** A redirect to `to`. */
export const redirect = (to: string, extra: Record<string, string> = {}): Page => (_req, res) => {
  res.writeHead(302, { location: to, ...extra })
  res.end()
}
