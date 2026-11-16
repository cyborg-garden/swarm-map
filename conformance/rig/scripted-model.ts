// The scripted model: a tiny local server that plays replies from a script.
// It stands in for "the model" at the far edge of the rig. It speaks one of
// two wire formats, as it is told when it starts: OpenAI chat-completions
// (the default) or Anthropic Messages.
//
// It proves it is the fake three ways: it refuses any caller that does not
// hold this run's upstream key, it stamps every text reply with this run's
// nonce, and it keeps a log of exactly what it was sent (`heard`).
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface ScriptEntry {
  /** A canary string. The entry plays when it appears anywhere in the request body. */
  match: string
  /** Ask for this tool first; answer with `text` once a tool result comes back. */
  tool?: { name: string; args: unknown }
  text: string
  /** Leave the run's stamp off the reply, for a test that needs the text to end exactly where it says. */
  noStamp?: boolean
  /** Streamed only: never send the event that says the reply is finished. */
  noFinish?: boolean
  /** Called when the entry is about to play, before anything is sent back. */
  before?: () => void
  // The rest make it misbehave the way real providers do, for the model route's tests.
  /** Say nothing about usage, plain or streamed, even when asked to. */
  noUsage?: boolean
  /** Report exactly this where usage goes, plain or streamed, however little sense it makes. */
  usage?: unknown
  /** Streamed only: report usage once, on the opening event, before any text has gone out. */
  usageFirstOnly?: boolean
  /** Streamed only: end lines the other ways SSE allows, with CRLF or with a bare CR. */
  lineEnd?: '\r\n' | '\r'
  /** Streamed only: send each event in two pieces, cut inside its last line ending. */
  splitLineEnds?: boolean
  /** Streamed only: write events as `data:{...}` with no space after the colon, which SSE allows. */
  tightData?: boolean
  /** Streamed only: report running usage on every event, not once at the end. */
  usageEveryEvent?: boolean
  /** Streamed only: drop the connection after the text, before the finish, usage and [DONE] events. */
  cutStream?: boolean
  /** Answer with this status and an error body, as a provider that refused the call. */
  status?: number
  /** Answer 200 with exactly this body, which need not be JSON. */
  rawBody?: string
  /** The content type sent with `rawBody`. Default text/html. */
  rawType?: string
  /** Wait this long before answering. */
  delayMs?: number
  /** Accept the request and never answer. */
  hang?: boolean
}

