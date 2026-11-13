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
import { validatePolicy } from '../core/policy/validate.ts'
import type { PolicyRecord, SurfaceId } from '../core/policy/types.ts'
import { createBrainServer, type BrainServer, type ShimLink } from './brain-server.ts'
import type { ConnectorInbound, SurfaceConnector, SurfaceCreds } from './connector.ts'
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
  reply?: string
  timer: ReturnType<typeof setTimeout>
}

export async function createDoor(opts: DoorOptions): Promise<Door> {
  // F1. No real connector exists in this slice, and none may be slipped in.
  for (const c of opts.connectors) {
    if (c.id !== 'fake') throw new Error(`REFUSING TO RUN: F1 connector '${c.id}' is not the fake connector`)
  }
  const check = (p: PolicyRecord): void => {
    const errors = validatePolicy(p, { testing: opts.testing })
    if (errors.length > 0) throw new Error(`policy refused: ${errors.join('; ')}`)
  }
  check(opts.policy)

  let policy = opts.policy
  let shim: { link: ShimLink; caps: Capabilities } | undefined
  const sanitizer = opts.sanitizer ?? createSanitizer()
  const observed = createObserveBuffer(opts.observeLimit)
  const turns = new Map<string, Turn>()
  const deadlineMs = opts.turnDeadlineMs ?? 120_000

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
  const factsFor = (connector: SurfaceConnector, e: ConnectorInbound): Promise<Facts> =>
    connector.facts({ principal: e.sender, room: e.room })

  const closeTurn = (turn: Turn): void => {
    if (!turns.delete(turn.turnId)) return
    clearTimeout(turn.timer)
    end()
  }

  async function inbound(connector: SurfaceConnector, e: ConnectorInbound): Promise<void> {
    const facts = await factsFor(connector, e)
    const d = decide(policy, e, facts)
    receipt(about(e, 'inbound'), d)
    if (d.verdict !== 'deliver' && d.verdict !== 'observe') return

    let text = e.text
    try {
      const scrubbed = sanitizer.run('inbound', text, { posture: policy.posture, room: e.room })
      text = scrubbed.text
      if (scrubbed.findings.length > 0) {
        receipt(about(e, 'inbound'), { verdict: d.verdict, rule: 'san.in', why: 'A pasted secret was scrubbed before the harness saw it.' },
          scrubbed.findings.map((f) => `${f.pattern} x${f.count}`).join(', '))
      }
    } catch {
      receipt(about(e, 'inbound'), { verdict: d.verdict, rule: 'san.in', why: 'The inbound scrub failed.' },
        'scrub failed; delivered unscrubbed')
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
      turnId, event: e, connector,
      timer: setTimeout(() => {
        receipt(about(e, 'outbound', turnId), { verdict: 'drop', rule: 'out.still-allowed', why: 'The harness did not finish the turn in time.' })
        closeTurn(turn)
      }, deadlineMs),
    }
    turns.set(turnId, turn)
    begin()
    shim.link.send({ t: 'turn', env })
  }

  async function outbound(turn: Turn, text: string): Promise<void> {
    const e = turn.event
    const tag = about(e, 'outbound', turn.turnId)
    // Would this message still be delivered, and may this room still be answered, under the policy as it is now?
    const facts = await factsFor(turn.connector, e)
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
    await turn.connector.send(e.room, { text: clean.text, turnId: turn.turnId })
    receipt({ ...tag, bytes: Buffer.byteLength(clean.text) }, out,
      clean.findings.length > 0 ? clean.findings.map((f) => `${f.pattern} x${f.count}`).join(', ') : undefined)
  }

  function fromShim(link: ShimLink, caps: Capabilities, msg: FromShim): void {
    const unknown = (turnId: string | undefined, what: string): void => {
      receipt({ kind: 'outbound', ...(turnId ? { turnId } : {}) },
        { verdict: 'drop', rule: 'turn.known', why: `The harness sent ${what} for a turn that is not live.` })
    }
    switch (msg.t) {
      case 'reply': {
        const turn = turns.get(msg.turnId)
        if (!turn) return unknown(msg.turnId, 'a reply')
        if (turn.reply !== undefined) {
          receipt(about(turn.event, 'outbound', turn.turnId), { verdict: 'drop', rule: 'turn.one-reply', why: 'The harness sent a second reply for one turn.' })
          return
        }
        turn.reply = msg.text
        return
      }
      case 'settled': {
        const turn = turns.get(msg.turnId)
        if (!turn) return unknown(msg.turnId, 'settled')
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
          receipt({ kind: 'tool', turnId: msg.turnId }, { verdict: 'deny', rule: 'turn.known', why: 'A tool was requested for a turn that is not live.' })
          if (!opts.silentVerdicts) link.send({ t: 'tool_verdict', callId: msg.callId, allow: false, reason: 'unknown turn' })
          return
        }
        const e = turn.event
        void factsFor(turn.connector, e).then((facts) => {
          const d = decide(policy, {
            kind: 'tool', surface: e.surface, room: e.room, actor: e.sender,
            toolClass: caps.toolMap[msg.tool] ?? 'unknown', toolName: msg.tool, argsDigest: '',
          }, facts)
          if (opts.silentVerdicts) return
          receipt(about(e, 'tool', turn.turnId), d, `tool=${msg.tool}`)
          link.send({ t: 'tool_verdict', callId: msg.callId, allow: d.verdict === 'allow', ...(d.verdict === 'allow' ? {} : { reason: d.why }) })
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
