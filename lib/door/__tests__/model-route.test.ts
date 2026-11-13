// @vitest-environment node
//
// The model route: the harness talks to the sidecar with a placeholder, the
// sidecar swaps in the real key, counts tokens and refuses over budget.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../../../conformance/rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import { startModelRoute, type ModelRoute } from '../model-route.ts'
import { OPENAI_CHAT, type ModelShape } from '../model-shapes.ts'
import { createReceiptLog } from '../receipts.ts'

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
  o: { shape?: ModelShape; streamChunk?: number } = {},
) {
  model = await startScriptedModel({ nonce: NONCE, script, streamChunk: o.streamChunk })
  const receipts = createReceiptLog()
  route = await startModelRoute({
    upstream: model.baseUrl, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER, shape: o.shape ?? OPENAI_CHAT,
    policy: () => p, receipts, prices: PRICES,
  })
  return { receipts }
}

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

  it('[U:budget-meter] a model with no price is refused rather than counted as free', async () => {
    await start()
    const res = await ask({ model: 'unpriced', messages: [{ role: 'user', content: 'x' }] })
    expect(res.status).toBe(400)
    expect(model!.requests).toEqual([])
  })
})
