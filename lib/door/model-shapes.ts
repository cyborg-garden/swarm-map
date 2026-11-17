// Model wire formats. The model route swaps the key, meters tokens and
// enforces the budget, and every one of those depends on how a harness talks
// to its model: where the placeholder is presented, which path is the model
// call, where usage is reported, and how streamed text is cut into events.
// All of that lives in a ModelShape, so the route itself assumes no format.
//
// TWO shapes exist today: OpenAI chat-completions, which is what Pi and Letta
// Code speak, and the Anthropic Messages API, which is what the Claude Agent
// SDK speaks. A harness that speaks anything else has NO key swap and NO
// budget cap until its shape is written here and tested. The route refuses a
// call in a format it does not know. A call it does forward is always
// charged: by the usage the reply reports, or, when the reply reports none,
// at one token per byte.
import type { IncomingHttpHeaders } from 'node:http'

/** One run of text in a stream event that continues across events. */
export interface StreamText {
  /** Which run this piece belongs to, e.g. one per choice. */
  key: string
  text: string
  /** True when no more pieces follow for this run. */
  last: boolean
  /**
   * Replace the piece in the event. An event that ends a run but has no place
   * for text of its own may hand back an event that does: the route sends that
   * one first.
   */
  set(text: string): unknown | void
}

/** What a shape remembers between the events of one call. Made by the route, empty, for each call. */
export type CallState = Record<string, unknown>

export interface ModelShape {
  id: 'openai-chat' | 'anthropic-messages'
  /** The one path that is a model call, as the harness requests it. Always POST. */
  path: string
  /** The same call on the provider, relative to its base URL. */
  upstreamPath: string
  /**
   * Where a harness asks which models exist, if this format has such a call. Always GET.
   * Some harnesses ask before their first call and refuse a model that is not listed. The
   * route answers it itself, from the models it has a price for: nothing is forwarded,
   * the real key is not used, and nothing is charged.
   */
  modelsPath?: string
  /**
   * Where a harness asks how many tokens a request would be, if this format has such a
   * call. Always POST. The route answers it itself, with an estimate from the size of
   * the request: nothing is forwarded, the real key is not used, and nothing is charged.
   */
  countPath?: string
  /** Request headers the provider needs as the harness sent them (a format version, say). Never one that carries a key. */
  passHeaders?: string[]
  /** Query parameters of the model call that are passed on. Every other one is dropped. */
  passQuery?: string[]
  /**
   * Why this call would cost something its usage figure does not show, if it would. Such a
   * call is refused: the route forwards nothing it cannot meter.
   */
  unmetered?(body: Record<string, unknown>): string | undefined
  /** What the cell presented where a key would go, or undefined if nothing was. */
  presented(headers: IncomingHttpHeaders): string | undefined
  /** The headers that carry the real key to the provider. */
  upstreamAuth(key: string): Record<string, string>
  /** The body to forward for a streamed call, changed only so the stream reports usage. */
  forStream(body: Record<string, unknown>): Record<string, unknown>
  /**
   * Tokens reported by a reply body or by one stream event, if it reports both counts.
   * The route still checks the figure could be true before it believes it.
   * `call` is the same object for every event of one call, for a format that
   * reports the two counts in different events.
   */
  usage(json: unknown, call: CallState): { inTokens: number; outTokens: number } | undefined
  /** Does this stream event carry any output at all: text, a tool call, reasoning? A usage figure sent before it does not cover it. */
  hasOutput(json: unknown): boolean
  /**
   * Does this stream event, or this whole reply body, say the call failed? A provider that
   * fails after it has started a stream cannot change the status it already sent, so it says
   * so in the stream instead.
   */
  failed?(json: unknown): boolean
  /** The running text in one parsed stream event. The route redacts across these. */
  streamText(json: unknown): StreamText[]
  /** A stream event carrying only `text` for run `key`, for text still held back when the stream ends. */
  textEvent(key: string, text: string): unknown
  /** The name a stream event goes out under, for a format that names its events. Used for events the route writes itself. */
  eventName?(json: unknown): string | undefined
}