export interface ScriptedModel {
  baseUrl: string
  /** Every accepted request, as sent. `key` is the key it came with, whichever header its format puts one in. */
  requests: { body: string; authorization: string; key: string; path: string }[]
  refused: number
  /** The most requests it was ever answering at the same moment. */
  maxInFlight: number
  /** True if the canary appeared in any accepted request. */
  heard(canary: string): boolean
  close(): Promise<void>
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
const usageOf = (entry: ScriptEntry | undefined): unknown => (entry && 'usage' in entry ? entry.usage : USAGE)

export function startScriptedModel(opts: {
  nonce: string; script: ScriptEntry[]; host?: string; port?: number
  /** The wire format to speak. Default: OpenAI chat-completions. */
  shape?: 'openai-chat' | 'anthropic-messages'
  /** Characters per streamed text event. Default 12, which is shorter than the upstream key. */
  streamChunk?: number
}): Promise<ScriptedModel> {
  const pieceOf = new RegExp(`[\\s\\S]{1,${opts.streamChunk ?? 12}}`, 'g')
  const stamp = `FAKE-MODEL-${opts.nonce}`
  const requests: ScriptedModel['requests'] = []
  const state = { refused: 0, inFlight: 0, maxInFlight: 0 }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (opts.shape === 'anthropic-messages') return anthropic(req, res, Buffer.concat(chunks).toString('utf8'))
      const authorization = req.headers.authorization ?? ''
      if (authorization !== `Bearer UPSTREAM-${opts.nonce}`) {
        state.refused++
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'scripted model: not the upstream key of this run' } }))
        return
      }
      const url = new URL(req.url ?? '/', 'http://local')
      if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        res.writeHead(404).end()
        return
      }
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({ body: raw, authorization, key: authorization.replace(/^Bearer /, ''), path: req.url ?? '' })
      let body: { model?: string; stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: { role: string }[] }
      try { body = JSON.parse(raw) } catch { res.writeHead(400).end(); return }

      const entry = opts.script.find((e) => raw.includes(e.match))
      state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight)
      res.once('close', () => { state.inFlight-- })
      if (entry?.hang) return
      if (entry?.delayMs) setTimeout(() => answer(entry, res, body), entry.delayMs)
      else answer(entry, res, body)
    })
  })

  function answer(
    entry: ScriptEntry | undefined, res: http.ServerResponse,
    body: { model?: string; stream?: boolean; stream_options?: { include_usage?: boolean }; messages?: { role: string }[] },
  ): void {
    if (entry?.status !== undefined) {
      res.writeHead(entry.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `scripted model: refused with ${entry.status}` } }))
      return
    }
    if (entry?.rawBody !== undefined) {
      res.writeHead(200, { 'content-type': entry.rawType ?? 'text/html' })
      res.end(entry.rawBody)
      return
    }
    const toolPending = entry?.tool && !(body.messages ?? []).some((m) => m.role === 'tool')
    const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: body.model ?? 'scripted' }
    const text = entry?.noStamp ? entry.text : `${entry?.text ?? 'ok'} ${stamp}`
    entry?.before?.()
    const toolCall = toolPending
      ? { id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: entry!.tool!.name, arguments: JSON.stringify(entry!.tool!.args) } }
      : undefined
    const finish = toolCall ? 'tool_calls' : 'stop'

    if (!body.stream) {
      const message = toolCall ? { role: 'assistant', content: null, tool_calls: [toolCall] } : { role: 'assistant', content: text }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], ...(entry?.noUsage ? {} : { usage: usageOf(entry) }) }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    // With `splitLineEnds`, each event goes out in two writes a moment apart, cut inside its
    // last line ending, the way a network can cut a stream anywhere.
    const queue: string[] = []
    const send = (data: unknown): void => {
      const event = `data:${entry?.tightData ? '' : ' '}${typeof data === 'string' ? data : JSON.stringify(data)}${(entry?.lineEnd ?? '\n').repeat(2)}`
      if (entry?.splitLineEnds) queue.push(event.slice(0, -1), event.slice(-1))
      else res.write(event)
    }
    const finishUp = (): void => {
      const next = queue.shift()
      if (next === undefined) { res.end(); return }
      res.write(next, () => setTimeout(finishUp, 3))
    }
    let sent = 0
    // Running totals, as some providers send them: they end at the true figure.
    const running = () => ({ prompt_tokens: USAGE.prompt_tokens, completion_tokens: Math.min(++sent, USAGE.completion_tokens), total_tokens: 0 })
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      ({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(entry?.usageEveryEvent ? { usage: running() } : {}) })
    send({ ...chunk({ role: 'assistant', content: '' }), ...(entry?.usageFirstOnly ? { usage: { prompt_tokens: USAGE.prompt_tokens, completion_tokens: 0 } } : {}) })
    if (toolCall) send(chunk({ tool_calls: [{ index: 0, ...toolCall }] }))
    else for (const piece of text.match(pieceOf) ?? []) send(chunk({ content: piece }))
    // Dropped only once the text has really gone out, as a provider that dies mid-reply.
    if (entry?.cutStream) { res.write(': cut\n\n', () => res.destroy()); return }
    if (!entry?.noFinish) send(chunk({}, finish))
    if (body.stream_options?.include_usage && !entry?.noUsage && !entry?.usageFirstOnly) send({ ...base, object: 'chat.completion.chunk', choices: [], usage: usageOf(entry) })
    send('[DONE]')
    finishUp()
  }

  // --- the same script, spoken as Anthropic Messages --------------------------
  //
  // Checked against what the Claude Agent SDK 0.3.325 sends and reads: POST
  // /v1/messages, the key in `x-api-key`, the reply as named stream events.
  // Usage comes the way the real API sends it: the input count on
  // `message_start`, the output count on `message_delta`, after the text.
  //
  // One difference from the OpenAI side, on purpose: the entry that plays is
  // the one whose canary is in the LAST thing a person said, and its tool is
  // asked for until that message has a tool result after it. A long session
  // carries every earlier turn, and an earlier turn's canary or tool result
  // must not answer for this one.

  interface AnthropicBlock { type?: string; text?: string }
  interface AnthropicMessage { role?: string; content?: string | AnthropicBlock[] }
  interface AnthropicBody { model?: string; stream?: boolean; messages?: AnthropicMessage[] }

  const blocksOf = (m: AnthropicMessage): AnthropicBlock[] =>
    typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []

  /** The last message a person wrote (not a tool result), and whether a tool result has come back since. */
  function lastAsk(messages: AnthropicMessage[]): { text: string; answered: boolean } {
    for (let i = messages.length - 1; i >= 0; i--) {
      const blocks = blocksOf(messages[i])
      if (messages[i].role !== 'user' || blocks.some((b) => b.type === 'tool_result')) continue
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n')
      if (text === '') continue
      return { text, answered: messages.slice(i + 1).some((m) => blocksOf(m).some((b) => b.type === 'tool_result')) }
    }
    return { text: '', answered: false }
  }

  function anthropic(req: http.IncomingMessage, res: http.ServerResponse, raw: string): void {
    const key = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : ''
    const error = (status: number, type: string, message: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type, message } }))
    }
    if (key !== `UPSTREAM-${opts.nonce}`) {
      state.refused++
      return error(401, 'authentication_error', 'scripted model: not the upstream key of this run')
    }
    const url = new URL(req.url ?? '/', 'http://local')
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') return error(404, 'not_found_error', 'scripted model: only POST /v1/messages exists here')
    // The real API refuses a call that does not say which version of it is meant.
    if (typeof req.headers['anthropic-version'] !== 'string') return error(400, 'invalid_request_error', 'scripted model: no anthropic-version header')
    requests.push({ body: raw, authorization: req.headers.authorization ?? '', key, path: req.url ?? '' })
    let body: AnthropicBody
    try { body = JSON.parse(raw) } catch { return error(400, 'invalid_request_error', 'scripted model: body is not JSON') }

    const asked = lastAsk(body.messages ?? [])
    const entry = opts.script.find((e) => asked.text.includes(e.match))
    state.maxInFlight = Math.max(state.maxInFlight, ++state.inFlight)
    res.once('close', () => { state.inFlight-- })
    if (entry?.hang) return
    const play = (): void => {
      if (entry?.status !== undefined) return error(entry.status, 'api_error', `scripted model: refused with ${entry.status}`)
      if (entry?.rawBody !== undefined) {
        res.writeHead(200, { 'content-type': entry.rawType ?? 'text/html' })
        res.end(entry.rawBody)
        return
      }
      const text = entry?.noStamp ? entry.text : `${entry?.text ?? 'ok'} ${stamp}`
      entry?.before?.()
      const tool = entry?.tool && !asked.answered
        ? { type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name: entry.tool.name, input: entry.tool.args }
        : undefined
      const stop = tool ? 'tool_use' : 'end_turn'
      const usage = usageOf(entry) === USAGE ? { input_tokens: USAGE.prompt_tokens, output_tokens: USAGE.completion_tokens } : usageOf(entry)
      const message = { id: `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`, type: 'message', role: 'assistant', model: body.model ?? 'scripted' }

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ...message, content: [tool ?? { type: 'text', text }], stop_reason: stop, stop_sequence: null,
          ...(entry?.noUsage ? {} : { usage }),
        }))
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const queue: string[] = []
      const end = entry?.lineEnd ?? '\n'
      const send = (data: { type: string } & Record<string, unknown>): void => {
        const event = `event: ${data.type}${end}data:${entry?.tightData ? '' : ' '}${JSON.stringify(data)}${end.repeat(2)}`
        if (entry?.splitLineEnds) queue.push(event.slice(0, -1), event.slice(-1))
        else res.write(event)
      }
      const finishUp = (): void => {
        const next = queue.shift()
        if (next === undefined) { res.end(); return }
        res.write(next, () => setTimeout(finishUp, 3))
      }
      // The opening event says how much went in, and one token out so far.
      const opening = entry?.noUsage ? {} : { usage: usage !== null && typeof usage === 'object' ? { ...usage, output_tokens: 1 } : usage }
      send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, ...opening } })
      if (tool) {
        send({ type: 'content_block_start', index: 0, content_block: { ...tool, input: {} } })
        send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } })
      } else {
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (const piece of text.match(pieceOf) ?? []) send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
      }
      // Dropped only once the text has really gone out, as a provider that dies mid-reply.
      if (entry?.cutStream) { res.write(': cut\n\n', () => res.destroy()); return }
      if (!entry?.noFinish) {
        send({ type: 'content_block_stop', index: 0 })
        const closing = usage !== null && typeof usage === 'object' ? { output_tokens: (usage as { output_tokens?: unknown }).output_tokens } : usage
        send({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, ...(entry?.noUsage ? {} : { usage: closing }) })
        send({ type: 'message_stop' })
      }
      finishUp()
    }
    if (entry?.delayMs) setTimeout(play, entry.delayMs)
    else play()
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://${opts.host ?? '127.0.0.1'}:${port}/v1`,
        requests,
        get refused() { return state.refused },
        get maxInFlight() { return state.maxInFlight },
        heard: (canary) => requests.some((r) => r.body.includes(canary)),
        close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
      })
    })
  })
}
