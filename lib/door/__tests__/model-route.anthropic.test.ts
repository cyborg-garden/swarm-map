// @vitest-environment node
//
// The model route, speaking Anthropic Messages: the format the Claude Agent
// SDK uses. The same three promises as for the OpenAI format (the key is
// swapped, every forwarded call is metered, the cap refuses), shown again
// here because each of them depends on the wire format.
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
    // Positive control: a tool the harness runs itself is an ordinary call.
    const own = [{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }, { type: 'custom', name: 'Read', input_schema: { type: 'object' } }]
    expect((await ask(user('CANARY-m', { tools: own }))).status).toBe(200)
    expect(model!.requests).toHaveLength(1)
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
