// Model wire formats. The model route swaps the key, meters tokens and
// enforces the budget, and every one of those depends on how a harness talks
// to its model: where the placeholder is presented, which path is the model
// call, where usage is reported, and how streamed text is cut into events.
// All of that lives in a ModelShape, so the route itself assumes no format.
//
// ONE shape exists today: OpenAI chat-completions, which is what Pi speaks.
// A harness that speaks anything else (the Claude Agent SDK and Letta Code's
// Anthropic path use the Anthropic Messages API: `/v1/messages`, `x-api-key`,
// `input_tokens`/`output_tokens`) has NO key swap and NO budget cap until its
// shape is written here and tested. The route refuses a call in a format it
// does not know. A call it does forward is always charged: by the usage the
// reply reports, or, when the reply reports none, at one token per byte.
import type { IncomingHttpHeaders } from 'node:http'

/** One run of text in a stream event that continues across events. */
export interface StreamText {
  /** Which run this piece belongs to, e.g. one per choice. */
  key: string
  text: string
  /** True when no more pieces follow for this run. */
  last: boolean
  /** Replace the piece in the event. */
  set(text: string): void
}

export interface ModelShape {
  id: 'openai-chat'
  /** The one path that is a model call, as the harness requests it. Always POST. */
  path: string
  /** The same call on the provider, relative to its base URL. */
  upstreamPath: string
  /** What the cell presented where a key would go, or undefined if nothing was. */
  presented(headers: IncomingHttpHeaders): string | undefined
  /** The headers that carry the real key to the provider. */
  upstreamAuth(key: string): Record<string, string>
  /** The body to forward for a streamed call, changed only so the stream reports usage. */
  forStream(body: Record<string, unknown>): Record<string, unknown>
  /**
   * Tokens reported by a reply body or by one stream event, if it reports both counts.
   * The route still checks the figure could be true before it believes it.
   */
  usage(json: unknown): { inTokens: number; outTokens: number } | undefined
  /** Does this stream event carry any output at all: text, a tool call, reasoning? A usage figure sent before it does not cover it. */
  hasOutput(json: unknown): boolean
  /** The running text in one parsed stream event. The route redacts across these. */
  streamText(json: unknown): StreamText[]
  /** A stream event carrying only `text` for run `key`, for text still held back when the stream ends. */
  textEvent(key: string, text: string): unknown
}

interface OpenAiChunk {
  choices?: { index?: number; delta?: { content?: unknown }; finish_reason?: unknown }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

export const OPENAI_CHAT: ModelShape = {
  id: 'openai-chat',
  path: '/v1/chat/completions',
  upstreamPath: '/chat/completions',
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
    return choices.some((choice) => choice !== null && typeof choice === 'object' && choice.delta !== null && typeof choice.delta === 'object'
      && Object.values(choice.delta).some((value) => !empty(value)))
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
