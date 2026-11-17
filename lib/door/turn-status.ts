// A sign in the room that the agent is working on a message: 👀 on it and the
// typing indicator while its turn runs, then ✅ once the reply is posted, or ⚠️
// when the turn ends with none. The door starts one for a message it has
// delivered to the harness, and for no other, so nothing is ever shown on
// chatter the agent did not hear.
//
// It is a courtesy, never part of the turn. Nothing here is awaited by the
// door: a call that is slow, rate limited or refused is reported once and the
// turn goes on as if it had never been made.
import type { RoomRef } from '../core/events.ts'
import type { SurfaceConnector } from './connector.ts'

export const STATUS_EMOJI = {
  working: '👀',
  done: '✅',
  // ⚠️ and not ❌: the turn did not fail because the person asked for something wrong, and ❌ is
  // also how an admin says no to a request. The door's line in the room says what went wrong.
  failed: '⚠️',
} as const

export interface StatusOptions {
  /** 👀, then ✅ or ⚠️, on the message being handled. */
  reactions: boolean
  /** The typing indicator while the turn runs. */
  typing: boolean
  /** How often typing is sent again. Discord shows it for about ten seconds. Default 8 s. */
  typingEveryMs?: number
}

/** How a turn ended: answered, not answered, or gone (the message was deleted, or the door is closing). */
export type StatusEnd = 'done' | 'failed' | 'gone'

export interface TurnStatus {
  /** The agent has finished: typing stops now, before the reply is posted, so it cannot outlast the reply. */
  quiet(): void
  /** The turn is over. Typing stops, if it has not, and the reaction says how it ended. */
  end(how: StatusEnd): void
}

export function startTurnStatus(o: StatusOptions & {
  connector: SurfaceConnector
  room: RoomRef
  messageId: string
  /** True while the turn waits on a person (an admin's yes): typing is not sent then. */
  paused: () => boolean
  /** A call failed. Called at most once per kind for one turn. */
  failed: (what: 'reaction' | 'typing', err: unknown) => void
}): TurnStatus {
  const { connector, room, messageId } = o
  const react = o.reactions && connector.react ? connector.react.bind(connector) : undefined
  const type = o.typing && connector.typing ? connector.typing.bind(connector) : undefined
  const told = new Set<'reaction' | 'typing'>()
  const fail = (what: 'reaction' | 'typing') => (err: unknown): void => {
    if (told.has(what)) return
    told.add(what)
    // Reporting it must not fail either: a rejection nobody handles would take the door down.
    try { o.failed(what, err) } catch { /* the call is given up on all the same */ }
  }
  // Reactions go one after another, so ✅ never lands before the 👀 it replaces.
  let chain: Promise<void> = Promise.resolve()
  const queue = (emoji: string, on: boolean): void => {
    if (!react) return
    chain = chain.then(() => react(room, messageId, emoji, on)).catch(fail('reaction'))
  }

  let ended = false
  let sending = false
  const tick = (): void => {
    if (sending || !type || o.paused()) return
    sending = true
    type(room).catch(fail('typing')).finally(() => { sending = false })
  }
  const timer = type ? setInterval(tick, o.typingEveryMs ?? 8000) : undefined
  // Not what keeps a process alive: the turn's own clock does that.
  timer?.unref?.()

  queue(STATUS_EMOJI.working, true)
  tick()

  const hush = (): void => { if (timer) clearInterval(timer) }
  return {
    quiet: hush,
    end(how) {
      if (ended) return
      ended = true
      hush()
      if (how === 'gone') return
      // The new one first, then 👀 off: if the second call fails, the room still sees how it ended.
      queue(how === 'done' ? STATUS_EMOJI.done : STATUS_EMOJI.failed, true)
      queue(STATUS_EMOJI.working, false)
    },
  }
}

/** A failed call, as a code a receipt may hold: the status, or what kind of failure. Never the error's text. */
export function statusCode(err: unknown): string {
  const text = err instanceof Error ? err.message : ''
  if (/rate limited/.test(text)) return 'rate-limited'
  const status = /status (\d{3})/.exec(text)
  if (status) return status[1]
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout'
  return 'error'
}
