// The scripted model: a tiny local server that speaks the OpenAI
// chat-completions shape and plays replies from a script. It stands in for
// "the model" at the far edge of the rig.
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
  /** Streamed only: report running usage on every event, not once at the end. */
  usageEveryEvent?: boolean
  /** Streamed only: drop the connection after the text, before the finish, usage and [DONE] events. */
  cutStream?: boolean
  /** Answer with this status and an error body, as a provider that refused the call. */
  status?: number
  /** Answer 200 with exactly this body, which need not be JSON. */
  rawBody?: string
  /** Wait this long before answering. */
  delayMs?: number
  /** Accept the request and never answer. */
  hang?: boolean
}

export interface ScriptedModel {
  baseUrl: string
  /** Every accepted request, as sent. */
  requests: { body: string; authorization: string }[]
  refused: number
  /** The most requests it was ever answering at the same moment. */
  maxInFlight: number
  /** True if the canary appeared in any accepted request. */
  heard(canary: string): boolean
  close(): Promise<void>
}

const USAGE = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }

export function startScriptedModel(opts: {
  nonce: string; script: ScriptEntry[]; host?: string; port?: number
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
      requests.push({ body: raw, authorization })
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
      res.writeHead(200, { 'content-type': 'text/html' })
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
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], ...(entry?.noUsage ? {} : { usage: USAGE }) }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (data: unknown): void => { res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`) }
    let sent = 0
    // Running totals, as some providers send them: they end at the true figure.
    const running = () => ({ prompt_tokens: USAGE.prompt_tokens, completion_tokens: Math.min(++sent, USAGE.completion_tokens), total_tokens: 0 })
    const chunk = (delta: unknown, finish_reason: string | null = null) =>
      ({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }], ...(entry?.usageEveryEvent ? { usage: running() } : {}) })
    send(chunk({ role: 'assistant', content: '' }))
    if (toolCall) send(chunk({ tool_calls: [{ index: 0, ...toolCall }] }))
    else for (const piece of text.match(pieceOf) ?? []) send(chunk({ content: piece }))
    // Dropped only once the text has really gone out, as a provider that dies mid-reply.
    if (entry?.cutStream) { res.write(': cut\n\n', () => res.destroy()); return }
    if (!entry?.noFinish) send(chunk({}, finish))
    if (body.stream_options?.include_usage && !entry?.noUsage) send({ ...base, object: 'chat.completion.chunk', choices: [], usage: USAGE })
    send('[DONE]')
    res.end()
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
