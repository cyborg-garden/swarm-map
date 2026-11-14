// The model route: the sidecar's stand-in for the model provider. Spec 4.6.
//
// The harness is started with its provider base URL pointed here and a
// placeholder for a key. This process holds the real key, swaps it in,
// counts tokens, and refuses once the monthly budget is spent. The route never
// hands the real key to the harness. That the harness has no other way to it
// is the sealed cell's job. The lab's Docker cell shows it for Pi (check C8,
// docs/lab/pi-slice.md). Nothing shows it for any other harness or cell.
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
//   cut short cannot), or reports a figure that cannot be true (zeros, a
//   missing count, anything that is not a whole number), the call is charged
//   at one token per byte sent and received, which is more than any tokeniser
//   would count, and a receipt marked `unmetered` is written. An unreported
//   call is never free.
// - While a cap is set to refuse, an agent's calls go one at a time: the next
//   one is checked only after the one before has been charged. Calls sent at
//   once would otherwise all pass the same check. The cost is that a capped
//   agent's sessions wait for each other's model calls.
// - Spend lives in a ledger (spend-ledger.ts), by calendar month, not in this
//   process. A restart does not reset it and a new month starts from nothing.
//   A ledger that cannot be written stops the route: no call is forwarded
//   while the ledger refuses a write, or again in this process once it has
//   lost a charge. A restart forgets that, and the lost charge stays lost.
//
// What it cannot do: tell a figure that is false but could be true. A provider
// that reports one token for a long reply is believed.
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
  // A figure is believed only if it could be true: whole, and above zero both
  // ways, since every call sends something and a reply that is charged for
  // said something. (A reply with nothing in it is charged by size, which is small.) A provider that reports
  // zeros or nonsense has not metered the call, and the call is charged by size.
  const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
  const believed = (u: Usage | undefined): Usage | undefined =>
    u && count(u.inTokens) && count(u.outTokens) && u.inTokens > 0 && u.outTokens > 0 ? u : undefined
  // Once the ledger has failed to take a charge, what it holds is less than what was spent,
  // and the next process would start from that. So the route stops forwarding for good.
  let ledgerFailed = false
  /** Put a charge on the books. False if the ledger would not take it. */
  const charge = (model: string, usage: Usage): boolean => {
    const price = opts.prices[model]
    const usd = (usage.inTokens * price.inPerMTok + usage.outTokens * price.outPerMTok) / 1_000_000
    meter.inTokens += usage.inTokens
    meter.outTokens += usage.outTokens
    meter.usd += usd
    try { opts.ledger.add(now(), usd) } catch { ledgerFailed = true }
    return !ledgerFailed
  }
  /** Can the ledger be written right now? Asked before a call is forwarded, by writing nothing to it. */
  const ledgerWritable = (): boolean => {
    if (ledgerFailed) return false
    try { opts.ledger.add(now(), 0); return true } catch { return false }
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
    const rate = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0
    const price = Object.hasOwn(opts.prices, model) ? opts.prices[model] as Price | null : undefined
    if (!price || !rate(price.inPerMTok) || !rate(price.outPerMTok)) return fail(res, 400, 'model route: no price for that model, so it cannot be metered')

    // Under a refusing cap this call waits here until every call ahead of it has been charged.
    const release = opts.policy().budget?.onExceed === 'refuse' ? await takeTurn() : () => {}
    try {
      const policy = opts.policy()
      let rule = 'budget.cap'
      const receipt = (verdict: 'allow' | 'deny', why: string, bytes: number, note?: string): void => opts.receipts.write({
        ts: now().toISOString(), agentId: policy.agentId, policyHash: policy.hash,
        event: { kind: 'model', bytes }, verdict, rule, why, ...(note ? { note } : {}),
      })
      const NO_LEDGER = 'Spend cannot be recorded, so no model call is forwarded.'
      if (!ledgerWritable()) {
        receipt('deny', NO_LEDGER, Buffer.byteLength(raw), 'ledger')
        return fail(res, 503, NO_LEDGER)
      }
      const d = decide(policy, { kind: 'model', provider: shape.id, model }, { spentUsdThisMonth: opts.ledger.spent(now()) })
      rule = d.rule
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
          // One event, or the whole of a plain reply. A figure that can be believed stands. A
          // figure covers what came before it, so output that comes with no such figure, or
          // that the route could not read, means the earlier one no longer stands.
          event: (u, output) => {
            const real = believed(u)
            if (real) usage = real
            else if (output) usage = undefined
          },
          received: (n) => { received += n },
        })
      } finally {
        let recorded = true
        if (usage) recorded = charge(model, usage)
        else if (billable) {
          state.unmetered++
          recorded = charge(model, { inTokens: Buffer.byteLength(forward), outTokens: received })
          receipt('allow', 'The provider reported no usage, so the call was charged at one token per byte.', received, 'unmetered')
        }
        if (!recorded) receipt('deny', 'A charge could not be recorded. No further model call is forwarded.', received, 'ledger')
      }
    } finally {
      release()
    }
  }

  /** Redact the key from every string and property name inside a parsed JSON value, in place. True if anything changed. */
  function redactDeep(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false
    let changed = false
    const holder = value as Record<string, unknown>
    for (const [name, inner] of Object.entries(holder)) {
      if (typeof inner === 'string') {
        const clean = redact(inner)
        if (clean !== inner) { holder[name] = clean; changed = true }
      } else if (redactDeep(inner)) changed = true
      // A property name is a string too.
      if (!Array.isArray(value) && redact(name) !== name) {
        holder[redact(name)] = holder[name]
        delete holder[name]
        changed = true
      }
    }
    return changed
  }

  type Seen = { event(usage: { inTokens: number; outTokens: number } | undefined, output: boolean): void; received(bytes: number): void }

  /**
   * A reply that is not a stream of events, as text to send back. Passed on as it came unless
   * the key is in it. JSON may write the key with an escape in it, which a search of the raw
   * text misses, so the parsed strings are searched too.
   */
  function plainBody(text: string, seen: Seen): string {
    let json: unknown
    try { json = JSON.parse(text) } catch { return redact(text) } // not JSON: it reports no usage
    seen.event(shape.usage(json), false)
    if (typeof json === 'string') return redact(json) === json ? redact(text) : JSON.stringify(redact(json))
    return redactDeep(json) ? redact(JSON.stringify(json)) : redact(text)
  }

  /**
   * Reads a stream of events piece by piece and writes each one on, redacted.
   *
   * The key could arrive cut in two, one half at the end of one event's text and the rest at
   * the start of the next, so redacting each event on its own is not enough. For each run of
   * text the shape points out, the end of a piece that could be the start of the key is held
   * back and joined to the next piece before it is checked and sent on.
   *
   * Until the first event with data arrives, nothing is written: a body with no such event
   * is not a stream, whatever it was labelled, and `end()` hands it back to be read as a
   * plain body.
   */
  function eventReader(out: (text: string) => void, seen: Seen): { feed(text: string): void; end(): string | undefined } {
    const held = new Map<string, string>()
    let sawData = false
    let before = '' // everything read so far, kept only until the first data event
    const write = (event: string): void => { out(redact(event) + '\n\n') }
    const drain = (): void => {
      for (const [key, text] of held) if (text !== '') write(`data: ${JSON.stringify(shape.textEvent(key, text))}`)
      held.clear()
    }
    const isData = (line: string): boolean => line.startsWith('data:')
    const flush = (event: string): void => {
      const lines = event.split('\n')
      const dataLines = lines.filter(isData)
      if (dataLines.length === 0) return write(event) // a comment or a bare event name
      // An event's data is every `data:` line, joined: one JSON value may be spread over
      // several. `data:` may be followed by one space or none.
      const data = dataLines.map((line) => line.slice('data:'.length).replace(/^ /, '')).join('\n')
      if (data === '[DONE]') { drain(); return write(event) }
      let json: unknown
      try { json = JSON.parse(data) } catch {
        // Not JSON, so the route cannot tell what it is. It is sent with the key searched for
        // as it stands, and counted as output nobody metered.
        seen.event(undefined, true)
        return write(event)
      }
      seen.event(shape.usage(json), shape.hasOutput(json))
      for (const piece of shape.streamText(json)) {
        const clean = redact((held.get(piece.key) ?? '') + piece.text)
        const keep = piece.last ? 0 : heldBack(clean, opts.upstreamKey)
        piece.set(clean.slice(0, clean.length - keep))
        held.set(piece.key, clean.slice(clean.length - keep))
      }
      // Every other string in the event, searched after JSON's escapes are undone.
      redactDeep(json)
      write([...lines.filter((line) => !isData(line)), `data: ${JSON.stringify(json)}`].join('\n'))
    }
    let pending = ''
    let carry = ''
    const take = (event: string): void => {
      if (!sawData && event.split('\n').some(isData)) {
        sawData = true
        // What came before the first data event (comments, keep-alives) goes out first.
        const earlier = before.split('\n\n').filter((e) => e !== '')
        before = ''
        for (const e of earlier) flush(e)
      }
      if (sawData) flush(event)
      else before += event + '\n\n'
    }
    return {
      feed(text) {
        // SSE lines may end with LF, CRLF or a bare CR. All three are read as LF. A CR at the
        // very end of a piece is kept back: the LF that makes it one line ending may come next.
        pending = pending + carry + text
        carry = pending.endsWith('\r') ? '\r' : ''
        pending = pending.slice(0, pending.length - carry.length).replace(/\r\n?/g, '\n')
        const events = pending.split('\n\n')
        pending = events.pop() ?? ''
        for (const event of events) take(event)
      },
      end() {
        // What is left when the stream ends is its last event, with or without its line endings.
        if (pending.trim()) take(pending.replace(/\n+$/, ''))
        pending = ''
        if (!sawData) return before
        // Whatever was held back is sent even when the provider drops the stream half way.
        drain()
        return undefined
      },
    }
  }

  /** True if the text has a line that starts an event's data. */
  const looksLikeEvents = (text: string): boolean => /(^|\r\n|\r|\n)data:/.test(text)

  /**
   * Pass the provider's reply back to the cell, redacted, reporting usage and size as they go by.
   * How a reply is read is decided by what is in it. Its label only decides whether it is passed
   * on piece by piece (a stream that was asked for and says it is one) or read whole first.
   */
  async function relay(upstream: Response, res: http.ServerResponse, stream: boolean, seen: Seen): Promise<void> {
    const type = upstream.headers.get('content-type') ?? ''
    const live = stream && upstream.body !== null && /^text\/event-stream\b/i.test(type)
    if (!live) {
      const text = await upstream.text()
      seen.received(Buffer.byteLength(text))
      let body: string
      let isJson = true
      try { JSON.parse(text) } catch { isJson = false }
      if (!isJson && looksLikeEvents(text)) {
        // A stream under another label, or one nobody asked for: still read as a stream.
        let out = ''
        const reader = eventReader((piece) => { out += piece }, seen)
        reader.feed(text)
        const notEvents = reader.end() // writes the last event and anything held back into `out`
        body = out + (notEvents ?? '')
      } else {
        body = plainBody(text, seen)
      }
      res.writeHead(upstream.status, { 'content-type': redact(type || 'application/json') })
      res.end(body)
      return
    }

    res.writeHead(upstream.status, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const reader = eventReader((piece) => { res.write(piece) }, seen)
    const decoder = new TextDecoder()
    const source = upstream.body!.getReader()
    try {
      for (let part = await source.read(); !part.done; part = await source.read()) {
        seen.received(part.value.byteLength)
        reader.feed(decoder.decode(part.value, { stream: true }))
      }
    } finally {
      // Labelled a stream, but no event with data ever came: it is read as the plain body it is.
      const notEvents = reader.end()
      if (notEvents !== undefined && notEvents.trim() !== '') res.write(plainBody(notEvents.replace(/\n+$/, ''), seen))
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
