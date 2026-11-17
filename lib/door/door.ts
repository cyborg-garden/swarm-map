// The door: the one process that owns chat in and chat out for an agent.
// The harness sits behind it with no chat token, so every "who may it hear
// and answer" rule is enforced here, once, for every harness. Spec 4.4.
//
// Inbound order:  decide, receipt, scrub, pick the session, attach overheard
//                 lines, send the turn.
// Outbound order: is the turn still live and still allowed, redact, post,
//                 receipt.
import { randomUUID } from 'node:crypto'
import { decide } from '../core/decide.ts'
import type { Decision, Event, Facts, Principal } from '../core/events.ts'
import { fitProblems, keepsOneMemory, scopeProblems } from '../core/policy/fit.ts'
import { validatePolicy } from '../core/policy/validate.ts'
import type { PolicyRecord, SurfaceId, ToolClass } from '../core/policy/types.ts'
import { callHash, DEFAULT_TOOL_LIMITS, shortHash, showInput } from '../core/tools/call.ts'
import { readWebUrl } from '../core/tools/web.ts'
import { readAnswer, readReaction, requestText, type Answer } from './approvals.ts'
import { createBrainServer, type BrainServer, type ShimLink } from './brain-server.ts'
import type { ConnectorInbound, NoticeEvent, SurfaceConnector, SurfaceCreds } from './connector.ts'
import { createObserveBuffer } from './observe-buffer.ts'
import type { Capabilities, Envelope, FromShim, Usage } from './protocol.ts'
import type { Receipt, ReceiptLog } from './receipts.ts'
import { createSanitizer, type Sanitizer } from './sanitizer.ts'
import { createWebFetcher, untrustedText, type WebFetchOptions } from './web-fetch.ts'

export interface Heartbeat { agentId: string; policyHash: string; caps?: Capabilities; ts: string }

export interface DoorOptions {
  policy: PolicyRecord
  connectors: SurfaceConnector[]
  creds: Partial<Record<SurfaceId, SurfaceCreds>>
  receipts: ReceiptLog
  /** Per-cell token the shim must present. */
  brainToken: string
  brainHost?: string
  brainPort?: number
  sanitizer?: Sanitizer
  /** A turn with no `settled` by then is dead, and a late reply is dropped. */
  turnDeadlineMs?: number
  observeLimit?: number
  /**
   * Surfaces whose connector may be something other than the fake one. Empty
   * by default, so a real connector has to be named here, on purpose, by
   * whoever starts the door. Nothing in a test rig sets it without first
   * proving the connector is pointed at a fake (see testing/fake-discord.ts).
   */
  live?: SurfaceId[]
  /** A reply longer than this many characters is cut before it is posted. */
  maxReplyChars?: number
  /** Allows the test-only fake surface in the policy. */
  testing?: boolean
  /** How long an admin has to answer a request to run a tool. No answer by then is a no. Default two minutes. */
  approvalTimeoutMs?: number
  /** How many tool calls one conversation may make in an hour. */
  toolCallsPerHour?: number
  /** Test hook: never answer a tool request, to prove silence means no. */
  silentVerdicts?: boolean
  onUsage?: (turnId: string, usage: Usage) => void
  /** How the door reaches the web for a web tool: DNS, the connection and the limits. Left out, the real ones, https only. */
  web?: WebFetchOptions
  /** Test hook: a fetcher with a part left out on purpose (createWebFetcher's `parts`), to show a check goes red without it. */
  webFetcher?: ReturnType<typeof createWebFetcher>
  /** Test hook: decide a web call with no look at the allowlist, to prove the check for it goes red without one. */
  webListUnchecked?: boolean
}

export interface Door {
  brainPort: number
  shimConnected(): Promise<void>
  policy(): PolicyRecord
  /** Swap the live policy. Takes effect on the next decision, with no restart. */
  setPolicy(policy: PolicyRecord): void
  heartbeat(): Heartbeat
  /** Resolves when no message is being handled and no turn is live. */
  idle(): Promise<void>
  close(): Promise<void>
}

interface Turn {
  turnId: string
  event: ConnectorInbound
  connector: SurfaceConnector
  /** The bot-run count this turn was admitted under, so the re-check before posting asks the same question. */
  botRun: number
  sessionKey: string
  reply?: string
  timer: ReturnType<typeof setTimeout>
}

