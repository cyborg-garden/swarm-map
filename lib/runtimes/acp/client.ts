// The client end of the Agent Client Protocol, for one agent process. The
// shim is the client; the agent (OpenCode, or any other that speaks ACP over
// stdio) is the subprocess. Checked against protocol version 1.
//
// What it promises:
// - It offers the agent nothing it would have to run on the agent's behalf:
//   no file reads or writes, no terminal. Those client methods would put the
//   door in charge of real work, but only if the door then held every path and
//   every command; until it does, they are not advertised, and a call to one is
//   answered "method not found".
// - Every permission request is put to `gate`, which answers yes or no for
//   that one call. The answer picks a once-option only (permission.ts).
//   No live prompt, an error, or no answer in `vetoTimeoutMs` is a no.
// - It watches what the agent says it ran. A call reported finished that was
//   never said yes to, or one whose command or file is not the one that was
//   said yes to, is a breach: `onBreach` is told, and the prompt fails. A call
//   reported finished after the turn is over, that was never said yes to, is a
//   breach too: `onBreach` is told and the process is stopped. A call that ran
//   anyway and then reported `failed` looks the same as one that was refused,
//   and is not caught. ACP
//   cannot stop an agent from acting on a no; this is how acting anyway is
//   caught, after the fact. The sealed cell is what bounds it before.
import path from 'node:path'
import { classifyCall, identityOf, namesPathOutside, outcomeAllows, pickOutcome, type AcpToolCall, type AcpToolKind, type Classified } from './permission.ts'
import { createRpcPeer, METHOD_NOT_FOUND, RpcFailure, type AcpProcess, type RpcPeer } from './rpc.ts'

export const ACP_PROTOCOL_VERSION = 1

/** One call the gate is asked about: the door's view of it, and the agent's own id for it. */
export interface GateCall { toolCallId: string; tool: string; input: Record<string, unknown> }

export interface AcpClientOptions {
  /** Where the agent works: the scratch folder. Its session is opened there, and no call may name a path outside it. */
  workDir: string
  /** The adapter's map from ACP tool kind to its own tool name. A kind missing here is refused without asking. */
  kinds: Partial<Record<AcpToolKind, string>>
  /** The yes or no for one call. Anything but a resolved `true` is no. */
  gate: (call: GateCall) => Promise<boolean>
  /** Told when the agent ran something it was not given a yes for. */
  onBreach?: (why: string) => void
  /** The agent's name and version it must report at `initialize`. Anything else is sent no prompt. */
  expect?: { name: string; version: string }
  vetoTimeoutMs?: number
  /** How long `initialize` and opening a session may take. */
  startMs?: number
}

export interface PromptResult { text: string; stopReason: string }

export interface AcpClient {
  /** `initialize`, then a new session or, given an id, the same session again. Resolves to the session id. */
  open(sessionId?: string): Promise<string>
  /** One prompt. Rejects if the agent breached a no, ended, or answered with an error. */
  prompt(text: string): Promise<PromptResult>
  cancel(): void
  close(): void
  /** The tool calls seen in the current or last prompt, by id: what each was decided as. For tests and receipts. */
  readonly decided: ReadonlyMap<string, 'allowed' | 'refused'>
}

interface Live {
  text: string
  breach?: string
  /** Calls the gate said yes to: the kind, and the command or file that yes was for. */
  allowed: Map<string, { kind: AcpToolKind; identity?: string }>
  refused: Set<string>
  /** The last update the agent sent for each call, for a permission request that leaves the input out. */
  seen: Map<string, AcpToolCall>
}

const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

