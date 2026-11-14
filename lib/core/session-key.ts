// The session a message belongs to. Derived from the event by trusted code,
// never from anything the model or a sender wrote. A DM never shares a key
// with a room, and a thread pools into its parent room.
import type { RoomRef } from './events.ts'
import type { SurfaceId } from './policy/types.ts'

export function sessionKeyFor(surface: SurfaceId, room: RoomRef, senderId: string, isDm: boolean): string {
  if (isDm) return `${surface}:dm:${senderId}`
  const roomId = room.kind === 'thread' ? (room.parentId ?? room.id) : room.id
  return `${surface}:room:${roomId}`
}
