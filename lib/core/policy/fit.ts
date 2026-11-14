// Does a policy fit the harness it is for? A policy can be valid on its own
// and still ask for something one harness cannot keep. Those cases are
// checked here, from what the harness declares about itself, by the control
// plane before a save and by the door before it delivers.
//
// One case exists so far. A harness whose own memory is always on belongs to
// the whole agent: what it learns in one conversation it knows in the next.
// Nothing outside it can split that memory by room. So such a harness is
// given one conversation, and a policy that opens more is refused for it.
import type { PolicyRecord } from './types.ts'

/** The one thing this file reads from a harness's capabilities. */
export interface MemoryShape { nativeMemory: 'none' | 'off-able' | 'always-on' }

/**
 * How many separate conversations a policy can open, counted the way the door
 * keys a session: one per listed room (a thread pools into its room), one per
 * person who may send a direct message. 'many' when there is no telling: a
 * category of rooms, a role, or direct messages open to anyone.
 */
export function sessionsOpened(policy: PolicyRecord): number | 'many' {
  let total = 0
  for (const surface of Object.values(policy.surfaces)) {
    if (!surface || !surface.enabled) continue
    const rooms = new Set<string>()
    for (const rule of surface.rooms) {
      if (rule.mode === 'ignore') continue
      if (!('room' in rule.match)) return 'many'
      rooms.add(rule.match.room)
    }
    total += rooms.size
    if (surface.dm.mode === 'closed') continue
    if (surface.dm.mode !== 'allowlist' || surface.dm.users.some((u) => u.kind !== 'user')) return 'many'
    total += new Set(surface.dm.users.map((u) => u.id)).size
  }
  return total
}

/** Why this policy cannot be given to a harness with these capabilities. Empty means it fits. */
export function fitProblems(policy: PolicyRecord, caps: MemoryShape): string[] {
  // Anything but a plain "none" or "can be turned off" is read as one memory for the whole agent.
  if (caps.nativeMemory === 'none' || caps.nativeMemory === 'off-able') return []
  const opened = sessionsOpened(policy)
  if (opened !== 'many' && opened <= 1) return []
  return [`mem.one-scope: this harness keeps one memory for the whole agent, so it may be given one room, or one person's direct messages, and no more. This policy opens ${opened === 'many' ? 'more than can be counted' : opened}.`]
}
