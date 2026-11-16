// @vitest-environment node
//
// The model route, speaking Anthropic Messages: the format the Claude Agent
// SDK uses. The same three promises as for the OpenAI format (the key is
// swapped, every forwarded call is metered, the cap refuses), shown again
// here because each of them depends on the wire format.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../../../conformance/rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import { REDACTED, startModelRoute, type ModelRoute } from '../model-route.ts'
import { ANTHROPIC_MESSAGES, MODEL_SHAPES, OPENAI_CHAT } from '../model-shapes.ts'
import { createReceiptLog, type ReceiptLog } from '../receipts.ts'
import { createMemoryLedger } from '../spend-ledger.ts'

armTripwire()

const NONCE = 'deadbeef'
const UPSTREAM = `UPSTREAM-${NONCE}`
const PLACEHOLDER = `PLACEHOLDER-${NONCE}`
const policy = (patch: Record<string, unknown> = {}) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICES = { scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

let model: ScriptedModel | undefined
let route: ModelRoute | undefined
let receipts: ReceiptLog
afterEach(async () => {
  await route?.close()
  await model?.close()
  route = model = undefined
  expect(tripwireAttempts()).toEqual([])
})

async function start(script: ScriptEntry[] = [{ match: 'CANARY-m', text: 'via the route' }], p = policy(), streamChunk?: number) {
  model = await startScriptedModel({ nonce: NONCE, script, shape: 'anthropic-messages', streamChunk })
  receipts = createReceiptLog()
  route = await startModelRoute({
    upstream: model.baseUrl, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: ANTHROPIC_MESSAGES,
    policy: () => p, receipts, prices: PRICES, ledger: createMemoryLedger(),
  })
}

const VERSION = { 'anthropic-version': '2023-06-01' }
const ask = (body: unknown, headers: Record<string, string> = { 'x-api-key': PLACEHOLDER, ...VERSION }, path = '/messages') =>
  fetch(`${route!.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const user = (content: string, extra: object = {}) => ({ model: 'scripted', max_tokens: 100, messages: [{ role: 'user', content }], ...extra })

interface Event { name: string; data: { type: string; index?: number; delta?: { type?: string; text?: string; partial_json?: string } } }
/** A stream as a client reads it: named events, in order. */
function events(sse: string): Event[] {
  return sse.split('\n\n').filter((e) => e.trim() !== '' && !e.startsWith(':')).map((e) => {
    const lines = e.split('\n')
    return {
      name: lines.find((l) => l.startsWith('event:'))?.slice('event:'.length).trim() ?? '',
      data: JSON.parse(lines.filter((l) => l.startsWith('data:')).map((l) => l.slice('data:'.length).replace(/^ /, '')).join('\n')),
    }
  })
}
/** What a client would rebuild from a stream: every text piece, joined. */
const streamedText = (sse: string): string =>
  events(sse).filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta!.text).join('')

describe('model route, Anthropic Messages: the key swap', () => {
  it('[U:key-swap] the cell presents a placeholder in x-api-key and the model sees the real key there', async () => {
    await start()
    const res = await ask(user('CANARY-m'))
    expect(res.status).toBe(200)
    expect((await res.json()).content[0].text).toBe(`via the route FAKE-MODEL-${NONCE}`)
    expect(model!.requests.map((r) => r.key)).toEqual([UPSTREAM])
    expect(model!.requests[0].body).not.toContain(PLACEHOLDER)
    expect(route!.presented).toEqual([PLACEHOLDER])
    expect(route!.shape).toBe('anthropic-messages')
  })

  it('[U:key-swap] a caller without the placeholder is refused and nothing is forwarded: no key, a wrong one, or the right one in the wrong header', async () => {
    await start()
    for (const headers of [VERSION, { 'x-api-key': 'something-else', ...VERSION }, { authorization: `Bearer ${PLACEHOLDER}`, ...VERSION }, { 'x-api-key': UPSTREAM, ...VERSION }]) {
      expect((await ask(user('CANARY-m'), headers)).status).toBe(401)
    }
    expect(route!.refused).toBe(4)
    expect(model!.requests).toEqual([])
    expect(route!.meter().requests).toBe(0)
  })

  it('[U:key-swap] the real key never comes back to the cell, plain or streamed', async () => {
    await start([{ match: 'CANARY-m', text: `my key is ${UPSTREAM} ok`, noStamp: true }], policy(), 5)
    const plain = await (await ask(user('CANARY-m'))).text()
    expect(plain).not.toContain(UPSTREAM)
    expect(JSON.parse(plain).content[0].text).toBe(`my key is ${REDACTED} ok`)
    // Streamed in pieces of five, so the key is never whole in one event. What matters is the text a client rebuilds.
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamed).not.toContain(UPSTREAM)
    expect(streamedText(streamed)).toBe(`my key is ${REDACTED} ok`)
  })

  it('[U:key-swap] text held back because it might be the start of the key is sent before its block is closed, as an event a client will read', async () => {
    // The reply ends on the first letters of the key. They are held back in case the rest follows, and nothing follows.
    await start([{ match: 'CANARY-m', text: `it starts ${UPSTREAM.slice(0, 6)}`, noStamp: true }], policy(), 4)
    const got = events(await (await ask(user('CANARY-m', { stream: true }))).text())
    expect(got.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta!.text).join('')).toBe(`it starts ${UPSTREAM.slice(0, 6)}`)
    // Every event still goes out under its own name, the one the route wrote included.
    for (const e of got) expect(e.name).toBe(e.data.type)
    const names = got.map((e) => e.name)
    const lastText = names.lastIndexOf('content_block_delta')
    expect(lastText).toBeLessThan(names.indexOf('content_block_stop'))
    expect(names.slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop'])
  })

  it('[U:key-swap] the same holds when the stream just stops: the held-back text is still sent', async () => {
    await start([{ match: 'CANARY-m', text: `it starts ${UPSTREAM.slice(0, 6)}`, noStamp: true, cutStream: true }], policy(), 4)
    const raw = await (await ask(user('CANARY-m', { stream: true }))).text().catch(() => '')
    expect(streamedText(raw)).toBe(`it starts ${UPSTREAM.slice(0, 6)}`)
  })

  it('[U:key-swap] a key in the arguments of a streamed tool call is redacted', async () => {
    await start([{ match: 'CANARY-m', tool: { name: 'Bash', args: { command: `echo ${UPSTREAM}` } }, text: 'done' }])
    const raw = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(raw).not.toContain(UPSTREAM)
    expect(events(raw).find((e) => e.data.delta?.type === 'input_json_delta')!.data.delta!.partial_json).toContain(REDACTED)
  })

  it('[U:key-swap] every run of text a block can stream is watched for a key cut in two: its text, its thinking, and the arguments of a tool call', () => {
    const delta = (type: string, field: string, value: string) => ({ type: 'content_block_delta', index: 2, delta: { type, [field]: value } })
    for (const [type, field] of [['text_delta', 'text'], ['thinking_delta', 'thinking'], ['input_json_delta', 'partial_json']]) {
      const event = delta(type, field, 'a piece')
      const pieces = ANTHROPIC_MESSAGES.streamText(event)
      expect(pieces.map((p) => [p.key, p.text, p.last]), type).toEqual([[`2/${type}`, 'a piece', false]])
      pieces[0].set('changed')
      expect(event.delta[field]).toBe('changed')
      // What is held back for that run when the stream just stops goes out as an event of the same kind.
      expect(ANTHROPIC_MESSAGES.textEvent(`2/${type}`, 'held')).toEqual(delta(type, field, 'held'))
    }
    // The end of a block closes all three runs, and hands back an event for any that still holds text.
    const stop = ANTHROPIC_MESSAGES.streamText({ type: 'content_block_stop', index: 2 })
    expect(stop.map((p) => [p.key, p.last])).toEqual([['2/text_delta', true], ['2/thinking_delta', true], ['2/input_json_delta', true]])
    expect(stop[1].set('held')).toEqual(delta('thinking_delta', 'thinking', 'held'))
    expect(stop[1].set('')).toBeUndefined()
    // A delta of a kind that carries no text of its own (a signature, say) is no run.
    expect(ANTHROPIC_MESSAGES.streamText({ type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'x' } })).toEqual([])
  })

  it('[U:model-shape] what the provider needs of the request is passed on, and nothing else: the version headers, and the one query parameter', async () => {
    await start()
    const res = await ask(user('CANARY-m'), { 'x-api-key': PLACEHOLDER, ...VERSION, 'anthropic-beta': 'some-beta', 'x-extra': 'nope' }, '/messages?beta=true&other=1')
    // The scripted model, like the real API, refuses a call with no version header. So a 200 shows it arrived.
    expect(res.status).toBe(200)
    expect(model!.requests[0].path).toBe('/v1/messages?beta=true')
    // And without one the provider's refusal comes back as it is, and costs nothing.
    expect((await ask(user('CANARY-m'), { 'x-api-key': PLACEHOLDER })).status).toBe(400)
    expect(route!.meter().usd).toBe(1)
  })

  it('[U:model-shape] only the model call is forwarded: no other path of the API, and no model list', async () => {
    await start()
    for (const path of ['/messages/batches', '/complete', '/files', '/models']) expect((await ask(user('CANARY-m'), undefined, path)).status).toBe(404)
    expect((await fetch(`${route!.baseUrl}/models`, { headers: { 'x-api-key': PLACEHOLDER } })).status).toBe(404)
    expect(model!.requests).toEqual([])
  })

  it('[U:model-shape] every wire format the route has is listed by its id', () => {
    expect(MODEL_SHAPES).toEqual({ 'openai-chat': OPENAI_CHAT, 'anthropic-messages': ANTHROPIC_MESSAGES })
    for (const [id, shape] of Object.entries(MODEL_SHAPES)) expect(shape.id).toBe(id)
  })
})

describe('model route, Anthropic Messages: metering', () => {
  it('[U:budget-meter] usage is counted, for plain and streamed replies, from the two events a stream reports it in', async () => {
    await start()
    await (await ask(user('CANARY-m'))).text()
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 100, outTokens: 20, usd: 1 })
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.meter()).toEqual({ requests: 2, inTokens: 200, outTokens: 40, usd: 2 })
    expect(route!.unmetered).toBe(0)
  })

  it('[U:budget-meter] a streamed tool call is metered the same way', async () => {
    await start([{ match: 'CANARY-m', tool: { name: 'Bash', args: { command: 'true' } }, text: 'done' }])
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 100, outTokens: 20, usd: 1 })
    expect(route!.unmetered).toBe(0)
  })

  it('[U:budget-meter] tokens read from and written to the provider\'s cache are counted, and never for less than they cost', async () => {
    // 10 plain, 50 read from the cache (billed for less, counted in full), 20 written to it (billed for up to twice, counted twice).
    await start([{ match: 'CANARY-m', text: 'cached', usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 20, output_tokens: 20 } }])
    await (await ask(user('CANARY-m'))).text()
    expect(route!.meter()).toMatchObject({ inTokens: 100, outTokens: 20 })
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.meter()).toMatchObject({ inTokens: 200, outTokens: 40 })
    expect(route!.unmetered).toBe(0)
  })

  it('[U:budget-meter] the request after the budget is spent is refused and never reaches the model', async () => {
    await start(undefined, policy({ budget: { monthlyUsd: 2, onExceed: 'refuse' } }))
    expect((await ask(user('CANARY-m', { stream: true }))).status).toBe(200)
    expect((await ask(user('CANARY-m'))).status).toBe(200)
    const refused = await ask(user('CANARY-m', { stream: true }))
    expect(refused.status).toBe(402)
    expect(model!.requests).toHaveLength(2)
    expect(receipts.all().at(-1)).toMatchObject({ rule: 'budget.cap', verdict: 'deny' })
  })

  it('[U:budget-meter] a model with no price is refused rather than counted as free', async () => {
    await start()
    expect((await ask({ ...user('CANARY-m'), model: 'some-other-model' })).status).toBe(400)
    expect(model!.requests).toEqual([])
  })

  it('[U:budget-unmetered] a stream cut off before the event that reports its output is charged by size', async () => {
    await start([{ match: 'CANARY-m', text: 'x'.repeat(400), cutStream: true }])
    await (await ask(user('CANARY-m', { stream: true }))).text().catch(() => '')
    expect(route!.unmetered).toBe(1)
    // More than the figure on its opening event (100 in, 1 out) would have charged.
    expect(route!.meter().outTokens).toBeGreaterThan(400)
    expect(receipts.all().some((r) => r.note === 'unmetered')).toBe(true)
  })

  it('[U:budget-unmetered] a reply that reports no usage, plain or streamed, is charged by size', async () => {
    await start([{ match: 'CANARY-m', text: 'quiet', noUsage: true }])
    await (await ask(user('CANARY-m'))).text()
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.unmetered).toBe(2)
    expect(route!.meter().usd).toBeGreaterThan(0)
  })

  it.each([
    ['a count that is not a number', { input_tokens: 'many', output_tokens: 20 }],
    ['zeros', { input_tokens: 0, output_tokens: 0 }],
    ['a missing output count', { input_tokens: 100 }],
    ['a cache count that is not a number', { input_tokens: 100, cache_read_input_tokens: 'lots', output_tokens: 20 }],
    ['a negative cache count', { input_tokens: 100, cache_creation_input_tokens: -90, output_tokens: 20 }],
  ])('[U:budget-unmetered] usage that cannot be true (%s) is not believed, plain or streamed', async (_what, usage) => {
    await start([{ match: 'CANARY-m', text: 'odd', usage }])
    await (await ask(user('CANARY-m'))).text()
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.unmetered).toBe(2)
  })

  it('[U:budget-unmetered] a call the provider refused is passed back and costs nothing', async () => {
    await start([{ match: 'CANARY-m', text: '', status: 529 }])
    const res = await ask(user('CANARY-m', { stream: true }))
    expect(res.status).toBe(529)
    expect((await res.json()).error.type).toBe('api_error')
    expect(route!.meter().usd).toBe(0)
  })

  it('[U:budget-unmetered] a call for a tool the provider runs and bills by the use is not forwarded', async () => {
    await start()
    const served = [{ type: 'web_search_20250305', name: 'web_search' }]
    const res = await ask(user('CANARY-m', { tools: served }))
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain('cannot be metered')
    expect((await ask(user('CANARY-m', { mcp_servers: [{ type: 'url', url: 'https://example.invalid', name: 'x' }] }))).status).toBe(400)
    expect(model!.requests).toEqual([])
    // Nor is a call that asks for the same model at another price: the route has one price for a model.
    for (const extra of [{ speed: 'fast' }, { inference_geo: 'us' }]) {
      const priced = await ask(user('CANARY-m', extra))
      expect(priced.status, JSON.stringify(extra)).toBe(400)
      expect((await priced.json()).error.message).toContain('billed at another price')
    }
    expect(model!.requests).toEqual([])
    // The plain values are the plain price, and go through.
    expect((await ask(user('CANARY-m', { speed: 'standard', inference_geo: 'global' }))).status).toBe(200)
    // Positive control: a tool the harness runs itself is an ordinary call.
    const own = [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }, { type: 'custom', name: 'Read', input_schema: { type: 'object' } }]
    expect((await ask(user('CANARY-m', { tools: own }))).status).toBe(200)
    expect(model!.requests).toHaveLength(2)
  })

  it('[U:model-shape] "how many tokens is this?" is answered by the route itself, as an estimate: nothing is forwarded, charged or answered without the placeholder', async () => {
    await start()
    const body = user('CANARY-m '.repeat(30))
    const res = await ask(body, undefined, '/messages/count_tokens')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3), estimated: true })
    expect((await ask(body, VERSION, '/messages/count_tokens')).status).toBe(401)
    expect(model!.requests).toEqual([])
    expect(route!.meter()).toEqual({ requests: 0, inTokens: 0, outTokens: 0, usd: 0 })
  })
})

// The provider is whoever the operator named, and the real key is for that host alone. A
// redirect is the provider saying "ask somewhere else". Followed, it would carry the key
// there: `x-api-key` is not a header an HTTP client drops when a redirect leaves the host.
describe('model route: what reaches the provider, and where', () => {
  const listen = (handler: http.RequestListener): Promise<{ url: string; close(): Promise<void> }> => new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
    }))
  })

  it('[U:model-shape] no header of the cell\'s reaches the provider but the ones the format names: not its other credentials, not what it says it is', async () => {
    let seen: http.IncomingHttpHeaders = {}
    const provider = await listen((req, res) => {
      seen = req.headers
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }))
    })
    receipts = createReceiptLog()
    route = await startModelRoute({
      upstream: `${provider.url}/v1`, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: ANTHROPIC_MESSAGES,
      policy: () => policy(), receipts, prices: PRICES, ledger: createMemoryLedger(),
    })
    try {
      const res = await ask(user('CANARY-m'), {
        'x-api-key': PLACEHOLDER, ...VERSION, 'anthropic-beta': 'one,two',
        // Put together here, so no string shaped like a credential is committed.
        authorization: ['Bearer', 'something-of-the-cells'].join(' '), cookie: ['session', 'of-the-cells'].join('='), 'x-forwarded-for': '203.0.113.9',
        'user-agent': 'a-harness/1.0', 'x-app': 'cli', 'anthropic-dangerous-direct-browser-access': 'true',
      })
      expect(res.status).toBe(200)
      // What the route's own HTTP client adds (a host, a length, what it accepts) is not the cell's.
      const own = ['host', 'connection', 'content-length', 'accept', 'accept-language', 'accept-encoding', 'sec-fetch-mode', 'user-agent']
      expect(Object.keys(seen).filter((name) => !own.includes(name)).sort()).toEqual(['anthropic-beta', 'anthropic-version', 'content-type', 'x-api-key'])
      expect(seen).toMatchObject({ 'x-api-key': UPSTREAM, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'one,two', 'content-type': 'application/json' })
      expect(seen['user-agent']).not.toBe('a-harness/1.0')
      expect(JSON.stringify(seen)).not.toContain('of-the-cells')
      expect(JSON.stringify(seen)).not.toContain(PLACEHOLDER)
    } finally {
      await provider.close()
    }
  })

  it.each([
    ['anthropic-messages', ANTHROPIC_MESSAGES, { 'x-api-key': PLACEHOLDER, ...VERSION }, '/messages'],
    ['openai-chat', OPENAI_CHAT, { authorization: `Bearer ${PLACEHOLDER}` }, '/chat/completions'],
  ] as const)('[U:key-swap] %s: the real key is not sent on to where a redirect points, whether that is another host or another path of the provider', async (_id, shape, headers, callPath) => {
    const elsewhere: { url: string; headers: http.IncomingHttpHeaders }[] = []
    const answer: http.RequestListener = (req, res) => {
      elsewhere.push({ url: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'from somewhere else' }], usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1 } }))
    }
    const other = await listen(answer)
    let location = ''
    let status = 307
    let asked = 0
    const provider = await listen((req, res) => {
      if (req.url?.startsWith('/v1/elsewhere')) return answer(req, res)
      asked++
      res.writeHead(status, { location })
      res.end()
    })
    receipts = createReceiptLog()
    route = await startModelRoute({
      upstream: `${provider.url}/v1`, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape,
      policy: () => policy(), receipts, prices: PRICES, ledger: createMemoryLedger(),
    })
    try {
      for (const to of [`${other.url}/steal`, '/v1/elsewhere']) {
        for (const code of [301, 302, 303, 307, 308]) {
          location = to
          status = code
          const res = await fetch(`${route.baseUrl}${callPath}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(user('CANARY-m')) })
          expect(res.status, `${code} to ${to}`).toBe(502)
          const text = await res.text()
          expect(text).toContain('redirect')
          expect(text).not.toContain('from somewhere else')
          expect(text).not.toContain(UPSTREAM)
        }
      }
      expect(asked).toBe(10)
      expect(elsewhere).toEqual([])
      // Nothing was run, so nothing is charged, and each refusal is written down.
      expect(route.meter()).toMatchObject({ inTokens: 0, outTokens: 0, usd: 0 })
      expect(route.unmetered).toBe(0)
      expect(receipts.all().filter((r) => r.verdict === 'deny' && r.note === 'redirect')).toHaveLength(10)
    } finally {
      await other.close()
      await provider.close()
    }
  })
})

