// @vitest-environment node
//
// The model route: the harness talks to the sidecar with a placeholder, the
// sidecar swaps in the real key, counts tokens and refuses over budget.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../../conformance/guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel } from '../../../conformance/rig/scripted-model.ts'
import { applyPatch, loadFixturePolicy } from '../../../conformance/scenarios/load.ts'
import { withHash } from '../../core/policy/canonical.ts'
import { startModelRoute, type ModelRoute } from '../model-route.ts'
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

async function start(p = policy(), script = [{ match: 'CANARY-m', text: 'via the route' }]) {
  model = await startScriptedModel({ nonce: NONCE, script })
  const receipts = createReceiptLog()
  route = await startModelRoute({
    upstream: model.baseUrl, upstreamKey: UPSTREAM, placeholder: PLACEHOLDER,
    policy: () => p, receipts, prices: PRICES,
  })
  return { receipts }
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
    const streamed = await (await ask(user('CANARY-m', { stream: true }))).text()
    expect(streamed).not.toContain(UPSTREAM)
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
