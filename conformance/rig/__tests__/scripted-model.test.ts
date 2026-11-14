// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel } from '../scripted-model.ts'

armTripwire()

const NONCE = 'deadbeef'
let model: ScriptedModel | undefined
afterEach(async () => {
  await model?.close()
  model = undefined
  expect(tripwireAttempts()).toEqual([])
})

const ask = (m: ScriptedModel, body: unknown, bearer = `UPSTREAM-${NONCE}`) =>
  fetch(`${m.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
const user = (content: string) => ({ model: 'scripted', messages: [{ role: 'user', content }] })

describe('scripted model', () => {
  it('refuses any caller that does not hold the upstream key of this run', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [] })
    expect((await ask(model, user('hi'), 'PLACEHOLDER-deadbeef')).status).toBe(401)
    expect((await ask(model, user('hi'), 'UPSTREAM-0badf00d')).status).toBe(401)
    expect(model.requests).toEqual([])
    expect(model.refused).toBe(2)
  })

  it('plays the reply scripted for a canary, stamps it, and reports usage', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [{ match: 'CANARY-a', text: 'scripted answer' }] })
    const res = await ask(model, user('please CANARY-a'))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.choices[0].message).toEqual({ role: 'assistant', content: `scripted answer FAKE-MODEL-${NONCE}` })
    expect(json.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
    expect(model.requests).toHaveLength(1)
    expect(model.heard('CANARY-a')).toBe(true)
    expect(model.heard('CANARY-never-sent')).toBe(false)
  })

  it('streams as server-sent events when asked', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [{ match: 'CANARY-s', text: 'streamed' }] })
    const res = await ask(model, { ...user('CANARY-s'), stream: true, stream_options: { include_usage: true } })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = (await res.text()).split('\n\n').filter(Boolean).map((e) => e.replace(/^data: /, ''))
    expect(events.at(-1)).toBe('[DONE]')
    const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe(`streamed FAKE-MODEL-${NONCE}`)
    expect(chunks.some((c) => c.usage?.total_tokens === 120)).toBe(true)
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop')
  })

  it('like the real API, a stream carries usage only when asked for it', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [] })
    const text = await (await ask(model, { ...user('x'), stream: true })).text()
    expect(text).not.toContain('"usage"')
  })

  it('asks for a tool first, then answers once the tool result comes back', async () => {
    model = await startScriptedModel({
      nonce: NONCE,
      script: [{ match: 'CANARY-t', tool: { name: 'bash', args: { command: 'touch /tmp/x' } }, text: 'done' }],
    })
    const first = await (await ask(model, user('CANARY-t'))).json()
    const call = first.choices[0].message.tool_calls[0]
    expect(first.choices[0].finish_reason).toBe('tool_calls')
    expect(call.function).toEqual({ name: 'bash', arguments: JSON.stringify({ command: 'touch /tmp/x' }) })

    const second = await (await ask(model, {
      model: 'scripted',
      messages: [
        { role: 'user', content: 'CANARY-t' },
        { role: 'assistant', content: null, tool_calls: [call] },
        { role: 'tool', tool_call_id: call.id, content: 'blocked' },
      ],
    })).json()
    expect(second.choices[0].message.content).toBe(`done FAKE-MODEL-${NONCE}`)
  })

  it('answers an unscripted prompt plainly, still stamped', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [] })
    const json = await (await ask(model, user('anything'))).json()
    expect(json.choices[0].message.content).toBe(`ok FAKE-MODEL-${NONCE}`)
  })

  it('keeps the bearer it saw on each request, for the key-swap check', async () => {
    model = await startScriptedModel({ nonce: NONCE, script: [] })
    await ask(model, user('x'))
    expect(model.requests[0].authorization).toBe(`Bearer UPSTREAM-${NONCE}`)
  })
})
