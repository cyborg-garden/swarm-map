import { Storage } from './storage'
import { DATA_DIR, agentHomeForName } from './data-dir'
import { UnsupportedRuntimeError, findUnmanagedRow, harnessNameOfId } from './runtime-adapter'

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
export type StoredRow = { id?: string; runtime?: string }

/** The rows of harnesses.json. No Docker call: cheap enough to ask before every write. */
export function storedHarnessRows(): StoredRow[] {
  const rows = new Storage(DATA_DIR).read<StoredRow[]>('harnesses.json', [])
  return Array.isArray(rows) ? rows : []
}

/**
 * The Hermes home for this id or agent name. Throws UnsupportedRuntimeError
 * when the stored row for it is one Swarm Map does not manage. `rows` is
 * harnesses.json as the caller already holds it; left out, it is read.
 */
export function agentHome(idOrName: string, rows: readonly StoredRow[] = storedHarnessRows()): string {
  const unmanaged = findUnmanagedRow(rows, idOrName)
  if (unmanaged) throw new UnsupportedRuntimeError(unmanaged.runtime, unmanaged.reason)
  return agentHomeForName(harnessNameOfId(idOrName))
}

/** agentHome(), with null in place of the throw. For loops that skip what they may not touch. */
export function agentHomeIfManaged(idOrName: string, rows: readonly StoredRow[] = storedHarnessRows()): string | null {
  return findUnmanagedRow(rows, idOrName) ? null : agentHomeForName(harnessNameOfId(idOrName))
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
  return agentHomeForName(harnessNameOfId(idOrSlug))
}
