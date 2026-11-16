// The Claude Agent SDK pump: one SDK session, driven through `query()` with
// a stream of user messages in and a stream of records out. Checked against
// the SDK 0.3.325.
//
// - A turn is one user message in. It is finished at the `result` record,
//   and only there.
// - The reply is the text of that record, and only when the record says, in
//   so many words (`is_error: false`), that the turn finished without error. The SDK writes a failed model call into the
//   same field, under the same subtype (`success`), with `is_error` set. That
//   text is the SDK's, not the model's, and is never passed on.
// - The session says which tools it has in its `init` record, at the start
//   of every turn. If that is not exactly what it was started with, the
//   session is stopped. A turn that ends with no such record gives no reply.
// - The SDK asks before a tool through a callback (`canUseTool`), and waits
//   for as long as it takes. So the veto's timeout is here: whoever is asked
//   gets `vetoTimeoutMs`, and after that the answer is no. Only the exact
//   answer `true` lets the tool run. A question that comes when no turn is
//   open is answered no without asking anyone.
// - Nothing in the SDK makes asking a promise. A result for a call to a tool
//   the session has, that the door was never asked about, means the SDK ran
//   it on its own. The tool has run by then; the session is stopped there and
//   the turn gives no reply. A call it turned down before it would ask (input
//   it rejects, an edit of a file it has not read) comes back as an error
//   that opens with `<tool_use_error>`, and is not a run.
import { CLAUDE_CODE_VERSION } from './caps.ts'
import type { CanUseTool, ClaudeSdk, SdkMessage, SdkOptions, SdkQuery, SdkUserMessage } from './sdk.ts'

export interface GateCall { tool: string; input: unknown }
export interface TurnResult { text: string }

export interface ClaudeSession {
  /** Send one message and wait until the SDK has truly finished. One at a time. */
  prompt(message: string): Promise<TurnResult>
  /** The SDK's id for this session, once it has said it. Needed to pick the session back up. */
  sessionId(): string | undefined
  close(): void
  /** Settles once the SDK's stream of records has ended, however it ended. */
  ended: Promise<void>
}

export interface ClaudeSessionOptions {
  onGate: (call: GateCall) => Promise<boolean>
  /** How long a tool call waits for its answer before the answer is no. Default 30 seconds. */
  vetoTimeoutMs?: number
  /** How long the SDK has, from a session's first message, to say it has started. Default 30 seconds. */
  startMs?: number
}

export const DENIED = 'swarm gate: not allowed'
export const UNASKED = 'the SDK ran a tool without asking the door'

interface Block { type?: unknown; id?: unknown; name?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }

/**
 * A call the SDK turned down before it would ask anyone: input it rejects, or an edit of a file
 * it has not read. Nothing ran. It says so as an error whose text opens with `<tool_use_error>`.
 */
const refusedBeforeAsking = (b: Block): boolean => {
  if (b.is_error !== true) return false
  const text = typeof b.content === 'string' ? b.content
    : Array.isArray(b.content) ? b.content.map((part: { text?: unknown }) => (typeof part?.text === 'string' ? part.text : '')).join('') : ''
  return text.startsWith('<tool_use_error>')
}
const blocksOf = (record: SdkMessage): Block[] => {
  const content = record.message?.content
  return Array.isArray(content) ? content.filter((b): b is Block => b !== null && typeof b === 'object') : []
}

/**
 * The SDK ended a turn without ever saying it had started. It does that when it is asked to
 * pick up a transcript it cannot find. Nothing it says in such a turn is a reply: which
 * version it is and which tools it has were never checked.
 */
export class NeverStarted extends Error {
  constructor() { super('the SDK ended the turn without saying it had started') }
}

const sameTools = (a: string[], b: string[]): boolean => {
  const [x, y] = [[...new Set(a)].sort(), [...new Set(b)].sort()]
  return x.length === y.length && x.every((name, i) => name === y[i])
}

