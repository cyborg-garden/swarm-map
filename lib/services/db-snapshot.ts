/**
 * Periodic state.db snapshot export for named-volume-migrated harnesses
 * (#204 PR2).
 *
 * Once a harness's SQLite DBs live on a named Docker volume, the host cannot
 * read them directly (the bind-mount path is a dangling symlink). This module
 * exports a consistent copy — `state.db.snapshot` — into /opt/data via
 * `docker exec` + Python's sqlite3 backup API, which the host CAN see through
 * the bind mount. usage.ts reads it via resolveStateDbPath.
 *
 * Transport notes:
 *   - python3 is guaranteed in the agent image; the sqlite3 CLI is NOT.
 *   - The backup API takes a consistent copy under a live WAL writer.
 *   - tmp + os.replace happen on the SAME filesystem (the bind mount), so the
 *     host never observes a torn snapshot file.
 *   - Only state.db is exported: exhaustive grep found zero host readers of
 *     response_store.db / kanban.db.
 *
 * Failure posture mirrors the integrity sweep: per-harness failures are logged
 * and reported, never thrown — a down container or a locked DB must not kill
 * the scheduler.
 */

import { services } from '@/lib/services'
import { DockerService } from './docker'
import { adapterForRuntime, agentDataDirForName } from './harness'
import { isStateDbMigrated } from './db-path'

export type SnapshotTarget = {
  harnessId: string
  name: string
  dataDir: string
  containerName: string
}

export type DbSnapshotResult = {
  harnessId: string
  name: string
  status: 'ok' | 'skipped' | 'error'
  /** Why it was skipped / what failed. */
  detail: string | null
  durationMs: number
}

/**
 * In-container export program. /opt/data/state.db is the symlink the init
 * service left behind — in-container it resolves to the named volume. Exits 0
 * quietly when the DB doesn't exist yet (fresh migrated harness whose first
 * write hasn't happened). The SNAPSHOT_DB env override exists ONLY so tests
 * can run the real program against a temp DB; in-container it is never set.
 */
export const SNAPSHOT_PYTHON = [
  'import sqlite3, os, sys',
  'p = os.environ.get("SNAPSHOT_DB", "/opt/data/state.db")',
  'if not os.path.exists(p):',
  // Sentinel so the sweep can report 'skipped' (no db yet) instead of a
  // success indistinguishable from a real export.
  '    print("no-db")',
  '    sys.exit(0)',
  't = p + ".snapshot.tmp"',
  // Self-heal: a previous export that died mid-write leaves a torn tmp with an
  // invalid SQLite header; connect()+backup() against it fails forever
  // ("file is not a database"), permanently wedging the snapshot pipeline.
  // Unconditionally sweep it away so every cycle starts from a fresh tmp.
  'if os.path.exists(t):',
  '    os.remove(t)',
  'src = sqlite3.connect("file:" + p + "?mode=ro", uri=True, timeout=10)',
  'dst = sqlite3.connect(t)',
  'src.backup(dst)',
  'dst.close()',
  'src.close()',
  'os.replace(t, p + ".snapshot")',
].join('\n')

/** Generous ceiling: a multi-hundred-MB backup is seconds, not minutes. */
const EXEC_TIMEOUT_MS = 120_000
const SWEEP_STAGGER_MS = 250

export type ExecInContainer = (
  container: string,
  argv: string[],
  timeoutMs?: number,
) => Promise<string>

const defaultDocker = new DockerService()
const defaultExec: ExecInContainer = (c, argv, t) => defaultDocker.execInContainer(c, argv, t)

/** Current container harnesses as snapshot candidates. */
export function snapshotTargets(): SnapshotTarget[] {
  return services.harness
    .list()
    .map((h) => ({
      harnessId: h.id,
      name: h.name,
      dataDir: agentDataDirForName(h.name),
      // Container name == service name for hermes ('hermes-<name>'); the
      // personal quirk applies only to the DATA DIR, not the container name.
      containerName: adapterForRuntime(h.runtime).serviceName(h.name),
    }))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Re-entrancy guard (mirrors runFleetIntegritySweep's sweepInProgress): with
// several hung containers at the 120s exec timeout a sweep can outlast the
// scheduler interval — without this, two concurrent sweeps would run
// overlapping backups into the SAME .snapshot.tmp in one container.
let sweepInProgress = false

/**
 * Export a snapshot for every MIGRATED harness (host state.db is a symlink —
 * regeneration-proof detection, independent of what any compose file claims).
 * Unmigrated harnesses are skipped: their state.db is host-readable directly.
 * Re-entrant calls while a sweep is running return [] (the running sweep owns
 * this cycle).
 */
export async function runDbSnapshotSweep(
  targets: SnapshotTarget[] = snapshotTargets(),
  exec: ExecInContainer = defaultExec,
  staggerMs = SWEEP_STAGGER_MS,
): Promise<DbSnapshotResult[]> {
  if (sweepInProgress) return []
  sweepInProgress = true
  try {
    return await runDbSnapshotSweepInner(targets, exec, staggerMs)
  } finally {
    sweepInProgress = false
  }
}

async function runDbSnapshotSweepInner(
  targets: SnapshotTarget[],
  exec: ExecInContainer,
  staggerMs: number,
): Promise<DbSnapshotResult[]> {
  const results: DbSnapshotResult[] = []
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i]
    const start = Date.now()
    if (!isStateDbMigrated(t.dataDir)) {
      results.push({ harnessId: t.harnessId, name: t.name, status: 'skipped', detail: 'not migrated', durationMs: 0 })
      continue
    }
    try {
      const stdout = await exec(t.containerName, ['python3', '-c', SNAPSHOT_PYTHON], EXEC_TIMEOUT_MS)
      if (stdout.trim() === 'no-db') {
        // In-container db missing: fresh harness pre-first-write, or the
        // /state mount was rolled back leaving a dangling symlink. Either way
        // nothing was exported — don't report an 'ok' that lets the snapshot
        // age silently.
        results.push({ harnessId: t.harnessId, name: t.name, status: 'skipped', detail: 'no db in container yet', durationMs: Date.now() - start })
      } else {
        results.push({ harnessId: t.harnessId, name: t.name, status: 'ok', detail: null, durationMs: Date.now() - start })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Logged, never thrown: one down container must not starve the rest of
      // the fleet of snapshots.
      console.error(`[db-snapshot] export failed for ${t.name}:`, msg)
      results.push({
        harnessId: t.harnessId,
        name: t.name,
        status: 'error',
        detail: msg.slice(0, 500),
        durationMs: Date.now() - start,
      })
    }
    if (staggerMs > 0 && i < targets.length - 1) await sleep(staggerMs)
  }
  return results
}
