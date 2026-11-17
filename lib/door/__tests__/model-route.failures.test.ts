// @vitest-environment node
//
// The model route: every call it refuses, and every call the provider fails, leaves a
// receipt that says why and is reported to whoever listens (the door, which tells the
// room). A call it forwards is still metered exactly as before.
//
// The first block replays the reply shape OpenRouter sends for a model that answers
// with a tool call: keep-alive comments while the model works, reasoning deltas, the
// tool call in pieces, a finish event, and a usage event that repeats the finish and
// carries one empty choice. All values in it are made up.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../../../conformance/rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import { startModelRoute, type ModelFailure, type ModelRoute } from '../model-route.ts'
import { ANTHROPIC_MESSAGES, OPENAI_CHAT } from '../model-shapes.ts'
import { createReceiptLog, type ReceiptLog } from '../receipts.ts'
import { createMemoryLedger, type SpendLedger } from '../spend-ledger.ts'

armTripwire()

const NONCE = 'feedf00d'
const UPSTREAM = `UPSTREAM-${NONCE}`
const PLACEHOLDER = `PLACEHOLDER-${NONCE}`
const MODEL = 'vendor/some-model'
const policy = (patch: Record<string, unknown> = {}) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
const PRICES = { [MODEL]: { inPerMTok: 1, outPerMTok: 4 }, scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

let route: ModelRoute | undefined
let closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await route?.close()
  for (const close of closers) await close()
  route = undefined
  closers = []
  expect(tripwireAttempts()).toEqual([])
})

async function routeTo(upstream: string, o: { p?: ReturnType<typeof policy>; ledger?: SpendLedger; timeoutMs?: number; anthropic?: boolean } = {}) {
  const receipts = createReceiptLog()
  const failures: ModelFailure[] = []
  route = await startModelRoute({
    upstream, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: o.anthropic ? ANTHROPIC_MESSAGES : OPENAI_CHAT,
    policy: () => o.p ?? policy(), receipts, prices: PRICES, ledger: o.ledger ?? createMemoryLedger(),
    upstreamTimeoutMs: o.timeoutMs, onFailure: (f) => { failures.push(f) },
  })
  return { receipts, failures }
}

async function scripted(script: ScriptEntry[], shape?: 'anthropic-messages'): Promise<ScriptedModel> {
  const model = await startScriptedModel({ nonce: NONCE, script, shape })
  closers.push(() => model.close())
  return model
}

