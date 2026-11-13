// The fake connector: a scripted room in, a ledger of captured posts out.
// Nothing is ever sent anywhere. It is a first-class connector, used by every
// test, and it refuses to connect with anything but the token minted for the
// run it belongs to, so it cannot be mistaken for, or pointed at, a real one.
import { randomUUID } from 'node:crypto'
import type { Facts, RoomRef } from '../../core/events.ts'
import { toPrincipal, toRoom, type RoomInput, type SenderInput } from '../../core/normalise.ts'
import type { ConnectorInbound, InviteEvent, SurfaceConnector } from '../connector.ts'

export interface SayInput {
  room: RoomInput
  sender: SenderInput
  text: string
  isDm?: boolean
  mention?: boolean
  inlineMention?: boolean
  replyToAgent?: boolean
}

export interface LedgerEntry { nonce: string; id: string; room: string; text: string; turnId?: string; ts: string }

export interface FakeConnector {
  connector: SurfaceConnector
  /** Script one message into the room. Returns its message id. */
  say(input: SayInput): string
  /** Every post the door made. This is `answered`. */
  ledger: LedgerEntry[]
  /** Live facts the door will be given, by principal id. `delayMs` makes the lookup slow; `fail` makes it throw. */
  facts: { rolesOf: Record<string, string[]>; delayMs?: number; fail?: boolean }
}

export function createFakeConnector(opts: { nonce: string }): FakeConnector {
  const listeners: ((e: ConnectorInbound | InviteEvent) => void)[] = []
  const ledger: LedgerEntry[] = []
  const facts: FakeConnector['facts'] = { rolesOf: {} }
  let connected = false

  const connector: SurfaceConnector = {
    id: 'fake',
    async connect(creds) {
      if (creds.token !== `FAKECHAT-${opts.nonce}`) {
        throw new Error('REFUSING: the fake connector only accepts the fake token minted for this run')
      }
      connected = true
    },
    onEvent(cb) { listeners.push(cb) },
    async send(room: RoomRef, msg) {
      if (!connected) throw new Error('fake connector is not connected')
      const entry = { nonce: opts.nonce, id: randomUUID(), room: room.id, text: msg.text, turnId: msg.turnId, ts: new Date().toISOString() }
      ledger.push(entry)
      return { id: entry.id, ts: entry.ts }
    },
    async facts(q): Promise<Facts> {
      if (facts.delayMs) await new Promise((resolve) => setTimeout(resolve, facts.delayMs))
      if (facts.fail) throw new Error('fake connector: the facts lookup failed')
      const id = q.principal?.id
      return id && facts.rolesOf[id] ? { rolesOf: { [id]: facts.rolesOf[id] } } : {}
    },
    async close() { connected = false },
  }

  return {
    connector, ledger, facts,
    say(input) {
      const messageId = randomUUID()
      const event: ConnectorInbound = {
        kind: 'inbound', surface: 'fake', room: toRoom(input.room, input.isDm), sender: toPrincipal(input.sender),
        isDm: input.isDm ?? false, mention: input.mention ?? false, inlineMention: input.inlineMention ?? false,
        replyToAgent: input.replyToAgent ?? false, text: input.text, attachments: [], messageId,
      }
      for (const cb of listeners) cb(event)
      return messageId
    },
  }
}
