/**
 * The name of a new door agent: what a typed name becomes, and whether it
 * can be used.
 *
 * One rule, in one place. The create form calls it while the name is typed,
 * and the server calls it again before anything is written. The server's
 * answer is the one that counts: the form only saves a round trip.
 *
 * Plain functions over plain values, so a page can load this file.
 */

/** What a name may be, as one sentence for a form. */
export const DOOR_NAME_RULE = 'Letters, digits, spaces and dashes, 2 to 31 characters'

const TYPED = /^[A-Za-z0-9][A-Za-z0-9 -]*$/
// The launcher's own rule for an agent id (lib/lab/pi-discord/config.ts): the name is also the launcher's agent id.
const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/

/** The agent name and the fleet id a typed name becomes, or why it cannot be one. */
export function doorAgentName(raw: unknown): { name: string; id: string } | { error: string } {
  const typed = typeof raw === 'string' ? raw.trim() : ''
  const name = TYPED.test(typed) ? typed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : ''
  if (!AGENT_ID.test(name)) return { error: `Name: ${DOOR_NAME_RULE[0].toLowerCase()}${DOOR_NAME_RULE.slice(1)}` }
  return { name, id: 'h_' + name.replace(/-/g, '_') }
}

/** Whether one of `agents` already answers to this name or holds the id it would get. */
export function doorNameTaken(named: { name: string; id: string }, agents: ReadonlyArray<{ id?: string; name?: string } | null | undefined>): boolean {
  return agents.some((a) => a?.id === named.id || a?.name === named.name)
}

/** Why a typed name cannot be used for a new door agent, among these agents. Undefined when it can. */
export function doorNameProblem(raw: unknown, agents: ReadonlyArray<{ id?: string; name?: string } | null | undefined>): string | undefined {
  const named = doorAgentName(raw)
  if ('error' in named) return named.error
  return doorNameTaken(named, agents) ? doorNameClash(named.name) : undefined
}

export const doorNameClash = (name: string): string => `An agent named "${name}" already exists`