/** A provider that answers every call with `events`, as a stream, after `delayMs`. */
async function replay(events: string[], o: { delayMs?: number; status?: number } = {}): Promise<{ baseUrl: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${UPSTREAM}` && req.headers['x-api-key'] !== UPSTREAM) { res.writeHead(401).end(); return }
      bodies.push(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(o.status ?? 200, { 'content-type': 'text/event-stream' })
      // While the model works, the provider sends only comments.
      res.write(': OPENROUTER PROCESSING\n\n')
      setTimeout(() => {
        for (const e of events) res.write(e)
        res.end()
      }, o.delayMs ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }))
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, bodies }
}

const chunk = (extra: object, choice: object): string =>
  `data: ${JSON.stringify({ id: 'gen-0000-test', provider: 'SomeProvider', model: MODEL, object: 'chat.completion.chunk', created: 1, ...extra, choices: [{ index: 0, logprobs: null, ...choice }] })}\n\n`

/** A reply that thinks, then asks for one tool call, as OpenRouter streams it. */
const TOOL_CALL_STREAM = [
  chunk({}, { delta: { role: 'assistant', content: '', reasoning: 'I should run', reasoning_details: [{ type: 'reasoning.text', text: 'I should run', format: 'unknown', index: 0 }] }, finish_reason: null, native_finish_reason: null }),
  chunk({}, { delta: { role: 'assistant', content: '', reasoning: ' the command.', reasoning_details: [{ type: 'reasoning.text', text: ' the command.', format: 'unknown', index: 0 }] }, finish_reason: null, native_finish_reason: null }),
  chunk({}, { delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'bash:0', type: 'function', function: { name: 'bash', arguments: '' } }] }, finish_reason: null, native_finish_reason: null }),
  chunk({}, { delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, type: 'function', function: { arguments: '{"command":' } }] }, finish_reason: null, native_finish_reason: null }),
  chunk({}, { delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, type: 'function', function: { arguments: '"uname -a"}' } }] }, finish_reason: null, native_finish_reason: null }),
  chunk({}, { delta: { role: 'assistant', content: '' }, finish_reason: 'tool_calls', native_finish_reason: 'tool_calls' }),
  chunk({ usage: { prompt_tokens: 1711, completion_tokens: 136, total_tokens: 1847, cost: 0.0048, completion_tokens_details: { reasoning_tokens: 93 }, prompt_tokens_details: { cached_tokens: 0 } } },
    { delta: { content: '', role: 'assistant' }, finish_reason: 'tool_calls', native_finish_reason: 'tool_calls' }),
  'data: [DONE]\n\n',
]

const TOOLS = [{ type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }]
/** The request a harness sends with tools on: streamed, with its tool definitions. */
const toolTurn = (model = MODEL) => ({
  model, stream: true, stream_options: { include_usage: true }, tools: TOOLS,
  messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'please run uname -a' }],
})
const ask = (body: unknown, o: { bearer?: string; path?: string; raw?: string } = {}) =>
  fetch(`${route!.baseUrl}${o.path ?? '/chat/completions'}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${o.bearer ?? PLACEHOLDER}` },
    body: o.raw ?? JSON.stringify(body),
  })
const trail = (receipts: ReceiptLog) => receipts.all().map((r) => `${r.verdict}/${r.rule}${r.note ? `/${r.note}` : ''}`)

describe('model route: a tool call streamed the way OpenRouter streams it', () => {
  it('[U:budget-meter] is passed on whole and metered by its own usage figure, however long the model takes', async () => {
    const provider = await replay(TOOL_CALL_STREAM, { delayMs: 300 })
    const { receipts, failures } = await routeTo(provider.baseUrl)
    const res = await ask(toolTurn())
    const sse = await res.text()
    expect(res.status).toBe(200)
    // The tool call reaches the harness as it was sent: its id, its name and its arguments, in pieces.
    const args = sse.split('\n\n').filter((e) => e.startsWith('data: {'))
      .flatMap((e) => (JSON.parse(e.slice(6)) as { choices: { delta?: { tool_calls?: { function?: { arguments?: string } }[] } }[] }).choices)
      .flatMap((c) => c.delta?.tool_calls ?? []).map((t) => t.function?.arguments ?? '').join('')
    expect(args).toBe('{"command":"uname -a"}')
    expect(sse).toContain('"id":"bash:0"')
    expect(sse.trimEnd().endsWith('data: [DONE]')).toBe(true)
    // Metered by the figure it reported, not by size.
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 1711, outTokens: 136, usd: (1711 * 1 + 136 * 4) / 1_000_000 })
    expect(route!.unmetered).toBe(0)
    expect(trail(receipts)).toEqual(['allow/budget.cap'])
    expect(failures).toEqual([])
    // What the provider was sent is what the harness sent, with the key swapped in and usage asked for.
    const sent = JSON.parse(provider.bodies[0])
    expect(sent.tools).toEqual(TOOLS)
    expect(sent.stream_options).toEqual({ include_usage: true })
  })

  it('[U:model-failed] a stream that ends in an error event is charged, and leaves a receipt and a report saying the provider failed', async () => {
    const provider = await replay([
      TOOL_CALL_STREAM[0],
      chunk({ error: { code: 502, message: 'Provider disconnected unexpectedly' } }, { delta: { content: '' }, finish_reason: 'error', native_finish_reason: 'error' }),
      'data: [DONE]\n\n',
    ])
    const { receipts, failures } = await routeTo(provider.baseUrl)
    const res = await ask(toolTurn())
    await res.text()
    // No usage came, so the call is charged by size, as any unreported call is.
    expect(route!.unmetered).toBe(1)
    expect(route!.meter().usd).toBeGreaterThan(0)
    expect(trail(receipts)).toEqual(['allow/budget.cap', 'allow/budget.cap/unmetered', 'deny/model.provider/stream-error'])
    expect(failures).toEqual([{ rule: 'model.provider', why: expect.stringMatching(/provider/i) }])
    // The provider's own words are text from outside: they go to the harness, never into a receipt.
    expect(JSON.stringify(receipts.all())).not.toContain('disconnected')
  })
  it('[U:model-failed] a choice that finishes with error, and no error object beside it, is a failure too', async () => {
    const provider = await replay([TOOL_CALL_STREAM[0], chunk({}, { delta: { content: '' }, finish_reason: 'error', native_finish_reason: 'error' }), 'data: [DONE]\n\n'])
    const { receipts, failures } = await routeTo(provider.baseUrl)
    await (await ask(toolTurn())).text()
    expect(trail(receipts).at(-1)).toBe('deny/model.provider/stream-error')
    expect(failures.map((f) => f.rule)).toEqual(['model.provider'])
  })
})

describe('model route: every call it does not complete says why', () => {
  it('[U:model-failed] a provider that refuses the call: a receipt with the status, and a report', async () => {
    const model = await scripted([{ match: 'CANARY-m', text: 'x', status: 400 }])
    const { receipts, failures } = await routeTo(model.baseUrl)
    const res = await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY-m' }] })
    expect(res.status).toBe(400)
    expect(route!.meter().usd).toBe(0)
    expect(trail(receipts)).toEqual(['allow/budget.cap', 'deny/model.provider/status=400'])
    expect(failures).toEqual([{ rule: 'model.provider', why: expect.stringContaining('400') }])
  })

  it('[U:model-failed] a plain 200 reply that is an error body: a receipt and a report', async () => {
    const model = await scripted([{ match: 'CANARY-m', text: 'x', rawBody: JSON.stringify({ error: { code: 502, message: 'upstream went away' } }), rawType: 'application/json' }])
    const { receipts, failures } = await routeTo(model.baseUrl)
    await (await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY-m' }] })).text()
    expect(trail(receipts).at(-1)).toBe('deny/model.provider/error-body')
    expect(failures.map((f) => f.rule)).toEqual(['model.provider'])
  })

  it('[U:model-failed] a provider that never answers: a receipt and a report, as well as the charge', async () => {
    const model = await scripted([{ match: 'CANARY-hang', text: 'never', hang: true }])
    const { receipts, failures } = await routeTo(model.baseUrl, { timeoutMs: 150 })
    expect((await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY-hang' }] })).status).toBe(502)
    expect(route!.unmetered).toBe(1)
    expect(trail(receipts)).toEqual(['allow/budget.cap', 'allow/budget.cap/unmetered', 'deny/model.provider/no-answer'])
    expect(failures.map((f) => f.rule)).toEqual(['model.provider'])
  })

  it('[U:model-failed] the budget is spent: the refusal is reported as well as written down', async () => {
    const model = await scripted([{ match: 'CANARY', text: 'x' }])
    const { receipts, failures } = await routeTo(model.baseUrl, { p: policy({ budget: { monthlyUsd: 1, onExceed: 'refuse' } }) })
    expect((await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY one' }] })).status).toBe(200)
    expect((await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY two' }] })).status).toBe(402)
    expect(trail(receipts).at(-1)).toBe('deny/budget.cap')
    expect(failures).toEqual([{ rule: 'budget.cap', why: expect.stringMatching(/budget/i) }])
  })

  it('[U:model-failed] a refusal for any reason but the budget is reported in a fixed sentence: what the policy check said stays in the receipt', async () => {
    const model = await scripted([{ match: 'CANARY', text: 'x' }])
    const bad = withHash({ ...policy(), budget: { monthlyUsd: 'not-a-number', onExceed: 'refuse' } } as never)
    const { receipts, failures } = await routeTo(model.baseUrl, { p: bad })
    expect((await ask({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY' }] })).status).toBe(402)
    expect(trail(receipts).at(-1)).toBe('deny/ctl.valid')
    expect(failures).toEqual([{ rule: 'ctl.valid', why: 'The agent\'s rules refused the call, so it was not made.' }])
  })

  // Refused before anything is forwarded. Each was a 4xx with no receipt and no report.
  const REFUSED: [string, () => Promise<Response>, string][] = [
    ['a model with no price, so it cannot be metered', () => ask(toolTurn('vendor/unpriced')), 'no-price'],
    ['a body that is not JSON', () => ask(undefined, { raw: '{not json' }), 'not-json'],
    ['a call to a path that is not the model call', () => ask(toolTurn(), { path: '/embeddings' }), 'path'],
    ['a call that does not present this cell\'s placeholder', () => ask(toolTurn(), { bearer: 'someone-else' }), 'placeholder'],
  ]
  it.each(REFUSED)('[U:model-failed] %s: refused, with a receipt that says why, and a report', async (_what, call, note) => {
    const provider = await replay(TOOL_CALL_STREAM)
    const { receipts, failures } = await routeTo(provider.baseUrl)
    const res = await call()
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(provider.bodies).toEqual([])
    expect(trail(receipts)).toEqual([`deny/model.route/${note}`])
    expect(failures).toEqual([{ rule: 'model.route', why: expect.any(String) }])
    // Nothing the caller sent is written down.
    expect(JSON.stringify(receipts.all())).not.toContain('someone-else')
  })

  it('[U:model-failed] an Anthropic stream that ends in an error event is reported too', async () => {
    const provider = await replay([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 }, content: [] } })}\n\n`,
      `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
    ])
    const receipts = createReceiptLog()
    const failures: ModelFailure[] = []
    route = await startModelRoute({
      upstream: provider.baseUrl, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: ANTHROPIC_MESSAGES,
      policy: () => policy(), receipts, prices: PRICES, ledger: createMemoryLedger(), onFailure: (f) => { failures.push(f) },
    })
    const res = await fetch(`${route.baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
      body: JSON.stringify({ model: MODEL, stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    })
    await res.text()
    expect(trail(receipts).at(-1)).toBe('deny/model.provider/stream-error')
    expect(failures.map((f) => f.rule)).toEqual(['model.provider'])
  })

  it('positive control: a call that goes through reports nothing', async () => {
    const model = await scripted([{ match: 'CANARY-m', text: 'fine' }])
    const { receipts, failures } = await routeTo(model.baseUrl)
    expect((await ask({ model: 'scripted', stream: true, messages: [{ role: 'user', content: 'CANARY-m' }] })).status).toBe(200)
    expect(trail(receipts)).toEqual(['allow/budget.cap'])
    expect(failures).toEqual([])
  })
})
