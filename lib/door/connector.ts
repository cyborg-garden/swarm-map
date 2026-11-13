// A surface connector translates one chat platform to and from events. It
// makes no decisions: who is heard and what is posted belongs to the door.
import type { Facts, InboundEvent, Principal, RoomRef } from '../core/events.ts'
import type { SurfaceId } from '../core/policy/types.ts'

export interface SurfaceCreds { token: string }
export type ConnectorInbound = InboundEvent & { messageId: string }
export interface InviteEvent { kind: 'invite'; surface: SurfaceId; room: RoomRef; inviter: Principal }
export interface OutboundMessage { text: string; turnId?: string }
export interface SendReceipt { id: string; ts: string }

export interface SurfaceConnector {
  id: SurfaceId
  connect(creds: SurfaceCreds): Promise<void>
  onEvent(cb: (e: ConnectorInbound | InviteEvent) => void): void
  send(room: RoomRef, msg: OutboundMessage): Promise<SendReceipt>
  facts(q: { principal?: Principal; room?: RoomRef }): Promise<Facts>
  close(): Promise<void>
}
