// Shorthand for writing events by hand in scenarios and scripted rooms.
import type { Principal, RoomRef } from './events.ts'

export type RoomInput = string | RoomRef
export type SenderInput = string | (Partial<Principal> & { id: string })

export function toRoom(room: RoomInput, isDm = false): RoomRef {
  return typeof room === 'string' ? { id: room, kind: isDm ? 'dm' : 'channel' } : room
}

export function toPrincipal(sender: SenderInput): Principal {
  const p = typeof sender === 'string' ? { id: sender } : sender
  return { display: p.id, isBot: false, isSelf: false, roles: [], ...p }
}
