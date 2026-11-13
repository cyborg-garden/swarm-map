// @vitest-environment node
//
// The model route: the harness talks to the sidecar with a placeholder, the
// sidecar swaps in the real key, counts tokens and refuses over budget.
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../../../conformance/rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import { REDACTED, startModelRoute, type ModelRoute } from '../model-route.ts'
import { OPENAI_CHAT, type ModelShape } from '../model-shapes.ts'
import { createReceiptLog } from '../receipts.ts'
import { createFileLedger, createMemoryLedger, type SpendLedger } from '../spend-ledger.ts'

armTripwire()

const NONCE = 'deadbeef'
const UPSTREAM = `UPSTREAM-${NONCE}`
const PLACEHOLDER = `PLACEHOLDER-${NONCE}`
const policy = (patch: Record<string, unknown> = {}) => withHash(applyPatch(loadFixturePolicy('policy-team.json'), patch))
// 100 in + 20 out per scripted reply; at these prices one reply costs exactly 1 USD.
const PRICES = { scripted: { inPerMTok: 5000, outPerMTok: 25000 } }

let model: ScriptedModel | undefined
let route: ModelRoute | undefined
afterEach(async () => {
  await route?.close()
  await model?.close()
  route = model = undefined
  expect(tripwireAttempts()).toEqual([])
})

async function start(
  p = policy(), script: ScriptEntry[] = [{ match: 'CANARY-m', text: 'via the route' }],
  o: { shape?: ModelShape; streamChunk?: number; ledger?: SpendLedger; now?: () => Date; upstreamTimeoutMs?: number } = {},
) {
  model = await startScriptedModel({ nonce: NONCE, script, streamChunk: o.streamChunk })
  const receipts = createReceiptLog()
  route = await startModelRoute({
    upstream: model.baseUrl, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: o.shape ?? OPENAI_CHAT,
    policy: () => p, receipts, prices: PRICES, ledger: o.ledger ?? createMemoryLedger(), now: o.now,
    upstreamTimeoutMs: o.upstreamTimeoutMs,
  })
  return { receipts }
}
const capped = (monthlyUsd: number) => policy({ budget: { monthlyUsd, onExceed: 'refuse' } })

/** What a client would rebuild from a stream: every text piece, joined. */
function streamedText(sse: string): string {
  return sse.split('\n\n').map((e) => e.replace(/^data: /, '')).filter((d) => d && d !== '[DONE]')
    .map((d) => (JSON.parse(d) as { choices: { delta?: { content?: string } }[] }).choices[0]?.delta?.content ?? '').join('')
}

