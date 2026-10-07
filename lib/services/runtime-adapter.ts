/**
 * ContainerRuntimeAdapter — the container-runtime seam.
 *
 * Design: memory/specs/2026-07-18-letta-wizard-fork-design.md §1b.
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
 * NOTE: Letta agents do NOT go through this adapter. They are not containers;
 * they are enumerated from the Letta server over REST by the separate
 * AgentResourceProvider (lib/services/letta-agent-provider.ts). This interface
 * is exclusively the *container* seam.
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