export function createClaudeSession(sdk: ClaudeSdk, options: Omit<SdkOptions, 'canUseTool'>, opts: ClaudeSessionOptions): ClaudeSession {
  let current: { resolve: (r: TurnResult) => void; reject: (e: Error) => void; started: boolean; timer?: ReturnType<typeof setTimeout> } | undefined
  let sessionId: string | undefined
  let closed = false
  const offered = Array.isArray(options.tools) ? options.tools : []
  // Every call the door was asked about, by its id, and the tool each call the SDK made was for.
  const asked = new Set<string>()
  const called = new Map<string, string>()

  // The messages the SDK reads, handed over one at a time as turns are sent.
  const inbox: SdkUserMessage[] = []
  let wake: (() => void) | undefined
  async function* input(): AsyncGenerator<SdkUserMessage> {
    for (;;) {
      while (inbox.length > 0) yield inbox.shift()!
      if (closed) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  }

  const canUseTool: CanUseTool = async (tool, toolInput, how) => {
    if (typeof how?.toolUseID === 'string') asked.add(how.toolUseID)
    let allow = false
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Asked outside a turn: nobody is asked, and the answer is no.
      if (!current || closed) throw new Error('no turn is open')
      const late = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), opts.vetoTimeoutMs ?? 30_000) })
      allow = (await Promise.race([opts.onGate({ tool, input: toolInput }), late])) === true
    } catch {
      allow = false // no turn, an error, or no answer: the tool does not run
    } finally {
      clearTimeout(timer)
    }
    return allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: DENIED }
  }

  let query: SdkQuery | undefined
  const fail = (err: Error): void => {
    const turn = current
    current = undefined
    clearTimeout(turn?.timer)
    turn?.reject(err)
  }
  const stop = (): void => {
    if (closed) return
    closed = true
    wake?.()
    try { query?.close() } catch { /* already gone */ }
  }

  const pump = async (): Promise<void> => {
    try {
      query = sdk.query({ prompt: input(), options: { ...options, canUseTool } })
      for await (const record of query) {
        if (record.type === 'system' && record.subtype === 'init') {
          if (typeof record.session_id === 'string') sessionId = record.session_id
          // What "ask before every tool" means is this version's behaviour, and the tools are what the door offered. Anything else ends here.
          if (record.claude_code_version !== CLAUDE_CODE_VERSION) throw new Error('the SDK started a Claude Code that is not the pinned version')
          if (!sameTools(record.tools ?? [], offered)) throw new Error('the SDK started with tools the turn was not offered')
          if (current) { current.started = true; clearTimeout(current.timer) }
        } else if (record.type === 'assistant') {
          for (const b of blocksOf(record)) if (b.type === 'tool_use' && typeof b.id === 'string') called.set(b.id, String(b.name))
        } else if (record.type === 'user') {
          // A tool it was not started with fails as "no such tool" and nobody is asked. Any other result needs a question first.
          for (const b of blocksOf(record)) {
            if (b.type !== 'tool_result') continue
            const id = String(b.tool_use_id)
            const tool = called.get(id)
            if (!asked.has(id) && (tool === undefined || offered.includes(tool)) && !refusedBeforeAsking(b)) throw new Error(UNASKED)
          }
        } else if (record.type === 'result' && current) {
          const turn = current
          current = undefined
          clearTimeout(turn.timer)
          // The `init` record comes with every turn, before anything else of it. A turn that ends without one was never checked.
          if (!turn.started) turn.reject(new NeverStarted())
          else if (record.subtype === 'success' && record.is_error === false && typeof record.result === 'string') turn.resolve({ text: record.result })
          else turn.reject(new Error('the SDK ended the turn with an error'))
        }
      }
      fail(new Error('the SDK session ended before the turn was finished'))
    } catch (err) {
      fail(err instanceof Error ? err : new Error('the SDK session failed'))
    } finally {
      stop()
    }
  }
  const ended = pump()

  return {
    prompt(message) {
      if (closed) return Promise.reject(new Error('the SDK session is closed'))
      if (current) return Promise.reject(new Error('the SDK is busy with another turn'))
      return new Promise<TurnResult>((resolve, reject) => {
        const turn: NonNullable<typeof current> = { resolve, reject, started: false }
        turn.timer = setTimeout(() => {
          if (current !== turn || turn.started) return
          fail(new Error('the SDK did not say it had started in time'))
          stop()
        }, opts.startMs ?? 30_000)
        turn.timer.unref?.()
        current = turn
        inbox.push({ type: 'user', message: { role: 'user', content: message }, parent_tool_use_id: null })
        wake?.()
      })
    },
    sessionId: () => sessionId,
    close: stop,
    ended,
  }
}
