// The model route: the sidecar's stand-in for the model provider. Spec 4.6.
//
// The harness is started with its provider base URL pointed here and a
// placeholder for a key. This process holds the real key, swaps it in,
// counts tokens, and refuses once the monthly budget is spent. The real key
// never enters the cell, so there is nothing in the cell to steal.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { decide } from '../core/decide.ts'
import type { PolicyRecord } from '../core/policy/types.ts'
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
  meter(): Meter
  /** Placeholders accepted, one per forwarded request. Refused bearers are counted, never stored. */
  presented: string[]
  refused: number
  close(): Promise<void>
}

interface UsageShape { prompt_tokens?: number; completion_tokens?: number }

export function startModelRoute(opts: ModelRouteOptions): Promise<ModelRoute> {
  const meter: Meter = { requests: 0, inTokens: 0, outTokens: 0, usd: 0 }
  const presented: string[] = []
  const state = { refused: 0 }
  const redact = (text: string): string => text.split(opts.upstreamKey).join('[redacted:held-secret]')

  const count = (model: string, usage: UsageShape | undefined): void => {
    if (!usage) return
    const price = opts.prices[model]
    const inTokens = usage.prompt_tokens ?? 0
    const outTokens = usage.completion_tokens ?? 0
    meter.inTokens += inTokens
    meter.outTokens += outTokens
    meter.usd += (inTokens * price.inPerMTok + outTokens * price.outPerMTok) / 1_000_000
  }

  const fail = (res: http.ServerResponse, status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, raw: string): Promise<void> {
    if (req.headers.authorization !== `Bearer ${opts.placeholder}`) {
      state.refused++
      return fail(res, 401, 'model route: not the placeholder for this cell')
    }
    const url = new URL(req.url ?? '/', 'http://local')
    if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') return fail(res, 404, 'model route: only chat completions are forwarded')

    let body: { model?: string; stream?: boolean; stream_options?: object }
    try { body = JSON.parse(raw) } catch { return fail(res, 400, 'model route: body is not JSON') }
    const model = body.model ?? ''
    if (!opts.prices[model]) return fail(res, 400, `model route: no price for model '${model}', so it cannot be metered`)

    const policy = opts.policy()
    const d = decide(policy, { kind: 'model', provider: 'swarm', model }, { spentUsdThisMonth: (opts.spentUsdThisMonth ?? 0) + meter.usd })
    opts.receipts.write({
      ts: new Date().toISOString(), agentId: policy.agentId, policyHash: policy.hash,
      event: { kind: 'model', bytes: Buffer.byteLength(raw) }, verdict: d.verdict, rule: d.rule, why: d.why,
    })
    if (d.verdict !== 'allow') return fail(res, 402, d.why)

    presented.push(opts.placeholder)
    meter.requests++
    // Ask for usage on streams, so a streamed reply is metered too.
    const forward = body.stream ? { ...body, stream_options: { ...body.stream_options, include_usage: true } } : body
    const upstream = await fetch(`${opts.upstream}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.upstreamKey}` },
      body: JSON.stringify(forward),
    })

    if (!body.stream || !upstream.body) {
      const text = await upstream.text()
      try { count(model, (JSON.parse(text) as { usage?: UsageShape }).usage) } catch { /* not JSON: nothing to count */ }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      res.end(redact(text))
      return
    }

    res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const decoder = new TextDecoder()
    let pending = ''
    const flush = (event: string): void => {
      const data = event.replace(/^data: /, '')
      if (data !== '[DONE]') {
        try { count(model, (JSON.parse(data) as { usage?: UsageShape }).usage) } catch { /* partial or comment */ }
      }
      res.write(redact(event) + '\n\n')
    }
    const reader = upstream.body.getReader()
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      pending += decoder.decode(part.value, { stream: true })
      const events = pending.split('\n\n')
      pending = events.pop() ?? ''
      for (const event of events) flush(event)
    }
    if (pending.trim()) flush(pending)
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
        meter: () => ({ ...meter }),
        presented,
        get refused() { return state.refused },
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
      })
    })
  })
}