interface OpenAiChunk {
  choices?: { index?: number; delta?: { content?: unknown }; finish_reason?: unknown }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export const OPENAI_CHAT: ModelShape = {
  id: 'openai-chat',
  path: '/v1/chat/completions',
  upstreamPath: '/chat/completions',
  modelsPath: '/v1/models',
  presented(headers) {
    const m = /^Bearer (.+)$/.exec(headers.authorization ?? '')
    return m?.[1]
  },
  upstreamAuth: (key) => ({ authorization: `Bearer ${key}` }),
  forStream: (body) => ({ ...body, stream_options: { ...(body.stream_options as object | undefined), include_usage: true } }),
  usage(json) {
    const u = (json as OpenAiChunk | null)?.usage
    // Both counts or nothing: a missing one is not read as zero.
    if (!u || typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number') return undefined
    return { inTokens: u.prompt_tokens, outTokens: u.completion_tokens }
  },
  hasOutput(json) {
    const choices = (json as OpenAiChunk | null)?.choices
    if (!Array.isArray(choices)) return false
    // Any field of a delta that is not empty counts: content, tool_calls, reasoning, whatever comes next.
    const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
    // A whole `message` in a stream event is not how streams are written, but it is output all the same.
    const full = (part: unknown): boolean => part !== null && typeof part === 'object' && Object.values(part).some((value) => !empty(value))
    return choices.some((choice) => choice !== null && typeof choice === 'object'
      && (full(choice.delta) || full((choice as { message?: unknown }).message)))
  },
  failed(json) {
    if (json === null || typeof json !== 'object') return false
    // OpenRouter, and other OpenAI-compatible gateways: a top-level `error`, and a choice that finished with 'error'.
    const error = (json as { error?: unknown }).error
    if (error !== undefined && error !== null && error !== false) return true
    const choices = (json as OpenAiChunk).choices
    return Array.isArray(choices) && choices.some((c) => c !== null && typeof c === 'object' && c.finish_reason === 'error')
  },
  streamText(json) {
    const choices = (json as OpenAiChunk | null)?.choices
    if (!Array.isArray(choices)) return []
    const out: StreamText[] = []
    for (const choice of choices) {
      if (choice === null || typeof choice !== 'object') continue
      const last = choice.finish_reason !== null && choice.finish_reason !== undefined
      const content = choice.delta?.content
      if (typeof content !== 'string' && !last) continue
      out.push({
        key: String(choice.index ?? 0),
        text: typeof content === 'string' ? content : '',
        last,
        set(text) {
          if (text === '' && typeof content !== 'string') return
          choice.delta = { ...choice.delta, content: text }
        },
      })
    }
    return out
  },
  textEvent: (key, text) => ({
    object: 'chat.completion.chunk', choices: [{ index: Number(key), delta: { content: text }, finish_reason: null }],
  }),
}

// --- Anthropic Messages -----------------------------------------------------
//
// What the Claude Agent SDK speaks: POST /v1/messages, the key in `x-api-key`,
// always streamed. Usage comes in two events: `message_start` carries the
// input count, and `message_delta`, after the text, carries the output count.

interface AnthropicUsage {
  input_tokens?: unknown; output_tokens?: unknown
  cache_creation_input_tokens?: unknown; cache_read_input_tokens?: unknown
}
interface AnthropicEvent {
  type?: string
  index?: number
  message?: { usage?: AnthropicUsage | null; content?: unknown }
  usage?: AnthropicUsage | null
  delta?: { type?: string; text?: unknown; thinking?: unknown; partial_json?: unknown }
}

/** The runs of text a content block can stream, and the field of its delta each one is in. */
const ANTHROPIC_RUNS = { text_delta: 'text', thinking_delta: 'thinking', input_json_delta: 'partial_json' } as const
type AnthropicRun = keyof typeof ANTHROPIC_RUNS

/**
 * Input tokens as the provider bills them, in units of plain input tokens. Tokens read from
 * its cache are billed for less than plain input and are counted in full. Tokens written to
 * its cache are billed for more (up to twice), and are counted twice. So the figure is never
 * less than the bill. A count that is there but is not a number makes the figure no number.
 */
function anthropicInput(u: AnthropicUsage): number | undefined {
  if (typeof u.input_tokens !== 'number') return undefined
  const extra = (n: unknown): number => (n === undefined || n === null ? 0 : typeof n === 'number' ? n : Number.NaN)
  return u.input_tokens + extra(u.cache_read_input_tokens) + 2 * extra(u.cache_creation_input_tokens)
}

export const ANTHROPIC_MESSAGES: ModelShape = {
  id: 'anthropic-messages',
  path: '/v1/messages',
  upstreamPath: '/messages',
  countPath: '/v1/messages/count_tokens',
  passHeaders: ['anthropic-version', 'anthropic-beta'],
  passQuery: ['beta'],
  presented(headers) {
    const key = headers['x-api-key']
    return typeof key === 'string' && key !== '' ? key : undefined
  },
  upstreamAuth: (key) => ({ 'x-api-key': key }),
  // A streamed reply always reports usage. Nothing needs asking for.
  forStream: (body) => body,
  unmetered(body) {
    // A tool the provider runs itself (web search, code execution) is billed by the use, not
    // by the token. A tool the harness runs has an `input_schema`; one of the provider's has a `type`.
    const tools = Array.isArray(body.tools) ? body.tools : []
    const served = tools.some((tool) => tool !== null && typeof tool === 'object'
      && typeof (tool as { type?: unknown }).type === 'string' && (tool as { type: string }).type !== 'custom')
    if (served) return 'the call asks for a tool the provider runs and bills by the use, which the usage figure does not show'
    if (Array.isArray(body.mcp_servers) && body.mcp_servers.length > 0) return 'the call asks the provider to reach other servers'
    // The route has one price for a model. A call that asks for the same model at another price is not that call.
    if (body.speed !== undefined && body.speed !== 'standard') return 'the call asks for a faster mode, which is billed at another price'
    if (body.inference_geo !== undefined && body.inference_geo !== 'global') return 'the call asks for a region, which is billed at another price'
    return undefined
  },
  usage(json, call) {
    const j = json as AnthropicEvent | null
    const u = j?.message?.usage ?? j?.usage
    if (!u || typeof u !== 'object') return undefined
    // The input count comes first and is not repeated. It is kept for the event that brings the output count.
    const input = anthropicInput(u)
    if (input !== undefined) call.inTokens = input
    // Both counts or nothing: a missing one is not read as zero.
    if (typeof call.inTokens !== 'number' || typeof u.output_tokens !== 'number') return undefined
    return { inTokens: call.inTokens, outTokens: u.output_tokens }
  },
  hasOutput(json) {
    const j = json as AnthropicEvent | null
    if (j === null || typeof j !== 'object') return false
    // A block that starts or grows is output, whatever is in it: text, a tool call, thinking.
    if (j.type === 'content_block_start' || j.type === 'content_block_delta') return true
    // A whole message in a stream event is not how streams are written, but it is output all the same.
    const content = j.message?.content
    return Array.isArray(content) && content.length > 0
  },
  // An `error` event in a stream, or a reply body that is one.
  failed: (json) => (json as AnthropicEvent | null)?.type === 'error',
  streamText(json) {
    const j = json as AnthropicEvent | null
    if (j === null || typeof j !== 'object' || typeof j.index !== 'number') return []
    const index = j.index
    if (j.type === 'content_block_delta' && j.delta !== null && typeof j.delta === 'object') {
      const delta = j.delta
      const field = ANTHROPIC_RUNS[delta.type as AnthropicRun]
      const text = field === undefined ? undefined : delta[field]
      if (field === undefined || typeof text !== 'string') return []
      return [{ key: `${index}/${delta.type}`, text, last: false, set(next) { delta[field] = next } }]
    }
    if (j.type === 'content_block_stop') {
      // The block is over. This event has no place for text, so text still held back for
      // any of its runs goes out in an event of its own, ahead of this one.
      return (Object.keys(ANTHROPIC_RUNS) as AnthropicRun[]).map((run) => {
        const key = `${index}/${run}`
        return { key, text: '', last: true, set: (next: string) => (next === '' ? undefined : ANTHROPIC_MESSAGES.textEvent(key, next)) }
      })
    }
    return []
  },
  textEvent(key, text) {
    const [index, run] = key.split('/')
    return { type: 'content_block_delta', index: Number(index), delta: { type: run, [ANTHROPIC_RUNS[run as AnthropicRun] ?? 'text']: text } }
  },
  eventName(json) {
    const type = (json as AnthropicEvent | null)?.type
    return typeof type === 'string' ? type : undefined
  },
}

/** Every wire format the route can meter, by id. */
export const MODEL_SHAPES: Record<ModelShape['id'], ModelShape> = { 'openai-chat': OPENAI_CHAT, 'anthropic-messages': ANTHROPIC_MESSAGES }
