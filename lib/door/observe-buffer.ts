// Lines the agent overheard but was not asked about. They wait here, per
// session, and ride along as context on the next real turn in that session.
// Bounded: the oldest lines fall off.
import type { ObservedLine } from './protocol.ts'

export interface ObserveBuffer {
  add(sessionKey: string, line: ObservedLine): void
  /** Take and clear the lines for one session. */
  drain(sessionKey: string): ObservedLine[]
}

export function createObserveBuffer(limit = 50): ObserveBuffer {
  const lines = new Map<string, ObservedLine[]>()
  return {
    add(sessionKey, line) {
      const kept = [...(lines.get(sessionKey) ?? []), line]
      lines.set(sessionKey, kept.slice(-limit))
    },
    drain(sessionKey) {
      const kept = lines.get(sessionKey) ?? []
      lines.delete(sessionKey)
      return kept
    },
  }
}
