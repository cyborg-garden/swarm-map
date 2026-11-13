import { Storage } from './storage'
import { DATA_DIR } from './data-dir'
import { diskIo, resolveAgentHome, type HomeIo } from './home-resolver'
import { UnsupportedRuntimeError, findUnmanagedRow } from './runtime-adapter'

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
 * The Hermes home for this id, slug or agent name. Throws when it means no
 * home at all (not an agent name, or an alias: see ./home-resolver), and
 * UnsupportedRuntimeError when the stored row for that directory is one
 * Swarm Map does not manage. `rows` is harnesses.json as the caller already
 * holds it; left out, it is read.
 */
export function agentHome(
  idOrSlug: string,
  rows: readonly StoredRow[] = storedHarnessRows(),
  io: HomeIo = diskIo,
): string {
  const agent = resolveAgentHome(idOrSlug, io)
  if (!agent) throw new Error('Invalid harness id')
  const unmanaged = findUnmanagedRow(rows, idOrSlug, io)
  if (unmanaged) throw new UnsupportedRuntimeError(unmanaged.runtime, unmanaged.reason)
  return agent.home
}

/**
 * The same answer with null in place of both throws, for loops over ids or
 * names (key assignment, discovery) that skip what they may not touch.
 */
export function agentHomeIfManaged(
  idOrName: string,
  rows: readonly StoredRow[] = storedHarnessRows(),
  io: HomeIo = diskIo,
): string | null {
  const agent = resolveAgentHome(idOrName, io)
  if (!agent || findUnmanagedRow(rows, idOrName, io)) return null
  return agent.home
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
  const agent = resolveAgentHome(idOrSlug)
  if (!agent) throw new Error('Invalid harness id')
  return agent.home
}
