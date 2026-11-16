// @vitest-environment node
//
// The scripted model, speaking Anthropic Messages. It must be as hard to
// mistake for the real thing, and as plain about what it was sent, as it is
// in the other format. And it must tell a long session's turns apart.
import { afterEach, describe, expect, it } from 'vitest'
import { armTripwire, tripwireAttempts } from '../../guards/tripwire.ts'
import { startScriptedModel, type ScriptedModel, type ScriptEntry } from '../scripted-model.ts'

armTripwire()

const NONCE = 'deadbeef'
let model: ScriptedModel | undefined
afterEach(async () => {
  await model?.close()
  model = undefined
  expect(tripwireAttempts()).toEqual([])
})
const start = async (script: ScriptEntry[] = []) => { model = await startScriptedModel({ nonce: NONCE, script, shape: 'anthropic-messages' }); return model }

const HEADERS = { 'content-type': 'application/json', 'x-api-key': `UPSTREAM-${NONCE}`, 'anthropic-version': '2023-06-01' }
const ask = (m: ScriptedModel, body: unknown, headers: Record<string, string> = HEADERS, path = '/messages') =>
  fetch(`${m.baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
const text = (t: string) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const call = (messages: unknown[], extra: object = {}) => ({ model: 'scripted', max_tokens: 100, messages, ...extra })
const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] }
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }, { type: 'text', text: 'a note the harness added' }] }

describe('scripted model, Anthropic Messages', () => {
  it('[U:scripted-anthropic] refuses any caller that does not hold the upstream key of this run, in the header this format uses', async () => {
    const m = await start()
    expect((await ask(m, call([text('hi')]), { ...HEADERS, 'x-api-key': `PLACEHOLDER-${NONCE}` })).status).toBe(401)
    expect((await ask(m, call([text('hi')]), { ...HEADERS, 'x-api-key': 'UPSTREAM-0badf00d' })).status).toBe(401)
    const { 'x-api-key': _none, ...bearer } = { ...HEADERS, authorization: `Bearer UPSTREAM-${NONCE}` }
    expect((await ask(m, call([text('hi')]), bearer)).status).toBe(401)
    expect(m.requests).toEqual([])
    expect(m.refused).toBe(3)
  })

  it('[U:scripted-anthropic] like the real API, refuses a call that names no version, and any path but the model call', async () => {
    const m = await start()
    const { 'anthropic-version': _none, ...unversioned } = HEADERS
    const res = await ask(m, call([text('hi')]), unversioned)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect((await ask(m, call([text('hi')]), HEADERS, '/messages/count_tokens')).status).toBe(404)
    expect((await ask(m, call([text('hi')]), HEADERS, '/chat/completions')).status).toBe(404)
    expect(m.requests).toEqual([])
  })

  it('[U:scripted-anthropic] plays the reply scripted for a canary, stamps it, reports usage, and keeps what it was sent', async () => {
    const m = await start([{ match: 'CANARY-a', text: 'scripted answer' }])
    const res = await ask(m, call([text('please CANARY-a')]), HEADERS, '/messages?beta=true')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: `scripted answer FAKE-MODEL-${NONCE}` }], usage: { input_tokens: 100, output_tokens: 20 },
    })
    expect(m.requests).toHaveLength(1)
    expect(m.requests[0]).toMatchObject({ key: `UPSTREAM-${NONCE}`, path: '/v1/messages?beta=true' })
    expect(m.heard('CANARY-a')).toBe(true)
  })

  it('[U:scripted-anthropic] a stream reports the input count when it opens and the output count after the text, as the real API does', async () => {
    const m = await start([{ match: 'CANARY-a', text: 'streamed' }])
    const raw = await (await ask(m, call([text('CANARY-a')], { stream: true }))).text()
    const events = raw.split('\n\n').filter(Boolean).map((e) => {
      const [name, data] = e.split('\n')
      return { name: name.replace('event: ', ''), data: JSON.parse(data.replace('data: ', '')) }
    })
    expect(events.map((e) => e.name)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'])
    for (const e of events) expect(e.data.type).toBe(e.name)
    expect(events[0].data.message.usage).toEqual({ input_tokens: 100, output_tokens: 1 })
    expect(events.at(-2)!.data).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } })
    expect(events.filter((e) => e.name === 'content_block_delta').map((e) => e.data.delta.text).join('')).toBe(`streamed FAKE-MODEL-${NONCE}`)
  })

  it('[U:scripted-anthropic] asks for the scripted tool first, and answers with the text once its result has come back', async () => {
    const m = await start([{ match: 'CANARY-t', tool: { name: 'Bash', args: { command: 'touch /tmp/x' } }, text: 'done' }])
    const first = await (await ask(m, call([text('run CANARY-t')]))).json()
    expect(first).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'touch /tmp/x' } }] })
    const second = await (await ask(m, call([text('run CANARY-t'), toolUse, toolResult]))).json()
    expect(second).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: `done FAKE-MODEL-${NONCE}` }] })
  })

  it('[U:scripted-anthropic] in a long session the entry that plays is the one for the last thing a person said, and an earlier turn\'s tool result does not answer for this one', async () => {
    const m = await start([
      { match: 'CANARY-one', tool: { name: 'Bash', args: { command: 'one' } }, text: 'first done' },
      { match: 'CANARY-two', tool: { name: 'Bash', args: { command: 'two' } }, text: 'second done' },
    ])
    const earlier = [text('run CANARY-one'), toolUse, toolResult, { role: 'assistant', content: [{ type: 'text', text: 'first done' }] }]
    // The thread holds the first canary and a tool result. The second turn's tool is still asked for.
    const asked = await (await ask(m, call([...earlier, text('run CANARY-two')]))).json()
    expect(asked).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', input: { command: 'two' } }] })
    const answered = await (await ask(m, call([...earlier, text('run CANARY-two'), toolUse, toolResult]))).json()
    expect(answered.content[0].text).toBe(`second done FAKE-MODEL-${NONCE}`)
    // A message nobody scripted gets the plain reply, whatever the thread before it holds.
    const plain = await (await ask(m, call([...earlier, text('and now something else')]))).json()
    expect(plain.content[0].text).toBe(`ok FAKE-MODEL-${NONCE}`)
  })

  it('[U:scripted-anthropic] a streamed tool call carries its arguments as JSON in pieces, and says the turn stopped for a tool', async () => {
    const m = await start([{ match: 'CANARY-t', tool: { name: 'Read', args: { file_path: '/tmp/x' } }, text: 'done' }])
    const raw = await (await ask(m, call([text('CANARY-t')], { stream: true }))).text()
    expect(raw).toContain('"type":"input_json_delta"')
    expect(raw).toContain('"stop_reason":"tool_use"')
    expect(raw).toContain(JSON.stringify(JSON.stringify({ file_path: '/tmp/x' })))
  })

  it('[U:scripted-anthropic] can be told to refuse, to say nothing about usage, or to drop a stream half way', async () => {
    const m = await start([
      { match: 'CANARY-refused', text: '', status: 402 },
      { match: 'CANARY-quiet', text: 'quiet', noUsage: true },
      { match: 'CANARY-cut', text: 'cut short', cutStream: true },
    ])
    const refused = await ask(m, call([text('CANARY-refused')]))
    expect(refused.status).toBe(402)
    expect(await refused.json()).toMatchObject({ type: 'error', error: { message: 'scripted model: refused with 402' } })
    expect(await (await ask(m, call([text('CANARY-quiet')]))).json()).not.toHaveProperty('usage')
    const quiet = await (await ask(m, call([text('CANARY-quiet')], { stream: true }))).text()
    expect(quiet).not.toContain('"usage"')
    const cut = await (await ask(m, call([text('CANARY-cut')], { stream: true }))).text().catch(() => 'dropped')
    expect(cut).not.toContain('message_stop')
  })
})
