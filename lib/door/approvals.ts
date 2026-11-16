// What the door says in the room when a tool call needs an admin's yes, and
// how it reads the answer. docs/lab/tools-slice.md.
//
// The request shows the whole call, written so that nothing in it can hide,
// ping anyone or break out of its block (see showInput). Who may answer is
// not decided here: that is decide(), on the id the surface reported.
import { shortHash } from '../core/tools/call.ts'

export type Answer = 'approve' | 'deny'

/**
 * The longest a request can be: one chat message on every surface the door speaks. A request is
 * a fixed frame around a tool's name (64 characters at most) and a shown call (MAX_SHOWN_CHARS at
 * most), and a test holds the longest one under this. Nothing checks it when a request is made.
 */
export const MAX_REQUEST_CHARS = 1900

/** `tool` is a name from the map the shim declared at hello, so it is a plain name. `shown` is showInput()'s text. */
export function requestText(tool: string, shown: string, hash: string, timeoutMs: number): string {
  return [
    `Approval needed. The agent wants to run ${tool}:`,
    '```', shown, '```',
    `An admin can reply approve or deny, or react ✅ or ❌. No answer in ${Math.round(timeoutMs / 1000)} seconds means no. (call ${shortHash(hash)})`,
  ].join('\n')
}

/** The call a request shows, as its text and the short hash it names. Undefined if the text is not a request. */
export function shownIn(request: string): { shown: string; call: string } | undefined {
  const m = /^Approval needed\. [^\n]*\n```\n([^\n]*)\n```\n[^\n]*\(call ([0-9a-f]{12})\)$/.exec(request)
  return m ? { shown: m[1], call: m[2] } : undefined
}

/** A reply to a request: one word, with or without a mention in front. Anything else is not an answer. */
export function readAnswer(text: string): Answer | undefined {
  const word = text.replace(/^(\s*<@!?\d+>)*\s*/, '').trim().toLowerCase()
  if (word === 'approve' || word === 'yes') return 'approve'
  if (word === 'deny' || word === 'no') return 'deny'
  return undefined
}

/** A reaction on a request. */
export function readReaction(emoji: string): Answer | undefined {
  if (emoji === '✅') return 'approve'
  if (emoji === '❌') return 'deny'
  return undefined
}