// The cap holds calls in line one at a time. In this format the usage of one call comes in two events,
// and each call keeps its own half-figure: calls side by side must not mix theirs.
describe('model route, Anthropic Messages: the cap under parallel calls', () => {
  const five = () => Promise.all([1, 2, 3, 4, 5].map((n) => ask(user(`CANARY-p${n}`, { stream: true })).then(async (r) => ({ status: r.status, body: await r.text() }))))

  it('[U:budget-parallel] streamed calls sent at once cannot all slip under the cap: only what the budget covers reaches the model', async () => {
    await start([{ match: 'CANARY-p', text: 'slow', delayMs: 60 }], policy({ budget: { monthlyUsd: 2, onExceed: 'refuse' } }))
    const got = await five()
    expect(got.filter((r) => r.status === 200)).toHaveLength(2)
    expect(got.filter((r) => r.status === 402)).toHaveLength(3)
    expect(model!.requests).toHaveLength(2)
    expect(model!.maxInFlight).toBe(1)
    expect(route!.meter()).toMatchObject({ inTokens: 200, outTokens: 40, usd: 2 })
  })

  it('[U:budget-parallel] positive control: with no cap to hold, they run side by side, and each is metered from its own two events', async () => {
    await start([{ match: 'CANARY-p', text: 'slow', delayMs: 200 }])
    const got = await five()
    expect(got.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
    expect(model!.maxInFlight).toBeGreaterThan(1)
    expect(route!.meter()).toMatchObject({ inTokens: 500, outTokens: 100, usd: 5 })
  })
})
