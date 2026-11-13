import { Storage } from './storage'
import fs from 'fs'
import { DATA_DIR, agentHomeForName, existingAgentHomeNames } from './data-dir'
import { UnsupportedRuntimeError, canonicalHarnessId, findUnmanagedRow, harnessNameOfId } from './runtime-adapter'

/**
 * From an id or an agent name to its Hermes home (`~/.hermes-<name>`).
 *
 * This is the one way in for code that was HANDED the id: from a URL, a
 * request body, a stored key assignment, a list of names. A stored row with a
 * retired or unknown runtime is not a Hermes agent, yet its id maps to a
 * Hermes path all the same, and that path may be a real agent's. So the
 * mapping asks first, and refuses.
 *
 * Code that got the name from HarnessService.list() or get() already has
 * the answer (those leave unmanaged rows out) and may use agentHomeForName()
 * directly. lib/__tests__/agent-home-guards.test.ts holds the list of files
 * allowed to, and fails when a new private copy of the mapping appears.
 */

/** As much of a harnesses.json row as the check needs. */
export type StoredRow = { id?: string; runtime?: string | null }

/** The rows of harnesses.json. No Docker call: cheap enough to ask before every write. */
export function storedHarnessRows(): StoredRow[] {
  const rows = new Storage(DATA_DIR).read<StoredRow[]>('harnesses.json', [])
  return Array.isArray(rows) ? rows : []
}

/**
 * The Hermes home for this ID (or the bare slug an agent sends). Throws when
 * the id does not stand for an agent name (see isAgentName), and UnsupportedRuntimeError when the
 * stored row for it is one Swarm Map does not manage. `rows` is
 * harnesses.json as the caller already holds it; left out, it is read.
 */
export function agentHome(idOrSlug: string, rows: readonly StoredRow[] = storedHarnessRows()): string {
  const name = nameOfId(idOrSlug)
  if (!isAgentName(name)) throw new Error('Invalid harness id')
  const unmanaged = findUnmanagedRow(rows, idOrSlug)
  if (unmanaged) throw new UnsupportedRuntimeError(unmanaged.runtime, unmanaged.reason)
  return agentHomeForName(name)
}

/**
 * The agent name an id came from. Making an id turns '-' into '_', which
 * cannot be undone when the name had a '_' of its own: a container made by
 * hand as `hermes-_x` gets `h__x`, the same id `hermes--x` would. Turning
 * every '_' back into '-' is right for every agent Swarm Map makes, so that
 * form wins whenever its home exists, and when nothing exists yet. Only when
 * it does not exist is the disk asked: if exactly one home has a name that
 * makes this id, that is the agent. Two candidates are not guessed between.
 */
function nameOfId(idOrSlug: string): string {
  const hyphened = harnessNameOfId(idOrSlug)
  if (!idOrSlug.startsWith('h_') || !idOrSlug.slice(2).includes('_')) return hyphened
  if (!isAgentName(hyphened) || fs.existsSync(agentHomeForName(hyphened))) return hyphened
  const id = canonicalHarnessId(hyphened)
  const candidates = existingAgentHomeNames().filter((n) => isAgentName(n) && canonicalHarnessId(n) === id)
  return candidates.length === 1 ? candidates[0] : hyphened
}

/**
 * Is this a name an agent can have? Every lane asks before the name goes
 * into a path. The alphabet is the one Docker allows in a container name:
 * ASCII letters and digits, '_', '.' and '-', up to 128 of them. Agents Swarm Map makes
 * use less (no '_' or '.'), but a container made by hand may use all of it,
 * and discovery gives such an agent the id `h_<that name>`.
 *
 * ASCII only, on purpose. A case-insensitive disk folds more than A-Z: a
 * long s or an "fi" ligature opens the same directory as the plain letters,
 * while the row check, which lower-cases, would see a different name. No
 * slash and no whitespace, so the path stays one directory inside the home.
 */
function isAgentName(name: string): boolean {
  // A name of dots alone is never an agent's, and reads like a path step.
  return /^[A-Za-z0-9_.-]{1,128}$/.test(name) && !/^\.+$/.test(name)
}

/**
 * The same question for the lanes that hold an id OR an agent name (key
 * assignment, and the loops over discovered names), with null in place of
 * the throw so a loop can skip what it may not touch. An `h_` id is turned
 * into its name; a bare name is used as it stands, because a container made
 * by hand can carry an underscore or a dot and its home is
 * `~/.hermes-<that name>`. Null too for anything that is not an agent name.
 */
export function agentHomeIfManaged(idOrName: string, rows: readonly StoredRow[] = storedHarnessRows()): string | null {
  const name = idOrName.startsWith('h_') ? nameOfId(idOrName) : idOrName
  if (!isAgentName(name)) return null
  return findUnmanagedRow(rows, idOrName) ? null : agentHomeForName(name)
}

/**
 * The home of the agent that is asking about ITSELF. A running Hermes agent
 * calls a few policy endpoints with its own slug ("is this group allowed",
 * "is this user my admin"). Those are answered from its own .env whatever
 * row is stored under its id: the caller is a Hermes agent, the row is not
 * consulted, and nothing is written. Read-only callers only. The guard test
 * lists the files that may use this.
 */
export function agentHomeForSelfRead(idOrSlug: string): string {
  const name = nameOfId(idOrSlug)
  if (!isAgentName(name)) throw new Error('Invalid harness id')
  return agentHomeForName(name)
}
