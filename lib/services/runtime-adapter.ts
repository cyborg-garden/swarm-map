/**
 * ContainerRuntimeAdapter — the container-runtime seam.
 *
 * HSM's discovery/detail code currently hardcodes Hermes assumptions inline
 * (the `hermes-`/`seraph-` name gate, `~/.hermes*` data dir, the SOUL/model
 * readers). This interface factors those out so `HarnessService.discover()`
 * dispatches on a runtime adapter instead of branching on string prefixes —
 * making room for `claude-code-proxy`/`custom` later.
 *
 * SCOPE (slice A1 / design Phase 2): the full container surface — discovery
 * (slice 1) plus provisioning (`serviceName`, `generateCompose`, `scaffold`)
 * and the CD image-ref rewrite (`readImageRef`/`setImageRef`,
 * `defaultImageRepo`). The Hermes implementation delegates to the same module
 * functions the call sites used inline, so extraction is behavior-preserving.
 *
 * This interface is exclusively the *container* seam. A runtime with no
 * registered adapter is never driven: see RETIRED_RUNTIMES and
 * UnsupportedRuntimeError below.
 */

import type { Harness } from '@/lib/types'
import type { ComposeOptions } from './harness-compose'

export interface ContainerRuntimeAdapter {
  /** The `runtime` value stamped on harnesses this adapter discovers. */
  runtime: Harness['runtime']

  /**
   * Discovery gate: does this live container belong to this runtime? Replaces
   * the inline `containerName.startsWith('hermes-')` test in discover().
   */
  matches(containerName: string): boolean

  /** Where the agent's world lives on disk (SOUL.md, config). */
  dataDir(serviceName: string, containerName: string): string

  /** Short persona/identity string read off the data dir. */
  readPersona(dataDir: string): string

  /** Configured model handles read off the data dir. */
  readModels(dataDir: string): string[]

  // --- Provisioning (Phase 2) ---

  /** Compose service/container name for an agent name (Hermes: `hermes-<name>`). */
  serviceName(name: string): string

  /** Render the standalone compose file for a new agent of this runtime. */
  generateCompose(name: string, port: number, dataDir: string, options?: ComposeOptions): string

  /** Write the scaffold files for a brand-new agent data directory. */
  scaffold(
    dataDir: string,
    name: string,
    port: number,
    opts?: { selection?: { surface: 'private' | 'team' | 'public'; packs: string[] }; searchBackend?: string },
  ): Promise<void>

  // --- CD image-ref rewrite (Phase 2) ---

  /** The image ref the agent service in this compose currently runs, or null if it builds from source. */
  readImageRef(compose: string): string | null

  /** Rewrite the agent service's source block to `image: <ref>`, returning the new compose text. */
  setImageRef(compose: string, ref: string): string

  /** Registry repo the CD path resolves `:latest` against when no pin exists. */
  defaultImageRepo: string
}

/**
 * Runtimes Swarm Map once tagged rows with and no longer drives. A stored row
 * carrying one of these is kept, labelled, and never handed to an adapter.
 * The value is the one-line reason shown to the operator.
 */
export const RETIRED_RUNTIMES: Readonly<Record<string, string>> = {
  letta: 'Retired runtime: the old self-hosted Letta server path was removed. Swarm Map no longer manages this row.',
  'letta-server': 'Retired runtime: the old self-hosted Letta server path was removed. Swarm Map no longer manages this row.',
}

/**
 * Ids the old integration minted. It never wrote a `runtime` field to
 * harnesses.json: its harnesses were built in memory. The one way such an id
 * reached the file was the surface-admins write, which stored `{ id,
 * surfaceAdmins }` and nothing else. So a leftover row is recognised by its
 * id AND by carrying no other field.
 *
 * The agent form keeps the hyphens of `agent-<uuid>`. An id derived from a
 * Hermes agent name has its hyphens turned into underscores, so the two
 * cannot collide. The server id is also the id of a Hermes agent named
 * `letta-server`. Two things keep that agent out of this rule: every row
 * Swarm Map creates for it carries Hermes fields (name, compose file, port)
 * and, since this change, `runtime: 'hermes'`; and the surface-admins write
 * tags a new row for that id (see SurfaceAdminService.setAdmins).
 */
const RETIRED_ID_RUNTIME: ReadonlyArray<[RegExp, string]> = [
  [/^h_letta_agent-/, 'letta'],
  [/^h_letta_server$/, 'letta-server'],
]

/** The only fields a row left by the old integration can carry. */
const LEFTOVER_ROW_FIELDS: ReadonlySet<string> = new Set(['id', 'surfaceAdmins'])

/**
 * The retired runtime a stored row belongs to, or null. A stored tag always
 * wins. A row with no tag is judged by its id only when it has the leftover
 * shape: any other field means Hermes code wrote the row.
 */