export function createAcpClient(proc: AcpProcess, opts: AcpClientOptions): AcpClient {
  const rpc: RpcPeer = createRpcPeer(proc)
  const startMs = opts.startMs ?? 60_000
  const vetoMs = opts.vetoTimeoutMs ?? 30_000
  let sessionId: string | undefined
  let live: Live | undefined
  const decided = new Map<string, 'allowed' | 'refused'>()
  let failBreach: ((why: string) => void) | undefined
  /** Every call this process was given a yes for, in any turn: a late report of one of them is not a breach. */
  const everAllowed = new Set<string>()

  const norm = (kind: AcpToolKind, identity: string | undefined): string | undefined =>
    identity === undefined ? undefined : kind === 'execute' ? identity : path.resolve(opts.workDir, identity)

  const breach = (why: string): void => {
    if (!live || live.breach) return
    live.breach = why
    opts.onBreach?.(why)
    failBreach?.(why)
  }

  // Asked with a deadline of its own: the gate's no comes at the latest when the veto times out.
  const ask = (call: GateCall): Promise<boolean> => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), vetoMs)
    opts.gate(call).then((yes) => { clearTimeout(timer); resolve(yes === true) }, () => { clearTimeout(timer); resolve(false) })
  })

  rpc.onRequest(async (method, params) => {
    if (method !== 'session/request_permission') throw new RpcFailure(METHOD_NOT_FOUND, 'Method not found')
    const p = obj(params)
    const call = obj(p.toolCall) as AcpToolCall
    const id = typeof call.toolCallId === 'string' ? call.toolCallId : ''
    const no = () => ({ outcome: pickOutcome(p.options, false) })
    // A request for another session, or with no prompt running, is a no without asking anyone.
    const turn = live
    if (!turn || p.sessionId !== sessionId || id === '' || turn.breach) return no()
    const c: Classified = classifyCall(call, opts.kinds, opts.workDir, turn.seen.get(id))
    if (!c.ok) {
      turn.refused.add(id)
      turn.allowed.delete(id)
      decided.set(id, 'refused')
      return no()
    }
    // Every request is asked afresh, an earlier yes for the same id included: a call that changed is a new call.
    turn.allowed.delete(id)
    const yes = await ask({ toolCallId: id, tool: c.tool, input: c.input })
    if (live !== turn || turn.breach) return no()
    const outcome = pickOutcome(p.options, yes)
    if (yes && outcomeAllows(p.options, outcome)) {
      turn.refused.delete(id)
      // The yes is for this command, or this file. The agent's later reports of the call must say the same.
      turn.allowed.set(id, { kind: c.kind, identity: norm(c.kind, String(c.kind === 'execute' ? c.input.command : c.input.path)) })
      everAllowed.add(id)
      decided.set(id, 'allowed')
      return { outcome }
    }
    turn.refused.add(id)
    decided.set(id, 'refused')
    return { outcome: pickOutcome(p.options, false) }
  })

  rpc.onNotification((method, params) => {
    if (method !== 'session/update') return
    const p = obj(params)
    const turn = live
    // Updates for another session, or sent while a session is being read back (before its id is set), are history.
    if (sessionId === undefined || p.sessionId !== sessionId) return
    const u = obj(p.update)
    if (!turn) {
      // No prompt is running, and the agent says a call finished. Unless it was given a yes in an
      // earlier turn, it ran something nobody was asked about: the process is stopped.
      const id = typeof u.toolCallId === 'string' ? u.toolCallId : ''
      if ((u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') && u.status === 'completed' && !everAllowed.has(id)) {
        opts.onBreach?.('the agent ran a call after its turn was over')
        rpc.close()
      }
      return
    }
    const kindOfUpdate = u.sessionUpdate
    if (kindOfUpdate === 'agent_message_chunk') {
      const content = obj(u.content)
      if (content.type === 'text' && typeof content.text === 'string') turn.text += content.text
      return
    }
    if (kindOfUpdate !== 'tool_call' && kindOfUpdate !== 'tool_call_update') return
    const id = typeof u.toolCallId === 'string' ? u.toolCallId : ''
    if (id === '') return
    const merged: AcpToolCall = { ...turn.seen.get(id), ...u, ...(u.rawInput !== undefined ? { rawInput: u.rawInput } : {}) }
    turn.seen.set(id, merged)
    const ok = turn.allowed.get(id)
    // Said yes to, and now reported as something else: a changed command or another file.
    if (ok && u.rawInput !== undefined) {
      const now = norm(ok.kind, identityOf(ok.kind, u.rawInput))
      if (now !== undefined && ok.identity !== undefined && now !== ok.identity) return breach('the agent ran a call other than the one the door said yes to')
      // The same command, moved to run somewhere outside the scratch folder after the yes.
      if (namesPathOutside(u as AcpToolCall, opts.workDir)) return breach('the agent ran a call other than the one the door said yes to')
    }
    if (u.status === 'completed' && !ok) {
      return breach(turn.refused.has(id)
        ? 'the agent ran a call the door said no to'
        : 'the agent ran a call it never asked the door about')
    }
  })

  return {
    decided,
    async open(resume) {
      const init = obj(await rpc.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // Nothing is offered that the client would have to carry out. See the top of this file.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }, startMs))
      if (init.protocolVersion !== ACP_PROTOCOL_VERSION) throw new Error('the agent speaks another version of the protocol')
      if (opts.expect) {
        const info = obj(init.agentInfo)
        if (info.name !== opts.expect.name || info.version !== opts.expect.version) {
          throw new Error('this is not the pinned agent version, so it is sent no prompt')
        }
      }
      if (resume !== undefined && obj(init.agentCapabilities).loadSession === true) {
        await rpc.request('session/load', { sessionId: resume, cwd: opts.workDir, mcpServers: [] }, startMs)
        sessionId = resume
      } else {
        const made = obj(await rpc.request('session/new', { cwd: opts.workDir, mcpServers: [] }, startMs))
        if (typeof made.sessionId !== 'string' || made.sessionId === '') throw new Error('the agent opened no session')
        sessionId = made.sessionId
      }
      return sessionId
    },
    async prompt(text) {
      if (sessionId === undefined) throw new Error('no session is open')
      if (live) throw new Error('a prompt is already running')
      const turn: Live = { text: '', allowed: new Map(), refused: new Set(), seen: new Map() }
      live = turn
      decided.clear()
      const breached = new Promise<never>((_, reject) => { failBreach = (why) => reject(new Error(why)) })
      breached.catch(() => {})
      try {
        const result = obj(await Promise.race([
          rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
          breached,
        ]))
        if (turn.breach) throw new Error(turn.breach)
        return { text: turn.text, stopReason: typeof result.stopReason === 'string' ? result.stopReason : 'unknown' }
      } finally {
        failBreach = undefined
        if (live === turn) live = undefined
      }
    },
    cancel() { if (sessionId !== undefined) rpc.notify('session/cancel', { sessionId }) },
    close() { rpc.close() },
  }
}
