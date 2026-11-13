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
//
// Three things keep the cap honest:
// - Every call the provider accepted is metered. When the reply says nothing
//   about usage (many OpenAI-compatible servers never do, and a stream that is
//   cut short cannot), the call is charged at one token per byte sent and
//   received, which is more than any tokeniser would count, and a receipt
//   marked `unmetered` is written. An unreported call is never free.
// - While a cap is set to refuse, an agent's calls go one at a time: the next
//   one is checked only after the one before has been charged. Calls sent at
//   once would otherwise all pass the same check. The cost is that a capped
//   agent's sessions wait for each other's model calls.
// - Spend lives in a ledger (spend-ledger.ts), by calendar month, not in this
//   process. A restart does not reset it and a new month starts from nothing.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { decide } from '../core/decide.ts'
import type { PolicyRecord } from '../core/policy/types.ts'
import type { ModelShape } from './model-shapes.ts'
import type { ReceiptLog } from './receipts.ts'
import type { SpendLedger } from './spend-ledger.ts'

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
  /** Where spend is kept, by month. There is no default: a route must say where. */
  ledger: SpendLedger
  /** The clock that says which month it is. Default: the system clock. */
  now?: () => Date
  /** How long the provider has to finish one call before it is given up on. Default 10 minutes. */
  upstreamTimeoutMs?: number
  host?: string
  port?: number
}

export interface ModelRoute {
  baseUrl: string
  /** The id of the wire format this route speaks. */
  shape: ModelShape['id']
  /** What this process has counted since it started. The cap reads the ledger, not this. */
  meter(): Meter
  /** Calls charged by size because the provider reported no usage. */
  unmetered: number
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
  const redact = (text: string): string => text.split(opts.upstreamKey).join(REDACTED)

  const now = opts.now ?? (() => new Date())
  const state = { refused: 0, unmetered: 0 }

  type Usage = { inTokens: number; outTokens: number }
  const charge = (model: string, usage: Usage): void => {
    const price = opts.prices[model]
    const usd = (usage.inTokens * price.inPerMTok + usage.outTokens * price.outPerMTok) / 1_000_000
    meter.inTokens += usage.inTokens
    meter.outTokens += usage.outTokens
    meter.usd += usd
    opts.ledger.add(now(), usd)
  }

  // One at a time, in arrival order, for calls made under a refusing cap.
  let line: Promise<void> = Promise.resolve()
  const takeTurn = (): Promise<() => void> => {
    let done!: () => void
    const mine = new Promise<void>((resolve) => { done = resolve })
    const ahead = line
    line = ahead.then(() => mine)
    return ahead.then(() => done)
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

    // Under a refusing cap this call waits here until every call ahead of it has been charged.
    const release = opts.policy().budget?.onExceed === 'refuse' ? await takeTurn() : () => {}
    try {
      const policy = opts.policy()
      const d = decide(policy, { kind: 'model', provider: shape.id, model }, { spentUsdThisMonth: opts.ledger.spent(now()) })
      const receipt = (verdict: 'allow' | 'deny', why: string, bytes: number, note?: string): void => opts.receipts.write({
        ts: now().toISOString(), agentId: policy.agentId, policyHash: policy.hash,
        event: { kind: 'model', bytes }, verdict, rule: d.rule, why, ...(note ? { note } : {}),
      })
      receipt(d.verdict === 'allow' ? 'allow' : 'deny', d.why, Buffer.byteLength(raw))
      if (d.verdict !== 'allow') return fail(res, 402, d.why)

      presented.push(opts.placeholder)
      meter.requests++
      // Ask for usage on streams, so a streamed reply is metered too.
      const forward = JSON.stringify(body.stream ? shape.forStream(body) : body)

      // What the provider said this call used, if it said. A stream may say more than once
      // (some send a running total with every event), so the last figure stands.
      let usage: Usage | undefined
      let received = 0
      // Until the provider itself refuses the call, assume it was run and will be billed.
      let billable = true
      try {
        const upstream = await fetch(`${opts.upstream}${shape.upstreamPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...shape.upstreamAuth(opts.upstreamKey) },
          body: forward,
          signal: AbortSignal.timeout(opts.upstreamTimeoutMs ?? 600_000),
        })
        billable = upstream.ok
        await relay(upstream, res, Boolean(body.stream), {
          usage: (u) => { usage = u ?? usage },
          received: (n) => { received += n },
        })
      } finally {
        if (usage) charge(model, usage)
        else if (billable) {
          state.unmetered++
          charge(model, { inTokens: Buffer.byteLength(forward), outTokens: received })
          receipt('allow', 'The provider reported no usage, so the call was charged at one token per byte.', received, 'unmetered')
        }
      }
    } finally {
      release()
    }
  }

  /** Pass the provider's reply back to the cell, redacted, reporting usage and size as they go by. */
  async function relay(
    upstream: Response, res: http.ServerResponse, stream: boolean,
    seen: { usage(u: { inTokens: number; outTokens: number } | undefined): void; received(bytes: number): void },
  ): Promise<void> {
    if (!stream || !upstream.body) {
      const text = await upstream.text()
      seen.received(Buffer.byteLength(text))
      try { seen.usage(shape.usage(JSON.parse(text))) } catch { /* not JSON: it reports no usage */ }
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
      seen.usage(shape.usage(json))
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
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        seen.received(part.value.byteLength)
        pending += decoder.decode(part.value, { stream: true })
        const events = pending.split('\n\n')
        pending = events.pop() ?? ''
        for (const event of events) flush(event)
      }
      if (pending.trim()) flush(pending)
    } finally {
      // Whatever was held back is sent even when the provider drops the stream half way.
      drain()
      res.end()
    }
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
        get unmetered() { return state.unmetered },
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
      })
    })
  })
}
