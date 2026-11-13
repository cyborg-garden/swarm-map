// The model route: the sidecar's stand-in for the model provider. Spec 4.6.
//
// The harness is started with its provider base URL pointed here and a
// placeholder for a key. This process holds the real key, swaps it in,
// counts tokens, and refuses once the monthly budget is spent. The real key
// never enters the cell, so there is nothing in the cell to steal.
//
// The route knows no wire format of its own. Where the placeholder is
// presented, which path is a model call, where usage is reported and how a
// stream is cut up all come from a ModelShape (model-shapes.ts). Only the
// OpenAI chat-completions shape exists today, so the key swap and the budget
// cap hold for harnesses that speak that format and for no others.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { decide } from '../core/decide.ts'
import type { PolicyRecord } from '../core/policy/types.ts'
import type { ModelShape } from './model-shapes.ts'
import type { ReceiptLog } from './receipts.ts'

export interface Price { inPerMTok: number; outPerMTok: number }
export interface Meter { requests: number; inTokens: number; outTokens: number; usd: number }

export interface ModelRouteOptions {
  /** Provider base URL, ending in /v1. */
  upstream: string
  /** The real key. Held here only. */
  upstreamKey: string
  /** What the cell presents instead of a key. */
  placeholder: string
  /** The wire format the harness speaks. There is no default: a route must say which. */
  shape: ModelShape
  policy: () => PolicyRecord
  receipts: ReceiptLog
  /** USD per million tokens, by model name. A model with no price is refused. */
  prices: Record<string, Price>
  /** Spend already on the books this month, before this process started. */
  spentUsdThisMonth?: number
  host?: string
  port?: number
}

export interface ModelRoute {
  baseUrl: string
  /** The id of the wire format this route speaks. */
  shape: ModelShape['id']
  meter(): Meter
  /** Placeholders accepted, one per forwarded request. Refused bearers are counted, never stored. */
  presented: string[]
  refused: number
  close(): Promise<void>
}

export const REDACTED = '[redacted:held-secret]'

/** How many characters at the end of `text` could be the start of `secret`. */
function heldBack(text: string, secret: string): number {
  for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
    if (secret.startsWith(text.slice(text.length - n))) return n
  }
  return 0
}

export function startModelRoute(opts: ModelRouteOptions): Promise<ModelRoute> {
  const shape = opts.shape
  const meter: Meter = { requests: 0, inTokens: 0, outTokens: 0, usd: 0 }
  const presented: string[] = []
  const state = { refused: 0 }
  const redact = (text: string): string => text.split(opts.upstreamKey).join(REDACTED)

  const count = (model: string, usage: { inTokens: number; outTokens: number } | undefined): void => {
    if (!usage) return
    const price = opts.prices[model]
    meter.inTokens += usage.inTokens
    meter.outTokens += usage.outTokens
    meter.usd += (usage.inTokens * price.inPerMTok + usage.outTokens * price.outPerMTok) / 1_000_000
  }

  const fail = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    if (shape.presented(req.headers) !== opts.placeholder) {
      state.refused++
      return fail(res, 401, 'model route: not the placeholder for this cell')
    }
    const url = new URL(req.url ?? '/', 'http://local')
    if (req.method !== 'POST' || url.pathname !== shape.path) {
      return fail(res, 404, `model route: only ${shape.id} calls (POST ${shape.path}) are forwarded`)
    }

    let body: { model?: string; stream?: boolean } & Record<string, unknown>
    try { body = JSON.parse(raw) } catch { return fail(res, 400, 'model route: body is not JSON') }
    if (body === null || typeof body !== 'object') return fail(res, 400, 'model route: body is not a JSON object')
    const model = typeof body.model === 'string' ? body.model : ''
    if (!Object.hasOwn(opts.prices, model)) return fail(res, 400, 'model route: no price for that model, so it cannot be metered')

    const policy = opts.policy()
    const d = decide(policy, { kind: 'model', provider: shape.id, model }, { spentUsdThisMonth: (opts.spentUsdThisMonth ?? 0) + meter.usd })
    opts.receipts.write({
      ts: new Date().toISOString(), agentId: policy.agentId, policyHash: policy.hash,
      event: { kind: 'model', bytes: Buffer.byteLength(raw) }, verdict: d.verdict, rule: d.rule, why: d.why,
    })
    if (d.verdict !== 'allow') return fail(res, 402, d.why)

    presented.push(opts.placeholder)
    meter.requests++
    // Ask for usage on streams, so a streamed reply is metered too.
    const forward = body.stream ? shape.forStream(body) : body
    const upstream = await fetch(`${opts.upstream}${shape.upstreamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...shape.upstreamAuth(opts.upstreamKey) },
      body: JSON.stringify(forward),
    })

    if (!body.stream || !upstream.body) {
      const text = await upstream.text()
      try { count(model, shape.usage(JSON.parse(text))) } catch { /* not JSON: nothing to count */ }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(redact(text))
      return
    }

    // A stream. The key could arrive cut in two, one half at the end of one
    // event's text and the rest at the start of the next, so redacting each
    // event on its own is not enough. For each run of text the shape points
    // out, the end of a piece that could be the start of the key is held back
    // and joined to the next piece before it is checked and sent on.
    res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const held = new Map<string, string>()
    const write = (event: string): void => { res.write(redact(event) + '\n\n') }
    const drain = (): void => {
      for (const [key, text] of held) if (text !== '') write(`data: ${JSON.stringify(shape.textEvent(key, text))}`)
      held.clear()
    }
    const flush = (event: string): void => {
      const lines = event.split('\n')
      const at = lines.findIndex((line) => line.startsWith('data: '))
      const data = at === -1 ? undefined : lines[at].slice('data: '.length)
      if (data === undefined) return write(event) // a comment or a bare event name
      if (data === '[DONE]') { drain(); return write(event) }
      let json: unknown
      try { json = JSON.parse(data) } catch { return write(event) } // not JSON: checked as it stands
      count(model, shape.usage(json))
      const pieces = shape.streamText(json)
      if (pieces.length === 0) return write(event)
      for (const piece of pieces) {
        const clean = redact((held.get(piece.key) ?? '') + piece.text)
        const keep = piece.last ? 0 : heldBack(clean, opts.upstreamKey)
        piece.set(clean.slice(0, clean.length - keep))
        held.set(piece.key, clean.slice(clean.length - keep))
      }
      lines[at] = `data: ${JSON.stringify(json)}`
      write(lines.join('\n'))
    }
    const decoder = new TextDecoder()
    let pending = ''
    const reader = upstream.body.getReader()
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      pending += decoder.decode(part.value, { stream: true })
      const events = pending.split('\n\n')
      pending = events.pop() ?? ''
      for (const event of events) flush(event)
    }
    if (pending.trim()) flush(pending)
    drain()
    res.end()
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void handle(req, res, Buffer.concat(chunks).toString('utf8')).catch(() => {
        if (!res.headersSent) fail(res, 502, 'model route: the upstream call failed')
        else res.end()
      })
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://${opts.host ?? '127.0.0.1'}:${port}/v1`,
        shape: shape.id,
        meter: () => ({ ...meter }),
        presented,
        get refused() { return state.refused },
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
      })
    })
  })
}