const ask = (body: unknown, bearer = PLACEHOLDER) =>
  fetch(`${route!.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
const user = (content: string, extra: object = {}) => ({ model: 'scripted', messages: [{ role: 'user', content }], ...extra })

describe('model route', () => {
  it('[U:key-swap] the cell presents a placeholder and the model sees the real key', async () => {
    await start()
    const res = await ask(user('CANARY-m'))
    expect(res.status).toBe(200)
    expect((await res.json()).choices[0].message.content).toBe(`via the route FAKE-MODEL-${NONCE}`)
    expect(model!.requests.map((r) => r.authorization)).toEqual([`Bearer ${UPSTREAM}`])
    expect(route!.presented).toEqual([PLACEHOLDER])
  })

  it('[U:key-swap] the real key never comes back to the cell', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: `my key is ${UPSTREAM}` }])
    const res = await ask(user('CANARY-m'))
    const raw = await res.text()
    expect(raw).not.toContain(UPSTREAM)
    expect([...res.headers.values()].join(' ')).not.toContain(UPSTREAM)
  })

  // The scripted model streams text in pieces shorter than the key, so the key
  // is never whole in any one event. Looking for it in the raw stream proves
  // nothing; what matters is the text the client rebuilds from the pieces.
  it('[U:key-swap] a key split across stream events is still redacted from the rebuilt text', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: `my key is ${UPSTREAM} ok` }], { streamChunk: 5 })
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamed).not.toContain(UPSTREAM)
    expect(streamedText(streamed)).toBe(`my key is [redacted:held-secret] ok FAKE-MODEL-${NONCE}`)
  })

  it('[U:key-swap] a split key is still redacted when events are written as data: with no space', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: `the key is ${UPSTREAM} ok`, noStamp: true, tightData: true }], { streamChunk: 5 })
    const raw = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(raw).not.toContain(UPSTREAM)
    const text = raw.split('\n\n').map((e) => e.replace(/^data: ?/, '')).filter((d) => d && d !== '[DONE]')
      .map((d) => (JSON.parse(d) as { choices: { delta?: { content?: string } }[] }).choices[0]?.delta?.content ?? '').join('')
    expect(text).toBe(`the key is ${REDACTED} ok`)
    expect(route!.meter().inTokens).toBe(100) // and its usage event was still read
  })

  it('[U:key-swap] a key that arrives whole in one stream event is redacted', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: `my key is ${UPSTREAM} ok` }], { streamChunk: 4000 })
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamed).not.toContain(UPSTREAM)
    expect(streamedText(streamed)).toBe(`my key is [redacted:held-secret] ok FAKE-MODEL-${NONCE}`)
  })

  it('[U:key-swap] streamed text that only starts like the key arrives whole, at every piece size', async () => {
    const lookalike = `it starts ${UPSTREAM.slice(0, 9)} and stops; ${UPSTREAM.slice(0, 16)}`
    for (const streamChunk of [1, 3, 7, 12, 4000]) {
      await start(policy(), [{ match: 'CANARY-m', text: lookalike }], { streamChunk })
      const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
      expect(streamedText(streamed), `piece size ${streamChunk}`).toBe(`${lookalike} FAKE-MODEL-${NONCE}`)
      expect(streamed.trimEnd().endsWith('data: [DONE]')).toBe(true)
      await route!.close()
      await model!.close()
    }
  })

  it('[U:key-swap] a key at the very end of a stream that never says it finished is still redacted', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: `tail ${UPSTREAM}`, noStamp: true, noFinish: true }], { streamChunk: 6 })
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamedText(streamed)).toBe('tail [redacted:held-secret]')
  })

  it('[U:key-swap] text held back at the end of a stream is sent, whether or not the stream says it finished', async () => {
    const tail = `ends ${UPSTREAM.slice(0, 13)}`
    for (const noFinish of [false, true]) {
      await start(policy(), [{ match: 'CANARY-m', text: tail, noStamp: true, noFinish }], { streamChunk: 6 })
      const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
      expect(streamedText(streamed), `noFinish ${noFinish}`).toBe(tail)
      // In order: no text after the event that says "finished", and nothing after [DONE].
      const events = streamed.split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''))
      expect(events.at(-1)).toBe('[DONE]')
      const chunks = events.slice(0, -1).map((d) => JSON.parse(d) as { choices: { delta?: { content?: string }; finish_reason?: string | null }[] })
      const finished = chunks.findIndex((c) => c.choices[0]?.finish_reason)
      const lastText = chunks.findLastIndex((c) => (c.choices[0]?.delta?.content ?? '') !== '')
      if (!noFinish) expect(lastText).toBeLessThanOrEqual(finished)
      await route!.close()
      await model!.close()
    }
  })

  it('[U:model-shape] the route speaks one wire format and says which', async () => {
    await start()
    expect(route!.shape).toBe('openai-chat')
    // An Anthropic-shaped call: its own path, the placeholder in x-api-key. Not forwarded, not metered.
    const res = await fetch(`${route!.baseUrl}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': PLACEHOLDER },
      body: JSON.stringify({ model: 'scripted', messages: [{ role: 'user', content: 'CANARY-m' }] }),
    })
    expect(res.status).toBe(401)
    expect(model!.requests).toEqual([])
    expect(route!.meter().requests).toBe(0)
  })

  it('[U:model-shape] the wire format is a part that can be swapped, not something the route assumes', async () => {
    // A made-up format: another path, the placeholder in another header, usage under other names.
    const toy: ModelShape = {
      ...OPENAI_CHAT,
      id: 'openai-chat',
      path: '/v1/toy',
      presented: (headers) => (typeof headers['x-toy-key'] === 'string' ? headers['x-toy-key'] : undefined),
      usage: (json) => {
        const u = (json as { usage?: { prompt_tokens?: number } }).usage
        return u ? { inTokens: 7, outTokens: 0 } : undefined
      },
    }
    await start(policy(), undefined, { shape: toy })
    const call = (path: string, headers: Record<string, string>) => fetch(`${route!.baseUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(user('CANARY-m')),
    })
    expect((await call('/toy', { 'x-toy-key': PLACEHOLDER })).status).toBe(200)
    expect((await call('/toy', { authorization: `Bearer ${PLACEHOLDER}` })).status).toBe(401)
    expect((await call('/chat/completions', { 'x-toy-key': PLACEHOLDER })).status).toBe(404)
    expect(model!.requests.map((r) => r.authorization)).toEqual([`Bearer ${UPSTREAM}`])
    expect(route!.meter()).toMatchObject({ requests: 1, inTokens: 7, outTokens: 0 })
  })

  it('[U:key-swap] a caller without the placeholder is refused and nothing is forwarded', async () => {
    await start()
    expect((await ask(user('CANARY-m'), 'something-else')).status).toBe(401)
    expect((await ask(user('CANARY-m'), UPSTREAM)).status).toBe(401)
    expect(model!.requests).toEqual([])
    // What was presented is counted, never stored: it might have been a real key.
    expect(route!.presented).toEqual([])
    expect(route!.refused).toBe(2)
  })

  it('[U:key-swap] only the chat endpoint is forwarded', async () => {
    await start()
    const res = await fetch(`${route!.baseUrl}/../admin`, { headers: { authorization: `Bearer ${PLACEHOLDER}` } })
    expect(res.status).toBe(404)
    expect(model!.requests).toEqual([])
  })

  it('[U:budget-meter] usage is counted, for plain and streamed replies', async () => {
    await start()
    await (await ask(user('CANARY-m'))).text()
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.meter()).toEqual({ requests: 2, inTokens: 200, outTokens: 40, usd: 2 })
  })

  it('[U:budget-meter] the request after the budget is spent is refused and never reaches the model', async () => {
    const { receipts } = await start(policy({ budget: { monthlyUsd: 2, onExceed: 'refuse' } }))
    expect((await ask(user('CANARY-m one'))).status).toBe(200)
    expect((await ask(user('CANARY-m two'))).status).toBe(200)
    const third = await ask(user('CANARY-third'))
    expect(third.status).toBe(402)
    expect((await third.json()).error.message).toBe('The monthly budget is spent.')
    expect(model!.heard('CANARY-third')).toBe(false)
    expect(model!.requests).toHaveLength(2)
    expect(receipts.all().map((r) => `${r.event.kind}:${r.verdict}/${r.rule}`)).toEqual([
      'model:allow/budget.cap', 'model:allow/budget.cap', 'model:deny/budget.cap',
    ])
  })

  it('[U:budget-meter] a cap set to warn only lets the request through', async () => {
    await start(policy({ budget: { monthlyUsd: 1, onExceed: 'warn' } }))
    expect((await ask(user('CANARY-m one'))).status).toBe(200)
    expect((await ask(user('CANARY-m two'))).status).toBe(200)
  })

  it('[U:budget-meter] under a record that is not valid the call is refused, and the receipt names that rule', async () => {
    const { receipts } = await start(policy({ posture: 'Public' }))
    expect((await ask(user('CANARY-m'))).status).toBe(402)
    expect(model!.requests).toEqual([])
    expect(receipts.all().map((r) => `${r.verdict}/${r.rule}`)).toEqual(['deny/ctl.valid'])
  })

  it('[U:budget-meter] a model with no price is refused rather than counted as free', async () => {
    await start()
    const res = await ask({ model: 'unpriced', messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(400)
    expect(model!.requests).toEqual([])
  })
})

// A provider that says nothing about usage must not be free. Many
// OpenAI-compatible servers ignore `stream_options.include_usage`, and a
// stream that is cut short never reaches its usage event.
describe('model route: a call the provider did not meter', () => {
  const bytes = (text: string) => Buffer.byteLength(text)

  it('[U:budget-unmetered] a plain reply with no usage is charged at one token per byte, and a receipt says so', async () => {
    const { receipts } = await start(policy(), [{ match: 'CANARY-m', text: 'no usage here', noUsage: true }])
    const res = await ask(user('CANARY-m'))
    const reply = await res.text()
    expect(res.status).toBe(200)
    expect(JSON.parse(reply).usage).toBeUndefined()
    const m = route!.meter()
    expect(m.requests).toBe(1)
    expect(m.inTokens).toBe(bytes(model!.requests[0].body))
    expect(m.outTokens).toBe(bytes(reply))
    expect(m.usd).toBeCloseTo((m.inTokens * 5000 + m.outTokens * 25000) / 1_000_000, 9)
    expect(route!.unmetered).toBe(1)
    expect(receipts.all().map((r) => `${r.verdict}/${r.rule}/${r.note ?? ''}`)).toEqual(['allow/budget.cap/', 'allow/budget.cap/unmetered'])
    // A receipt holds sizes, never text.
    expect(JSON.stringify(receipts.all())).not.toContain('no usage here')
  })

  it('[U:budget-unmetered] a stream that never reports usage is charged for what it sent', async () => {
    const { receipts } = await start(policy(), [{ match: 'CANARY-m', text: 'streamed with no usage', noUsage: true }])
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamedText(streamed)).toBe(`streamed with no usage FAKE-MODEL-${NONCE}`)
    const m = route!.meter()
    expect(m.inTokens).toBe(bytes(model!.requests[0].body))
    expect(m.outTokens).toBeGreaterThanOrEqual(bytes(`streamed with no usage FAKE-MODEL-${NONCE}`))
    expect(m.usd).toBeGreaterThan(0)
    expect(route!.unmetered).toBe(1)
    expect(receipts.all().at(-1)).toMatchObject({ rule: 'budget.cap', note: 'unmetered' })
  })

  it('[U:budget-unmetered] a stream cut off before its usage event is still charged', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: 'this reply is cut off before the end', cutStream: true }])
    await (await ask(user('CANARY-m', { stream: true }))).text().catch(() => '')
    const m = route!.meter()
    expect(m.inTokens).toBe(bytes(model!.requests[0].body))
    expect(m.outTokens).toBeGreaterThan(0)
    expect(route!.unmetered).toBe(1)
  })

  it('[U:budget-unmetered] the cap still trips when the provider never reports usage', async () => {
    const { receipts } = await start(capped(1), [{ match: 'CANARY', text: 'x'.repeat(200), noUsage: true }])
    expect((await ask(user('CANARY one'))).status).toBe(200)
    const second = await ask(user('CANARY-second'))
    expect(second.status).toBe(402)
    expect(model!.heard('CANARY-second')).toBe(false)
    expect(receipts.all().at(-1)).toMatchObject({ verdict: 'deny', rule: 'budget.cap' })
  })

  // A usage figure is only believed when it could be true. Every call sends
  // something, so no real call uses zero input tokens: a provider that says so
  // has not metered the call, and one that sends nonsense has not either.
  const NOT_A_COUNT: [string, unknown][] = [
    ['all zeros', { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }],
    ['an empty object', {}],
    ['zero in, some out', { prompt_tokens: 0, completion_tokens: 20 }],
    ['words where numbers go', { prompt_tokens: 'lots', completion_tokens: 'more' }],
    ['a negative count', { prompt_tokens: -100, completion_tokens: -20 }],
    ['a negative output count that would pay money back', { prompt_tokens: 100, completion_tokens: -20 }],
    ['a count that is not a whole number of tokens', { prompt_tokens: 0.001, completion_tokens: 0.001 }],
    ['a missing output count', { prompt_tokens: 100 }],
  ]
  it.each(NOT_A_COUNT)('[U:budget-unmetered] usage that cannot be true (%s) is not believed: the call is charged by size', async (_what, usage) => {
    for (const stream of [false, true]) {
      const { receipts } = await start(policy(), [{ match: 'CANARY-m', text: 'claims to be free', usage }])
      const res = await ask(user('CANARY-m', stream ? { stream: true } : {}))
      const reply = await res.text()
      expect(res.status, `stream=${stream}`).toBe(200)
      const m = route!.meter()
      expect(m.inTokens, `stream=${stream}`).toBe(bytes(model!.requests[0].body))
      expect(m.outTokens, `stream=${stream}`).toBe(bytes(reply))
      expect(m.usd, `stream=${stream}`).toBeCloseTo((m.inTokens * 5000 + m.outTokens * 25000) / 1_000_000, 9)
      expect(route!.unmetered, `stream=${stream}`).toBe(1)
      expect(receipts.all().at(-1)).toMatchObject({ rule: 'budget.cap', note: 'unmetered' })
      await route!.close()
      await model!.close()
    }
  })

  it('[U:budget-unmetered] the cap still trips when the provider says every call used nothing', async () => {
    const ledger = createMemoryLedger()
    await start(capped(1), [{ match: 'CANARY', text: 'x'.repeat(200), usage: { prompt_tokens: 0, completion_tokens: 0 } }], { ledger })
    expect((await ask(user('CANARY one'))).status).toBe(200)
    expect(ledger.spent(new Date())).toBeGreaterThan(1)
    const second = await ask(user('CANARY-second'))
    expect(second.status).toBe(402)
    expect(model!.heard('CANARY-second')).toBe(false)
  })

  it('[U:budget-unmetered] a stream whose last usage event is nonsense keeps the last figure that could be true', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: 'running totals', usageEveryEvent: true, usage: {} }], { streamChunk: 4 })
    await (await ask(user('CANARY-m', { stream: true }))).text()
    // Eleven events carried a running total (the opening one, nine of text, the finish), so the
    // last believable figure is 100 in and 11 out. The empty object after them changes nothing.
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 100, outTokens: 11, usd: (100 * 5000 + 11 * 25000) / 1_000_000 })
    expect(route!.unmetered).toBe(0)
  })

  it('[U:budget-unmetered] a usage figure given before the text does not cover the text that follows it', async () => {
    const long = 'y'.repeat(4000)
    await start(policy(), [{ match: 'CANARY-m', text: long, usageFirstOnly: true }])
    await (await ask(user('CANARY-m', { stream: true }))).text()
    const m = route!.meter()
    expect(m.outTokens).toBeGreaterThanOrEqual(4000)
    expect(route!.unmetered).toBe(1)
  })

  it('[U:budget-unmetered] a reply that is not JSON is charged the same way', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: 'ignored', rawBody: '<html>gateway says hi</html>' }])
    const res = await ask(user('CANARY-m'))
    expect(await res.text()).toBe('<html>gateway says hi</html>')
    expect(route!.meter().outTokens).toBe(bytes('<html>gateway says hi</html>'))
    expect(route!.unmetered).toBe(1)
  })

  it('[U:budget-unmetered] a call the provider refused is passed back and costs nothing', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: 'ignored', status: 429 }])
    const res = await ask(user('CANARY-m'))
    expect(res.status).toBe(429)
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 0, outTokens: 0, usd: 0 })
    expect(route!.unmetered).toBe(0)
  })

  it('[U:budget-unmetered] a provider that never answers is given up on, charged for what was sent, and does not block the next call', async () => {
    await start(capped(1000), [{ match: 'CANARY-hang', text: 'never', hang: true }, { match: 'CANARY-m', text: 'after' }], { upstreamTimeoutMs: 150 })
    expect((await ask(user('CANARY-hang'))).status).toBe(502)
    expect(route!.meter().inTokens).toBe(bytes(model!.requests[0].body))
    expect(route!.unmetered).toBe(1)
    expect((await ask(user('CANARY-m'))).status).toBe(200)
  })

  it('[U:budget-unmetered] usage a stream reports more than once is counted once, at its last figure', async () => {
    await start(policy(), [{ match: 'CANARY-m', text: 'running totals', usageEveryEvent: true }], { streamChunk: 4 })
    await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(route!.meter()).toEqual({ requests: 1, inTokens: 100, outTokens: 20, usd: 1 })
    expect(route!.unmetered).toBe(0)
  })
})

describe('model route: the cap under parallel calls', () => {
  const five = () => Promise.all([1, 2, 3, 4, 5].map((n) => ask(user(`CANARY-p${n}`)).then((r) => r.status)))

  it('[U:budget-parallel] calls sent at once cannot all slip under the cap: only what the budget covers reaches the model', async () => {
    await start(capped(2), [{ match: 'CANARY-p', text: 'slow', delayMs: 60 }])
    const statuses = await five()
    expect(statuses.filter((s) => s === 200)).toHaveLength(2)
    expect(statuses.filter((s) => s === 402)).toHaveLength(3)
    expect(model!.requests).toHaveLength(2)
    expect(model!.maxInFlight).toBe(1)
    expect(route!.meter().usd).toBe(2)
  })

  it('[U:budget-parallel] positive control: with no cap to hold, calls run side by side', async () => {
    await start(policy(), [{ match: 'CANARY-p', text: 'slow', delayMs: 200 }])
    expect(await five()).toEqual([200, 200, 200, 200, 200])
    expect(model!.maxInFlight).toBeGreaterThan(1)
  })

  it('[U:budget-parallel] a cap set to warn only holds nothing back', async () => {
    await start(policy({ budget: { monthlyUsd: 1, onExceed: 'warn' } }), [{ match: 'CANARY-p', text: 'slow', delayMs: 200 }])
    expect(await five()).toEqual([200, 200, 200, 200, 200])
    expect(model!.maxInFlight).toBeGreaterThan(1)
  })
})

// A cap is only as good as the record of what was spent. If the record cannot
// be written, the next process would start from an old figure, so the route
// stops forwarding instead of carrying on unrecorded.
describe('model route: a ledger that cannot be written', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) { chmodSync(dir, 0o755); rmSync(dir, { recursive: true, force: true }) } dir = undefined })

  it('[U:budget-ledger] a ledger file that cannot be written refuses the call before it reaches the model', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-ledger-'))
    const ledger = createFileLedger(path.join(dir, 'spend.json'))
    chmodSync(dir, 0o555)
    const { receipts } = await start(capped(2), undefined, { ledger })
    const res = await ask(user('CANARY-m'))
    expect(res.status).toBe(503)
    expect(model!.requests).toEqual([])
    expect(receipts.all().map((r) => `${r.verdict}/${r.rule}/${r.note ?? ''}`)).toEqual(['deny/budget.cap/ledger'])
    expect(route!.meter().requests).toBe(0)
  })

  it('[U:budget-ledger] with no cap set the spend is still recorded, so the same refusal applies', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-ledger-'))
    const ledger = createFileLedger(path.join(dir, 'spend.json'))
    chmodSync(dir, 0o555)
    await start(policy(), undefined, { ledger })
    expect((await ask(user('CANARY-m'))).status).toBe(503)
    expect(model!.requests).toEqual([])
  })

  it('[U:budget-ledger] a charge that could not be recorded stops every later call, and a receipt says why', async () => {
    const inner = createMemoryLedger()
    // Takes the check before the call, then fails on the real charge.
    const flaky: SpendLedger = { spent: (at) => inner.spent(at), add: (at, usd) => { if (usd > 0) throw new Error('disk full'); inner.add(at, usd) } }
    const { receipts } = await start(capped(100), undefined, { ledger: flaky })
    expect((await ask(user('CANARY-m one'))).status).toBe(200) // already answered when the charge failed
    const second = await ask(user('CANARY-second'))
    expect(second.status).toBe(503)
    expect(model!.heard('CANARY-second')).toBe(false)
    expect(receipts.all().map((r) => `${r.verdict}/${r.note ?? ''}`)).toEqual(['allow/', 'deny/ledger', 'deny/ledger'])
  })

  it('[U:budget-ledger] positive control: a ledger that can be written lets the call through', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-ledger-'))
    await start(capped(2), undefined, { ledger: createFileLedger(path.join(dir, 'spend.json')) })
    expect((await ask(user('CANARY-m'))).status).toBe(200)
  })
})

describe('model route: spend outlives the process and follows the calendar', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })
  const ledgerFile = () => path.join(dir = mkdtempSync(path.join(os.tmpdir(), 'swarmlab-ledger-')), 'spend.json')

  it('[U:budget-ledger] a restart does not hand the budget back', async () => {
    const file = ledgerFile()
    await start(capped(2), undefined, { ledger: createFileLedger(file) })
    expect((await ask(user('CANARY-m one'))).status).toBe(200)
    expect((await ask(user('CANARY-m two'))).status).toBe(200)
    await route!.close()
    await model!.close()

    await start(capped(2), undefined, { ledger: createFileLedger(file) })
    expect(route!.meter().usd).toBe(0) // a new process: its own count starts again
    expect((await ask(user('CANARY-after-restart'))).status).toBe(402)
    expect(model!.heard('CANARY-after-restart')).toBe(false)
  })

  it('[U:budget-ledger] negative control: a ledger kept in memory does forget', async () => {
    await start(capped(2))
    await ask(user('CANARY-m one')); await ask(user('CANARY-m two'))
    expect((await ask(user('CANARY-m three'))).status).toBe(402)
    await route!.close()
    await model!.close()
    await start(capped(2))
    expect((await ask(user('CANARY-m again'))).status).toBe(200)
  })

  it('[U:budget-ledger] the cap is per calendar month: a new month starts from nothing, and the old month is kept', async () => {
    const file = ledgerFile()
    let now = new Date('2026-11-30T23:59:00Z')
    await start(capped(2), undefined, { ledger: createFileLedger(file), now: () => now })
    await ask(user('CANARY-m one')); await ask(user('CANARY-m two'))
    expect((await ask(user('CANARY-m three'))).status).toBe(402)
    now = new Date('2026-12-01T00:00:30Z')
    expect((await ask(user('CANARY-m december'))).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8')).months).toEqual({ '2026-11': 2, '2026-12': 1 })
  })
})
