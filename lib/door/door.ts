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
import type { Decision, Event, Facts } from '../core/events.ts'
import { fitProblems, keepsOneMemory, scopeProblems } from '../core/policy/fit.ts'
import { validatePolicy } from '../core/policy/validate.ts'
import type { PolicyRecord, SurfaceId } from '../core/policy/types.ts'
import { createBrainServer, type BrainServer, type ShimLink } from './brain-server.ts'
import type { ConnectorInbound, NoticeEvent, SurfaceConnector, SurfaceCreds } from './connector.ts'
import { createObserveBuffer } from './observe-buffer.ts'
import type { Capabilities, Envelope, FromShim, Usage } from './protocol.ts'
import type { Receipt, ReceiptLog } from './receipts.ts'
import { createSanitizer, type Sanitizer } from './sanitizer.ts'

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
  /** Test hook: never answer a tool request, to prove silence means no. */
  silentVerdicts?: boolean
  onUsage?: (turnId: string, usage: Usage) => void
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
  reply?: string
  timer: ReturnType<typeof setTimeout>
}

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

  const closeTurn = (turn: Turn): void => {
    if (!turns.delete(turn.turnId)) return
    clearTimeout(turn.timer)
    end()
  }

  async function inbound(connector: SurfaceConnector, e: ConnectorInbound): Promise<void> {
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
    const tools = Object.entries(caps.toolMap)
      .filter(([toolName, toolClass]) => decide(policy, {
        kind: 'tool', surface: e.surface, room: e.room, actor: e.sender, toolClass, toolName, argsDigest: '',
      }, facts).verdict === 'allow')
      .map(([toolName]) => toolName)
    const env: Envelope = {
      id: e.messageId, turnId, sessionKey, surface: e.surface, room: e.room,
      sender: { id: e.sender.id, display: e.sender.display, isBot: e.sender.isBot },
      text, attachments: e.attachments, context: { observed: observed.drain(sessionKey) },
      tools, whenBusy: 'queue', deadlineMs,
    }
    const turn: Turn = {
      turnId, event: e, connector, botRun,
      timer: setTimeout(() => {
        receipt(about(e, 'outbound', turnId), { verdict: 'drop', rule: 'out.still-allowed', why: 'The harness did not finish the turn in time.' })
        closeTurn(turn)
      }, deadlineMs),
    }
    turns.set(turnId, turn)
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
        const verdict = (allow: boolean, reason?: string): void => {
          if (!opts.silentVerdicts) link.send({ t: 'tool_verdict', callId: msg.callId, allow, ...(allow ? {} : { reason }) })
        }
        void factsFor(turn.connector, e).then((facts) => {
          // The lookup took time. A turn that ended meanwhile gets a no, whatever the policy says.
          if (turns.get(msg.turnId) !== turn) {
            receipt(about(e, 'tool', turn.turnId), { verdict: 'deny', rule: 'turn.known', why: 'The turn ended before the tool could be decided.' }, `tool=${toolName}`)
            return verdict(false, 'the turn is over')
          }
          const d = decide(policy, {
            kind: 'tool', surface: e.surface, room: e.room, actor: e.sender,
            toolClass: mapped ? caps.toolMap[msg.tool] : 'unknown', toolName, argsDigest: '',
          }, facts)
          if (opts.silentVerdicts) return
          receipt(about(e, 'tool', turn.turnId), d, `tool=${toolName}`)
          verdict(d.verdict === 'allow', d.why)
        }).catch(() => {
          // No facts, or no decision: that is no verdict, and no verdict is a no.
          receipt(about(e, 'tool', turn.turnId), { verdict: 'deny', rule: 'tools.no-verdict', why: 'The tool could not be decided, so it does not run.' }, `tool=${toolName}`)
          verdict(false, 'could not decide')
        })
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
