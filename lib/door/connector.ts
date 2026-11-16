// A surface connector translates one chat platform to and from events. It
// makes no decisions: who is heard and what is posted belongs to the door.
import type { Facts, InboundEvent, Principal, RoomRef } from '../core/events.ts'
import type { SurfaceId } from '../core/policy/types.ts'

export interface SurfaceCreds { token: string }
/** `replyTo` is the id of the message this one was written as a reply to, where the surface says. */
export type ConnectorInbound = InboundEvent & { messageId: string; replyTo?: string }
/** Someone put a reaction on a message. `sender` is who the surface says did. It carries no text. */
export interface ReactionEvent { kind: 'reaction'; surface: SurfaceId; room: string; messageId: string; sender: Principal; emoji: string }
export interface InviteEvent { kind: 'invite'; surface: SurfaceId; room: RoomRef; inviter: Principal }
/**
 * Something happened to a message the connector already passed on: it was
 * edited or deleted. It carries ids only. What follows from it is the door's call.
 */
export interface NoticeEvent { kind: 'notice'; what: 'edit' | 'delete'; surface: SurfaceId; room: string; messageId: string }
/** `inReplyTo` is the id of the message being answered, for a surface that can show a reply under it. */
export interface OutboundMessage { text: string; turnId?: string; inReplyTo?: string }
export interface SendReceipt { id: string; ts: string }

export type ConnectorEvent = ConnectorInbound | InviteEvent | NoticeEvent | ReactionEvent

export interface SurfaceConnector {
  id: SurfaceId
  connect(creds: SurfaceCreds): Promise<void>
  onEvent(cb: (e: ConnectorEvent) => void): void
  send(room: RoomRef, msg: OutboundMessage): Promise<SendReceipt>
  facts(q: { principal?: Principal; room?: RoomRef }): Promise<Facts>
  close(): Promise<void>
}