export function retiredRuntimeOfRow(row: { id?: string; runtime?: string }): string | null {
  if (row.runtime !== undefined) {
    return Object.hasOwn(RETIRED_RUNTIMES, row.runtime) ? row.runtime : null
  }
  if (!row.id) return null
  for (const [field, value] of Object.entries(row)) {
    if (value !== undefined && !LEFTOVER_ROW_FIELDS.has(field)) return null
  }
  return retiredRuntimeOfId(row.id)
}

/** The retired runtime an id alone points at, or null. Says nothing about a stored row. */
export function retiredRuntimeOfId(id: string): string | null {
  for (const [pattern, runtime] of RETIRED_ID_RUNTIME) {
    if (pattern.test(id)) return runtime
  }
  return null
}

// Runtime tags that have a registered container adapter. Hermes is built in;
// HarnessService adds to this when an adapter is registered. It lives here,
// not beside the adapters, so services that only read harnesses.json
// (surface admins, keys) can ask the question without loading HarnessService.
const drivableRuntimes = new Set<string>(['hermes'])

export function markRuntimeDrivable(runtime: string): void {
  drivableRuntimes.add(runtime)
}

/**
 * Why a stored runtime tag cannot be driven, or null when it can. `undefined`
 * is drivable: rows written before the `runtime` field existed are Hermes.
 * Everything else must have a registered adapter. There is no fallback.
 */
export function unsupportedRuntimeReason(runtime?: string): 'retired' | 'unknown' | null {
  if (runtime === undefined) return null
  if (drivableRuntimes.has(runtime)) return null
  return Object.hasOwn(RETIRED_RUNTIMES, runtime) ? 'retired' : 'unknown'
}

/**
 * Why a stored ROW cannot be driven, or null when it can. This is the check
 * every reader and writer of harnesses.json uses. It is
 * unsupportedRuntimeReason plus one case the tag cannot see: a row with no
 * tag whose id the old integration minted (see retiredRuntimeOfRow).
 * `runtime` is the label to show for it.
 */
export function unsupportedRowReason(
  row: { id?: string; runtime?: string } | undefined,
): { reason: 'retired' | 'unknown'; runtime: string } | null {
  if (!row) return null
  const byTag = unsupportedRuntimeReason(row.runtime)
  if (byTag) return { reason: byTag, runtime: String(row.runtime) }
  const retired = retiredRuntimeOfRow(row)
  return retired ? { reason: 'retired', runtime: retired } : null
}

/**
 * The id harnesses.json stores for what a caller passed. Agents call the
 * policy API with their bare slug ("seraph-doer"); stored ids are
 * "h_seraph_doer".
 */
export function canonicalHarnessId(idOrSlug: string): string {
  return idOrSlug.startsWith('h_') ? idOrSlug : `h_${idOrSlug.replace(/-/g, '_')}`
}

/**
 * The stored row for this id or bare slug, if Swarm Map does not manage it.
 * Every writer that turns an id into `~/.hermes-<name>` asks this first.
 */
export function findUnmanagedRow<T extends { id?: string; runtime?: string }>(
  rows: readonly T[],
  idOrSlug: string,
): { row: T; reason: 'retired' | 'unknown'; runtime: string } | null {
  const id = canonicalHarnessId(idOrSlug)
  const row = rows.find((r) => r.id === id)
  const unsupported = unsupportedRowReason(row)
  return row && unsupported ? { row, ...unsupported } : null
}

/** One sentence for the UI and for a refused request. */
export function unmanagedRowNote(u: { reason: 'retired' | 'unknown'; runtime: string }): string {
  return u.reason === 'retired'
    ? RETIRED_RUNTIMES[u.runtime]
    : `Unknown runtime "${u.runtime}". Swarm Map does not manage this row.`
}

/**
 * Thrown instead of quietly treating a row as Hermes. `reason` is 'retired'
 * for a tag in RETIRED_RUNTIMES and 'unknown' for anything else that has no
 * registered adapter.
 */
export class UnsupportedRuntimeError extends Error {
  constructor(
    readonly runtime: string,
    readonly reason: 'retired' | 'unknown',
  ) {
    super(
      reason === 'retired'
        ? `Runtime "${runtime}" is retired. Swarm Map no longer manages it and will not treat it as Hermes.`
        : `Unknown runtime "${runtime}": no adapter is registered for it, and Swarm Map will not treat it as Hermes.`,
    )
    this.name = 'UnsupportedRuntimeError'
  }
}

/** A stored row Swarm Map keeps but does not manage. See HarnessService.listRetired(). */
export interface RetiredHarnessRow {
  id: string
  name: string
  /** The tag as stored. For a row with no tag, the retired runtime its id marks. */
  runtime: string
  reason: 'retired' | 'unknown'
  /** One plain sentence for the UI. */
  note: string
}
