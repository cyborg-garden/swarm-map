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
 * reached the file was the surface-admins write, which stores `{ id,
 * surfaceAdmins }` with no tag. So a leftover row is recognised by its id.
 *
 * The agent form keeps the hyphens of `agent-<uuid>`. An id derived from a
 * Hermes agent name has its hyphens turned into underscores, so the two
 * cannot collide. The server id can equal that of a Hermes agent named
 * `letta-server`, which is why the id only counts on a row with no tag: see
 * retiredRuntimeOfRow.
 */
const RETIRED_ID_RUNTIME: ReadonlyArray<[RegExp, string]> = [
  [/^h_letta_agent-/, 'letta'],
  [/^h_letta_server$/, 'letta-server'],
]

/**
 * The retired runtime a stored row belongs to, or null. A stored tag always
 * wins. Only a row with no tag is judged by its id.
 */
export function retiredRuntimeOfRow(row: { id?: string; runtime?: string }): string | null {
  if (row.runtime !== undefined) {
    return Object.hasOwn(RETIRED_RUNTIMES, row.runtime) ? row.runtime : null
  }
  if (!row.id) return null
  for (const [pattern, runtime] of RETIRED_ID_RUNTIME) {
    if (pattern.test(row.id)) return runtime
  }
  return null
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
