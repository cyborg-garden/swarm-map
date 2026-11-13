import { Storage } from './storage'
import { DATA_DIR, agentHomeForName } from './data-dir'
import { UnsupportedRuntimeError, findUnmanagedRow, harnessNameOfId, isValidHarnessId } from './runtime-adapter'

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
 * the id is not an agent id at all, and UnsupportedRuntimeError when the
 * stored row for it is one Swarm Map does not manage. `rows` is
 * harnesses.json as the caller already holds it; left out, it is read.
 */
export function agentHome(idOrSlug: string, rows: readonly StoredRow[] = storedHarnessRows()): string {
  if (!isValidHarnessId(idOrSlug)) throw new Error('Invalid harness id')
  const unmanaged = findUnmanagedRow(rows, idOrSlug)
  if (unmanaged) throw new UnsupportedRuntimeError(unmanaged.runtime, unmanaged.reason)
  return agentHomeForName(harnessNameOfId(idOrSlug))
}

/** A name that stays inside the home directory when `.hermes-` is put in front of it. */
function isPathSafeName(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' && !/[/\\\0]/.test(name) && !name.includes('..')
}

/**
 * The same question for the lanes that hold an id OR an agent name (key
 * assignment, and the loops over discovered names), with null in place of
 * the throw so a loop can skip what it may not touch. An `h_` id is turned
 * into its name; a bare name is used as it stands, because a container made
 * by hand can carry an underscore or a dot and its home is
 * `~/.hermes-<that name>`. Null too for a name that would leave the home dir.
 */
export function agentHomeIfManaged(idOrName: string, rows: readonly StoredRow[] = storedHarnessRows()): string | null {
  const name = idOrName.startsWith('h_') ? harnessNameOfId(idOrName) : idOrName
  if (!isPathSafeName(name)) return null
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
  if (!isValidHarnessId(idOrSlug)) throw new Error('Invalid harness id')
  return agentHomeForName(harnessNameOfId(idOrSlug))
}
