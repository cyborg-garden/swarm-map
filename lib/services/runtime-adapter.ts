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

// Runtime tags that have a registered container adapter. Hermes is built in;
// HarnessService adds to this when an adapter is registered. It lives here,
// not beside the adapters, so the request gate (proxy.ts) can ask the
// question without loading HarnessService.
const drivableRuntimes = new Set<string>(['hermes'])

export function markRuntimeDrivable(runtime: string): void {
  drivableRuntimes.add(runtime)
}

/**
 * Why a stored runtime tag cannot be driven, or null when it can. A row with
 * no tag is Hermes (rows written before the `runtime` field existed), and so
 * is one whose tag is null. Any other tag must have a registered adapter.
 * There is no fallback, and nothing but the tag is looked at.
 */
export function unsupportedRuntimeReason(runtime?: string | null): 'retired' | 'unknown' | null {
  if (runtime == null) return null
  if (drivableRuntimes.has(runtime)) return null
  return Object.hasOwn(RETIRED_RUNTIMES, runtime) ? 'retired' : 'unknown'
}

/**
 * Why a stored ROW cannot be driven, or null when it can: its tag, and only
 * its tag. `runtime` is the label to show for it.
 */
export function unsupportedRowReason(
  row: { runtime?: string | null } | undefined,
): { reason: 'retired' | 'unknown'; runtime: string } | null {
  const reason = unsupportedRuntimeReason(row?.runtime)
  return reason ? { reason, runtime: String(row?.runtime) } : null
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
 * The stored row with this id (or bare slug), if its runtime tag is one Swarm
 * Map does not know. The request gate in proxy.ts asks this for every write.
 */
export function findUnmanagedRow<T extends { id?: string; runtime?: string | null }>(
  rows: readonly T[],
  idOrSlug: string,
): { row: T; reason: 'retired' | 'unknown'; runtime: string } | null {
  if (!Array.isArray(rows)) return null
  const id = canonicalHarnessId(idOrSlug)
  const row = rows.find((r) => r?.id === id)
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