/** A tool call that is held until an admin answers the request the door posted for it. */
interface Held {
  /** The id of the door's own post. An answer has to point at it. */
  requestId: string
  turn: Turn
  link: ShimLink
  callId: string
  tool: string
  toolClass: ToolClass
  /** The hash of the call that was shown. The yes that goes back to the cell carries it. */
  hash: string
  /** For a web call: the address it was decided on. A yes to it lets the door fetch that address once. */
  web?: string
  timer: ReturnType<typeof setTimeout>
}

/** A web call the door said yes to, and the one address it may fetch for it. Used once. */
interface WebTicket { turn: Turn; link: ShimLink; url: string; tool: string }

export async function createDoor(opts: DoorOptions): Promise<Door> {
  // F1. A connector that is not the fake one is refused unless its surface was named in `live`.
  for (const c of opts.connectors) {
    if (c.id !== 'fake' && !(opts.live ?? []).includes(c.id)) {
      throw new Error(`REFUSING TO RUN: F1 connector '${c.id}' is not the fake connector`)
    }
  }
  const check = (p: PolicyRecord): void => {
    const errors = validatePolicy(p, { testing: opts.testing })
    if (errors.length > 0) throw new Error(`policy refused: ${errors.join('; ')}`)
  }
  check(opts.policy)

  let policy = opts.policy
  let shim: { link: ShimLink; caps: Capabilities } | undefined
  // The one conversation a harness with one memory for the whole agent has been given. It is
  // kept for as long as this door runs, whichever shim is connected: the door cannot tell
  // whether a shim that connects again still holds the memory of the one before it.
  let given: string | undefined
  const sanitizer = opts.sanitizer ?? createSanitizer()
  const observed = createObserveBuffer(opts.observeLimit)
  const turns = new Map<string, Turn>()
  const deadlineMs = opts.turnDeadlineMs ?? 120_000
  const maxReplyChars = opts.maxReplyChars ?? 6000
  const approvalMs = opts.approvalTimeoutMs ?? 120_000
  const callsPerHour = opts.toolCallsPerHour ?? DEFAULT_TOOL_LIMITS.callsPerHour
  // priv.approval: calls waiting for an admin, by the id of the request the door posted.
  const held = new Map<string, Held>()
  // tools.limits: when each conversation's recent tool calls were let through.
  const toolCalls = new Map<string, number[]>()
  // web.*: the web calls that may be fetched, by the id the shim asked under, and when this agent's recent fetches were made.
  const webTickets = new Map<string, WebTicket>()
  let webFetches: number[] = []
  const fetcher = opts.webFetcher ?? createWebFetcher(opts.web)
  // bots.loop: bot messages delivered in a row, per room, since a person was last delivered there.
  // A thread counts with its parent, so a loop cannot carry on by moving into one.
  // Where the policy names its bots, each named bot has a count of its own in a room. Where it does
  // not, every bot in the room shares one, so a bot under a new id is not a new start.
  const botRuns = new Map<string, Map<string, number>>()
  const roomKey = (e: ConnectorInbound): string => `${e.surface}:${e.room.kind === 'thread' ? (e.room.parentId ?? e.room.id) : e.room.id}`
  const botKey = (e: ConnectorInbound): string => ((policy.surfaces[e.surface]?.bots.ids ?? []).includes(e.sender.id) ? e.sender.id : '')
  const runOf = (e: ConnectorInbound): number => botRuns.get(roomKey(e))?.get(botKey(e)) ?? 0

  // idle() bookkeeping: messages being handled plus live turns.
  let busy = 0
  let waiters: (() => void)[] = []
  const begin = (): void => { busy++ }
  const end = (): void => {
    busy--
    if (busy === 0) { const w = waiters; waiters = []; for (const resolve of w) resolve() }
  }

  const receipt = (
    event: Receipt['event'], d: Pick<Decision, 'verdict' | 'rule' | 'why'>, note?: string,
  ): void => {
    opts.receipts.write({
      ts: new Date().toISOString(), agentId: policy.agentId, policyHash: policy.hash,
      event, verdict: d.verdict, rule: d.rule, why: d.why, ...(note ? { note } : {}),
    })
  }
  const about = (e: ConnectorInbound, kind: Event['kind'], turnId?: string): Receipt['event'] => ({
    kind, surface: e.surface, room: e.room.id, sender: e.sender.id, messageId: e.messageId,
    ...(turnId ? { turnId } : {}), ...(kind === 'inbound' ? { bytes: Buffer.byteLength(e.text) } : {}),
  })
  // The connector's facts, plus the one the door keeps itself. A connector cannot set the bot-run count.
  const factsFor = async (connector: SurfaceConnector, e: ConnectorInbound, botRun = runOf(e)): Promise<Facts> =>
    ({ ...await connector.facts({ principal: e.sender, room: e.room }), botTurnsInARow: botRun })

  // A call that was waiting for an answer goes with its turn, however the turn ended. Its request can no longer be answered.
  const dropHeld = (turn: Turn): void => {
    for (const [callId, t] of [...webTickets]) if (t.turn === turn) webTickets.delete(callId)
    for (const h of [...held.values()]) {
      if (h.turn !== turn) continue
      held.delete(h.requestId)
      clearTimeout(h.timer)
      receipt(about(turn.event, 'tool', turn.turnId), { verdict: 'deny', rule: 'turn.known', why: 'The turn ended while the call waited for an admin, so it does not run.' }, `tool=${h.tool} call=${shortHash(h.hash)}`)
      h.link.send({ t: 'tool_verdict', callId: h.callId, allow: false, reason: 'the turn is over' })
    }
  }
  const closeTurn = (turn: Turn): void => {
    if (!turns.delete(turn.turnId)) return
    clearTimeout(turn.timer)
    dropHeld(turn)
    end()
  }
  /** The clock on a turn: started when the turn is, stopped while a call of its waits for an admin, and started again after. */
  const startClock = (turn: Turn): void => {
    clearTimeout(turn.timer)
    if (turns.get(turn.turnId) !== turn || [...held.values()].some((h) => h.turn === turn)) return
    turn.timer = setTimeout(() => {
      receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'out.still-allowed', why: 'The harness did not finish the turn in time.' })
      closeTurn(turn)
    }, deadlineMs)
  }

  // priv.approval. An answer has to point at an open request: a reply to it, or a reaction on it.
  // Who sent it is whoever the surface says did, and decide() says whether that account may answer.
  // Returns true when the message was about a request, open or not the door's to answer: such a
  // message is for the door, and is never passed to the harness.
  function answered(surface: SurfaceId, room: string, requestId: string | undefined, by: Principal, say: Answer | undefined): boolean {
    const h = requestId === undefined ? undefined : held.get(requestId)
    if (!h) return false
    const e = h.turn.event
    const tag = { kind: 'approval' as const, surface, room, sender: by.id, messageId: h.requestId, turnId: h.turn.turnId }
    const note = `tool=${h.tool} call=${shortHash(h.hash)}`
    if (surface !== e.surface || room !== e.room.id) {
      receipt(tag, { verdict: 'deny', rule: 'priv.approval', why: 'An answer has to be in the room the request was posted in.' }, note)
      return true
    }
    const who = decide(policy, { kind: 'approval', surface, room: e.room, approver: by }, {})
    if (who.verdict !== 'allow') { receipt(tag, who, note); return true }
    if (say === undefined) {
      receipt(tag, { verdict: 'deny', rule: 'priv.approval', why: 'That is not an answer. The request is still open.' }, note)
      return true
    }
    // From here the request is closed: it is answered once, and never again.
    held.delete(h.requestId)
    clearTimeout(h.timer)
    receipt(tag, who, `answer=${say} ${note}`)
    if (say === 'deny') { settle(h, false, 'An admin said no, so the call does not run.'); return true }
    // The yes is checked against the rules as they are now, not as they were when the door asked.
    const now = decide(policy, { kind: 'tool', surface: e.surface, room: e.room, actor: e.sender, toolClass: h.toolClass, toolName: h.tool, argsDigest: '' }, {})
    if (now.verdict === 'deny') { settle(h, false, `The rules changed while the call waited: ${now.why}`, now.rule); return true }
    settle(h, true, 'An admin said yes, so the call runs.')
    return true
  }

  /**
   * Close a held call with its verdict, and start its turn's clock again. A held call never
   * outlives its turn (dropHeld), so the turn is live here.
   */
  function settle(h: Held, allow: boolean, why: string, rule = 'priv.approval'): void {
    receipt(about(h.turn.event, 'tool', h.turn.turnId), { verdict: allow ? 'allow' : 'deny', rule, why }, `tool=${h.tool} call=${shortHash(h.hash)}`)
    if (allow && h.web !== undefined) webTickets.set(h.callId, { turn: h.turn, link: h.link, url: h.web, tool: h.tool })
    h.link.send({ t: 'tool_verdict', callId: h.callId, allow, ...(allow ? { hash: h.hash } : { reason: why }) })
    startClock(h.turn)
  }

  async function inbound(connector: SurfaceConnector, e: ConnectorInbound): Promise<void> {
    if (answered(e.surface, e.room.id, e.replyTo, e.sender, readAnswer(e.text))) return
    // The lookup comes first. From the count being read to the count being written nothing waits,
    // so messages that arrive together are counted one by one, not all against the same figure.
    const looked = await connector.facts({ principal: e.sender, room: e.room })
    const botRun = runOf(e)
    const facts: Facts = { ...looked, botTurnsInARow: botRun }
    const d = decide(policy, e, facts)
    receipt(about(e, 'inbound'), d)
    if (d.verdict !== 'deliver' && d.verdict !== 'observe') return
    // Counted when the message is admitted, not when it is answered, so a slow harness cannot let a burst through.
    // A person who is heard starts every count in the room again.
    if (d.verdict === 'deliver') {
      if (!e.sender.isBot) botRuns.delete(roomKey(e))
      else botRuns.set(roomKey(e), (botRuns.get(roomKey(e)) ?? new Map<string, number>()).set(botKey(e), botRun + 1))
    }

    let text = e.text
    try {
      const scrubbed = sanitizer.run('inbound', text, { posture: policy.posture, room: e.room })
      text = scrubbed.text
      if (scrubbed.findings.length > 0) {
        receipt(about(e, 'inbound'), { verdict: d.verdict, rule: 'san.in', why: 'A pasted secret was scrubbed before the harness saw it.' },
          scrubbed.findings.map((f) => `${f.pattern} x${f.count}`).join(', '))
      }
    } catch {
      // Fail closed: text that could not be scrubbed is not delivered and not kept as context.
      receipt(about(e, 'inbound'), { verdict: 'drop', rule: 'san.in', why: 'The inbound scrub failed, so the message was not passed on.' })
      return
    }

    const sessionKey = d.sessionKey!
    if (d.verdict === 'observe') {
      observed.add(sessionKey, { sender: e.sender.display, text, ts: new Date().toISOString() })
      return
    }
    if (!shim) {
      receipt(about(e, 'inbound'), { verdict: 'drop', rule: 'turn.no-harness', why: 'No harness is connected, so the message was not delivered.' })
      return
    }
    // A harness that keeps one memory for the whole agent is given one conversation. A policy
    // that opens more is refused for it when it is set; this is the same check at the last
    // moment, for a harness that connected under a policy already in place.
    // And the first conversation it is given is the only one: a policy that moves the one room
    // fits by itself, but the harness would carry what it learned in the old room into the new.
    const misfit = [...fitProblems(policy, shim.caps), ...scopeProblems(given, sessionKey, shim.caps)]
    if (misfit.length > 0) {
      receipt(about(e, 'inbound'), { verdict: 'drop', rule: 'mem.one-scope', why: misfit[0] })
      return
    }
    // A DM must not land where a room's turn can read it back. The session key
    // keeps them apart in name only; on disk that is the harness's job, and a
    // harness that does not declare it is not given the message.
    if ((e.isDm || e.room.kind === 'dm') && policy.memory.dmIsolated && shim.caps.sessionIsolation !== 'sealed') {
      receipt(about(e, 'inbound'), {
        verdict: 'drop', rule: 'mem.dm-isolated',
        why: 'This harness keeps every session in one place on disk, so a direct message is not delivered to it.',
      })
      return
    }

    const caps = shim.caps
    const turnId = randomUUID()
    // A tool that would have to wait for a yes is only offered to a harness that can hold a call.
    const offered = caps.approvalRoundTrip === true ? ['allow', 'ask'] : ['allow']
    const tools = Object.entries(caps.toolMap)
      .filter(([toolName, toolClass]) => offered.includes(decide(policy, {
        kind: 'tool', surface: e.surface, room: e.room, actor: e.sender, toolClass, toolName, argsDigest: '',
      }, facts).verdict))
      .map(([toolName]) => toolName)
    const env: Envelope = {
      id: e.messageId, turnId, sessionKey, surface: e.surface, room: e.room,
      sender: { id: e.sender.id, display: e.sender.display, isBot: e.sender.isBot },
      text, attachments: e.attachments, context: { observed: observed.drain(sessionKey) },
      tools, whenBusy: 'queue', deadlineMs,
    }
    const turn: Turn = { turnId, event: e, connector, botRun, sessionKey, timer: undefined as never }
    turns.set(turnId, turn)
    startClock(turn)
    begin()
    if (keepsOneMemory(caps)) given = sessionKey
    shim.link.send({ t: 'turn', env })
  }

  async function outbound(turn: Turn, text: string): Promise<void> {
    const e = turn.event
    const tag = about(e, 'outbound', turn.turnId)
    // Would this message still be delivered, and may this room still be answered, under the policy as it is now?
    const facts = await factsFor(turn.connector, e, turn.botRun)
    const again = decide(policy, e, facts)
    if (again.verdict !== 'deliver') {
      receipt(tag, { verdict: 'drop', rule: 'out.still-allowed', why: `The policy changed mid-turn: ${again.why}` })
      return
    }
    const out = decide(policy, { kind: 'outbound', surface: e.surface, room: e.room, turnId: turn.turnId, text }, { ...facts, turnLive: true })
    if (out.verdict !== 'allow') { receipt(tag, out); return }

    let clean: ReturnType<Sanitizer['run']>
    try {
      clean = sanitizer.run('outbound', text, { posture: policy.posture, room: e.room })
    } catch {
      receipt(tag, { verdict: 'drop', rule: 'san.out', why: 'The outbound check failed, so nothing was posted.' })
      return
    }
    // Cut after the redaction, so a secret cannot be split across the cut and survive it.
    const chars = [...clean.text]
    const cut = chars.length > maxReplyChars
    const body = cut ? `${chars.slice(0, maxReplyChars).join('')}\n[cut: the reply was longer than this room allows]` : clean.text
    await turn.connector.send(e.room, { text: body, turnId: turn.turnId, inReplyTo: e.messageId })
    const notes = clean.findings.map((f) => `${f.pattern} x${f.count}`)
    receipt({ ...tag, bytes: Buffer.byteLength(body) }, out, notes.length > 0 ? notes.join(', ') : undefined)
    if (cut) receipt({ ...tag, bytes: Buffer.byteLength(body) }, { verdict: 'allow', rule: 'out.size', why: 'The reply was longer than the limit, so it was cut before it was posted.' }, `chars=${chars.length} limit=${maxReplyChars}`)
  }

  // in.once: a message is read once. An edit is not read again, and a reply to a message
  // that was deleted while its turn ran is not posted.
  function notice(n: NoticeEvent): void {
    const tag = { kind: 'inbound' as const, surface: n.surface, room: n.room, messageId: n.messageId }
    if (n.what === 'edit') {
      receipt(tag, { verdict: 'drop', rule: 'in.once', why: 'An edited message is not read again.' })
      return
    }
    for (const turn of [...turns.values()]) {
      if (turn.event.surface !== n.surface || turn.event.messageId !== n.messageId) continue
      receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'in.once', why: 'The message was deleted before it was answered, so nothing is posted.' })
      shim?.link.send({ t: 'cancel', turnId: turn.turnId })
      closeTurn(turn)
    }
  }

  function fromShim(link: ShimLink, caps: Capabilities, msg: FromShim): void {
    // A turn id the door did not issue is harness-supplied text. It is never written down.
    const unknown = (what: string): void => {
      receipt({ kind: 'outbound' },
        { verdict: 'drop', rule: 'turn.known', why: `The harness sent ${what} for a turn that is not live.` })
    }
    switch (msg.t) {
      case 'reply': {
        const turn = turns.get(msg.turnId)
        if (!turn) return unknown('a reply')
        if (turn.reply !== undefined) {
          receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'turn.one-reply', why: 'The harness sent a second reply for one turn.' })
          return
        }
        turn.reply = msg.text
        return
      }
      case 'settled': {
        const turn = turns.get(msg.turnId)
        if (!turn) return unknown('settled')
        if (msg.usage) opts.onUsage?.(turn.turnId, msg.usage)
        clearTimeout(turn.timer)
        turns.delete(turn.turnId) // no reply can join this turn from here on
        dropHeld(turn) // and no call of it can still be approved
        const finish = turn.reply === undefined ? Promise.resolve() : outbound(turn, turn.reply)
        void finish.catch(() => {
          receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'out.still-allowed', why: 'Posting the reply failed.' })
        }).finally(end)
        return
      }
      case 'tool_request': {
        const turn = turns.get(msg.turnId)
        if (!turn) {
          receipt({ kind: 'tool' }, { verdict: 'deny', rule: 'turn.known', why: 'A tool was requested for a turn that is not live.' })
          if (!opts.silentVerdicts) link.send({ t: 'tool_verdict', callId: msg.callId, allow: false, reason: 'unknown turn' })
          return
        }
        const e = turn.event
        // The tool name is whatever the shim sent. Only a name from the map it
        // declared at hello (checked there to be a plain name) is used or
        // written down; anything else is the fixed code 'unmapped'.
        const mapped = typeof msg.tool === 'string' && Object.hasOwn(caps.toolMap, msg.tool)
        const toolName = mapped ? msg.tool : 'unmapped'
        const toolClass: ToolClass = mapped ? caps.toolMap[msg.tool] : 'unknown'
        // The hash is of the name the shim sent, so it matches what the cell works out. Only the hash is written down.
        const hash = callHash(typeof msg.tool === 'string' ? msg.tool : '', msg.input)
        const tag = about(e, 'tool', turn.turnId)
        const note = `tool=${toolName} call=${shortHash(hash)}`
        const verdict = (allow: boolean, reason?: string): void => {
          if (!opts.silentVerdicts) link.send({ t: 'tool_verdict', callId: msg.callId, allow, ...(allow ? { hash } : { reason }) })
        }
        const refuse = (rule: string, why: string): void => { receipt(tag, { verdict: 'deny', rule, why }, note); verdict(false, why) }
        // Whether this call stopped its turn's clock. Only a call that did may start it again: no other request moves a turn's deadline.
        let stopped = false
        void factsFor(turn.connector, e).then(async (facts) => {
          // The lookup took time. A turn that ended meanwhile gets a no, whatever the policy says.
          if (turns.get(msg.turnId) !== turn) return refuse('turn.known', 'The turn ended before the tool could be decided.')
          const d = decide(policy, { kind: 'tool', surface: e.surface, room: e.room, actor: e.sender, toolClass, toolName, argsDigest: hash }, facts)
          if (opts.silentVerdicts) return
          if (d.verdict !== 'allow' && d.verdict !== 'ask') { receipt(tag, d, note); return verdict(false, d.why) }

          // web.allow: a web call takes one address and nothing else, and the address has to be on the list.
          // What is shown to an admin, and what the door later fetches, is that one address.
          let web: string | undefined
          if (toolClass === 'network') {
            const input = msg.input as Record<string, unknown> | null
            if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'url') {
              return refuse('web.allow', 'A web call takes one address and nothing else.')
            }
            const read = readWebUrl(input.url, fetchSchemes)
            if ('problem' in read) return refuse('web.allow', `That address is refused: ${read.problem}.`)
            const e2 = decide(policy, { kind: 'egress', host: read.host, path: read.path, method: 'GET' }, facts)
            if (e2.verdict !== 'allow' && !opts.webListUnchecked) return refuse(e2.rule, e2.why)
            web = input.url as string
          }

          // tools.limits: a conversation gets so many calls an hour. Counted when the rules let a call
          // through, to run or to be asked about, so a call the rules refuse costs nothing.
          const since = Date.now() - 3_600_000
          const recent = (toolCalls.get(turn.sessionKey) ?? []).filter((at) => at > since)
          if (recent.length >= callsPerHour) return refuse('tools.limits', 'This conversation has made as many tool calls as it may in an hour.')
          toolCalls.set(turn.sessionKey, [...recent, Date.now()])

          if (d.verdict === 'allow') {
            receipt(tag, d, note)
            if (web !== undefined) webTickets.set(msg.callId, { turn, link, url: web, tool: toolName })
            return verdict(true)
          }

          // priv.approval: hold the call, show it in the room, and wait for an admin.
          const no = (why: string): void => refuse('priv.approval', why)
          if (caps.approvalRoundTrip !== true) return no('This harness cannot hold a call while an admin answers.')
          if (!(policy.surfaces[e.surface]?.admins ?? []).some((ref) => ref.kind === 'user')) return no('Nobody is on the admin list, so nobody could say yes.')
          const shown = showInput(msg.input)
          if ('problem' in shown) return no(`It cannot be shown for approval: ${shown.problem}.`)
          const text = requestText(toolName, shown.text, hash, approvalMs)
          // What is posted has to be what would run. A request the outbound check would change is not posted.
          let clean: ReturnType<Sanitizer['run']>
          try { clean = sanitizer.run('outbound', text, { posture: policy.posture, room: e.room }) } catch { return no('The outbound check failed, so the request was not posted.') }
          if (clean.findings.length > 0 || clean.text !== text) return no('The call holds something secret-shaped, so it is not shown and does not run.')
          const out = decide(policy, { kind: 'outbound', surface: e.surface, room: e.room, turnId: turn.turnId, text }, { ...facts, turnLive: true })
          if (out.verdict !== 'allow') return no(`The request could not be posted: ${out.why}`)
          clearTimeout(turn.timer) // the turn's clock stops while a person is asked
          stopped = true
          let requestId: string
          try {
            requestId = (await turn.connector.send(e.room, { text, turnId: turn.turnId, inReplyTo: e.messageId })).id
          } catch {
            startClock(turn)
            return no('The request could not be posted, so the call does not run.')
          }
          if (turns.get(msg.turnId) !== turn) return refuse('turn.known', 'The turn ended before the tool could be decided.')
          if (requestId === '' || held.has(requestId)) { startClock(turn); return no('The request could not be posted, so the call does not run.') }
          const h: Held = {
            requestId, turn, link, callId: msg.callId, tool: toolName, toolClass, hash, ...(web !== undefined ? { web } : {}),
            timer: setTimeout(() => {
              if (held.delete(requestId)) settle(h, false, 'No admin answered in time, so the call does not run.')
            }, approvalMs),
          }
          held.set(requestId, h)
          receipt({ ...tag, bytes: Buffer.byteLength(text) }, d, `${note} request=${requestId}`)
        }).catch(() => {
          // No facts, or no decision: that is no verdict, and no verdict is a no.
          if (stopped) startClock(turn)
          refuse('tools.no-verdict', 'The tool could not be decided, so it does not run.')
        })
        return
      }
      case 'web_fetch': {
        void fetchFor(link, msg.callId, msg.url)
        return
      }
      case 'error': {
        const turn = msg.turnId ? turns.get(msg.turnId) : undefined
        if (turn) {
          receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'out.still-allowed', why: 'The harness reported an error for this turn.' })
          closeTurn(turn)
        }
        return
      }
      default:
        return // hello is handled by the brain server; delta, tool_done and health carry no decision
    }
  }

  const fetchSchemes = opts.web?.schemes ?? ['https:']
  /**
   * web.*: fetch the page for a web call the door said yes to. Only the call's own shim may ask,
   * only for the address the call was decided on, only once, and only while its turn is live.
   * Each hop is put to the rules as they are now. What comes back goes to that shim and nowhere
   * else, and the receipt holds the host, the path and the size.
   */
  async function fetchFor(link: ShimLink, callId: unknown, url: unknown): Promise<void> {
    const answer = (ok: boolean, body: { text?: string; reason?: string }): void => {
      if (typeof callId === 'string') link.send({ t: 'web_result', callId, ok, ...body })
    }
    const ticket = typeof callId === 'string' ? webTickets.get(callId) : undefined
    // Asked for once, used: a wrong address under a call's id spends that call too.
    if (ticket) webTickets.delete(callId as string)
    if (!ticket || ticket.link !== link || ticket.url !== url || turns.get(ticket.turn.turnId) !== ticket.turn) {
      receipt({ kind: 'egress' }, { verdict: 'deny', rule: 'web.allow', why: 'A page was asked for that is not one the door said yes to.' })
      return answer(false, { reason: 'not a fetch the door said yes to' })
    }
    const e = ticket.turn.event
    const tag = about(e, 'egress', ticket.turn.turnId)
    const since = Date.now() - 3_600_000
    webFetches = webFetches.filter((at) => at > since)
    if (webFetches.length >= fetcher.limits.perHour) {
      receipt(tag, { verdict: 'deny', rule: 'web.limits', why: 'This agent has made as many web fetches as it may in an hour.' }, `tool=${ticket.tool}`)
      return answer(false, { reason: 'too many web fetches this hour' })
    }
    webFetches.push(Date.now())
    const check = (host: string, path: string): string | undefined => {
      if (opts.webListUnchecked) return undefined
      const d = decide(policy, { kind: 'egress', host, path, method: 'GET' }, {})
      return d.verdict === 'allow' ? undefined : d.why
    }
    let result: Awaited<ReturnType<typeof fetcher.fetch>>
    try { result = await fetcher.fetch(ticket.url, check) } catch { result = { ok: false, code: 'error', why: 'the fetch failed' } }
    const where = result.host === undefined ? '' : `host=${result.host} path=${shownPath(result.path ?? '')}`
    if (!result.ok) {
      const rule = { rules: 'web.allow', address: 'web.allow', redirect: 'web.redirect', private: 'web.private', time: 'web.limits', type: 'web.limits', status: 'web.allow', error: 'web.allow' }[result.code]
      receipt(tag, { verdict: 'deny', rule, why: `The page was not fetched: ${result.why}.` }, [`tool=${ticket.tool}`, `code=${result.code}`, where].filter(Boolean).join(' '))
      return answer(false, { reason: result.why })
    }
    receipt({ ...tag, bytes: result.bytes }, { verdict: 'allow', rule: 'web.allow', why: 'The door fetched the page and handed it to the model only.' },
      `tool=${ticket.tool} ${where} bytes=${result.bytes} status=${result.status} hops=${result.hops}${result.cut ? ` cut=${result.cut}` : ''}`)
    answer(true, { text: untrustedText(result, randomUUID().slice(0, 8)) })
  }
  /** A path as a receipt may hold it: plain characters, short, and nothing secret-shaped. Anything else is counted, not shown. */
  const shownPath = (p: string): string => {
    let secretShaped = true
    try { secretShaped = sanitizer.run('outbound', p, { posture: policy.posture, room: { id: '', kind: 'channel' } }).findings.length > 0 } catch { /* counted below */ }
    return /^[A-Za-z0-9._~/-]{0,160}$/.test(p) && !secretShaped ? p : `(${p.length} characters, not shown)`
  }

  const brain: BrainServer = await createBrainServer({
    token: opts.brainToken, host: opts.brainHost, port: opts.brainPort,
    onShim: (link, caps) => {
      shim = { link, caps }
      link.onMessage((msg) => fromShim(link, caps, msg))
      link.onClose(() => { if (shim?.link === link) shim = undefined })
    },
  })

  for (const connector of opts.connectors) {
    const creds = opts.creds[connector.id]
    if (!creds) throw new Error(`no credentials given for the ${connector.id} connector`)
    await connector.connect(creds)
    connector.onEvent((e) => {
      if (e.kind === 'notice') return notice(e)
      // A reaction is only ever read as an answer to an open request. On anything else it is nothing.
      if (e.kind === 'reaction') { answered(e.surface, e.room, e.messageId, e.sender, readReaction(e.emoji)); return }
      if (e.kind !== 'inbound') return // invites are not built in this slice
      begin()
      void inbound(connector, e).catch((err) => {
        receipt(about(e, 'inbound'), { verdict: 'drop', rule: 'ctl.valid', why: `The door could not decide: ${(err as Error).name}.` })
      }).finally(end)
    })
  }

  return {
    brainPort: brain.port,
    shimConnected: () => brain.connected(),
    policy: () => policy,
    setPolicy(next) {
      check(next)
      if (next.agentId !== policy.agentId) throw new Error('policy refused: agentId: belongs to another agent')
      const misfit = shim ? fitProblems(next, shim.caps) : []
      if (misfit.length > 0) throw new Error(`policy refused: ${misfit.join('; ')}`)
      policy = next
    },
    heartbeat: () => ({ agentId: policy.agentId, policyHash: policy.hash, caps: shim?.caps, ts: new Date().toISOString() }),
    idle: () => (busy === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push(resolve) })),
    async close() {
      for (const turn of [...turns.values()]) closeTurn(turn)
      await brain.close()
      for (const connector of opts.connectors) await connector.close()
    },
  }
}
