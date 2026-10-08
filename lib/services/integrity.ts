/**
 * Fleet-wide SQLite integrity monitoring (#204, PR1).
 *
 * Harness state DBs live on the host (VirtioFS bind mounts) and can be torn
 * by mid-write hard-stops under container-engine VM memory pressure (the
 * motivating incident was Docker Desktop; OrbStack's VM applies too). In the
 * motivating incident a harness's state.db failed writes for 6 days with no
 * surfaced signal. This module provides:
 *
 *   - a readonly `PRAGMA quick_check` per harness, behind a small transport
 *     seam (`runDbPragma`) so PR2 can swap host-path access for docker-exec
 *     once DBs migrate to named volumes;
 *   - an in-memory result cache (restart-tracker style) filled by a
 *     staggered fleet sweep, driven from instrumentation.ts;
 *   - a write-failure signal scanned from the tail of each harness's
 *     host-visible errors.log.
 *
 * better-sqlite3 is synchronous, so a quick_check blocks the event loop for
 * its duration. The sweep therefore checks one harness at a time and yields
 * (setTimeout) between harnesses instead of fanning out.
 *
 * PR2 transport swap (#204): once a harness's DBs migrate to a named Docker
 * volume, the host-side state.db is a dangling symlink — better-sqlite3 can't
 * open it at all. `runDbPragma` now branches on lstat:
 *   - regular file → host-path better-sqlite3, exactly as PR1 (fast, sync;
 *     fine for the unmigrated case where the file IS host-readable);
 *   - symlink → async `docker exec <container> python3` running the PRAGMA
 *     inside the VM, where SQLite's locking assumptions actually hold AND the
 *     event loop is never blocked (matilde's 287MB quick_check blocked the
 *     single pm2 fork ~3.2s on the host path).
 *
 * KNOWN GAP (acknowledged, not unit-testable here — applies to the UNMIGRATED
 * host path only): the host-side readonly reader shares the DB with a WAL-mode
 * writer that lives across a VM/VirtioFS boundary. Live cross-VM WAL
 * contention cannot be reproduced in unit tests. That is why a single non-ok
 * quick_check is never trusted (see corruption hysteresis below). Migrating a
 * harness moves its checks in-VM and retires the gap for that harness.
 */

import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import type { Harness } from '@/lib/types'
import { adapterForRuntime, agentDataDirForName, tailLogFile } from './harness'
import { DockerService } from './docker'

export type DbIntegrityStatus =
  | 'ok'
  | 'no-db'
  | 'busy'
  | 'corrupt'
  // Non-ok quick_check seen once, not yet confirmed by a second sample.
  | 'recheck-pending'
  | 'error'

export type DbIntegrityResult = {
  status: DbIntegrityStatus
  /** quick_check findings / error message when status is not ok (truncated). */
  detail: string | null
  checkedAt: number
  durationMs: number
}

export type FleetIntegrityEntry = DbIntegrityResult & {
  harnessId: string
  name: string
}

export type FleetIntegritySnapshot = {
  lastSweepAt: number | null
  sweepInProgress: boolean
  results: FleetIntegrityEntry[]
}

export type DbWriteFailureSignal = {
  /** Matching WARNING/ERROR/CRITICAL lines in the scanned tail window. */
  count: number
  /** Epoch ms of the earliest/latest matching line, when parseable. */
  firstSeen: number | null
  lastSeen: number | null
  /**
   * True when lastSeen falls inside the alert window (default 24h,
   * DB_WRITE_FAILURE_ALERT_WINDOW_MS overrides). Old matches on an idle
   * agent — or matches with unparseable timestamps — degrade to a warning
   * instead of latching a red badge forever.
   */
  recent: boolean
  bySignature: Record<string, number>
  scannedLines: number
}

// Error-log signatures from the real corruption incident: the agent kept
// running while every DB write failed, and these were the only trace.
export const DB_WRITE_FAILURE_SIGNATURES = [
  'database disk image is malformed',
  'state.db write failed',
  'append_message failed',
] as const

const DEFAULT_SCAN_LINES = 500
const DETAIL_MAX_CHARS = 500

const DEFAULT_WRITE_FAILURE_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

function writeFailureAlertWindowMs(): number {
  const env = parseInt(process.env.DB_WRITE_FAILURE_ALERT_WINDOW_MS ?? '', 10)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_WRITE_FAILURE_ALERT_WINDOW_MS
}

// name-keyed like usage.ts: h_foo_bar → foo-bar → ~/.hermes-foo-bar
function harnessIdToName(harnessId: string): string {
  return harnessId.replace(/^h_/, '').replace(/_/g, '-')
}

function dataDirForHarnessId(harnessId: string): string {
  return agentDataDirForName(harnessIdToName(harnessId))
}

// --- Transport seam (PR2) ---------------------------------------------------

/** What runDbPragma/checkDb operate on: a data dir plus the container that
 * mounts it (needed for the docker-exec path on migrated harnesses). */
export type DbCheckTarget = { dataDir: string; containerName: string }

export type ExecInContainer = (
  container: string,
  argv: string[],
  timeoutMs?: number,
) => Promise<string>

const dockerService = new DockerService()
let execTransport: ExecInContainer = (c, argv, t) => dockerService.execInContainer(c, argv, t)

/** Swap the docker-exec transport. Test hook only. */
export function _setExecTransportForTests(fn: ExecInContainer | null): void {
  execTransport = fn ?? ((c, argv, t) => dockerService.execInContainer(c, argv, t))
}

const EXEC_PRAGMA_TIMEOUT_MS = 30_000

/** pragmaPython's exit code for "no state.db in the container yet" (fresh
 * migrated harness, pre-first-write). Distinct from 3 (SQLite-level error). */
export const EXEC_NO_DB_EXIT_CODE = 4

/** Marker code for the shaped no-db error thrown by the exec transport. */
const NO_DB_CODE = 'HSM_NO_DB'

/**
 * In-container PRAGMA runner: prints one finding per line on stdout, and on a
 * SQLite-level failure prints the error to stderr and exits 3 so the TS side
 * can classify it (busy/corrupt) instead of getting a generic exec error.
 * `sql` is interpolated — it is an internal constant ('quick_check'), never
 * user input.
 */
function pragmaPython(sql: string): string {
  return [
    'import sqlite3, sys, os',
    // Fresh migrated harness: the symlink dangles until the agent's first DB
    // write. Distinct exit code (not 3) so the TS side reports benign 'no-db'
    // instead of a red 'error' badge (sqlite would raise "unable to open").
    'if not os.path.exists("/opt/data/state.db"):',
    `    sys.exit(${EXEC_NO_DB_EXIT_CODE})`,
    'try:',
    '    con = sqlite3.connect("file:/opt/data/state.db?mode=ro", uri=True, timeout=10)',
    '    try:',
    `        rows = con.execute("PRAGMA ${sql}").fetchall()`,
    '    finally:',
    '        con.close()',
    '    for r in rows:',
    '        print(r[0])',
    'except sqlite3.Error as e:',
    '    sys.stderr.write(str(e))',
    '    sys.exit(3)',
  ].join('\n')
}

/** Map a python-sqlite3 error message to a better-sqlite3-shaped code so
 * classifyDbError keeps working across both transports. */
function shapeExecError(err: unknown): Error & { code?: string } {
  const raw = err instanceof Error ? err : new Error(String(err))
  const stderr = String((err as { stderr?: unknown })?.stderr ?? '')
  const msg = (stderr.trim() || raw.message).slice(0, 500)
  const shaped: Error & { code?: string } = new Error(msg)
  const lower = msg.toLowerCase()
  if (lower.includes('database is locked') || lower.includes('database is busy')) {
    shaped.code = 'SQLITE_BUSY'
  } else if (lower.includes('malformed') || lower.includes('not a database')) {
    shaped.code = 'SQLITE_CORRUPT'
  } else if (lower.includes('unable to open database')) {
    shaped.code = 'SQLITE_CANTOPEN'
  }
  return shaped
}

/** True when the exec failure is docker-level (container down), not SQLite-level. */
function isContainerDownError(err: unknown): boolean {
  const msg = `${(err as { message?: unknown })?.message ?? ''} ${(err as { stderr?: unknown })?.stderr ?? ''}`
  return /is not running|no such container|container .* is (?:restarting|paused|dead)/i.test(msg)
}

/**
 * All SQLite access for integrity checks goes through this one function.
 * Transport is picked per-harness by lstat (regeneration-proof — independent
 * of what any compose file claims):
 *   - regular file → host-path better-sqlite3, readonly (unmigrated);
 *   - symlink → async docker exec python3 in the container (migrated).
 */
export async function runDbPragma(target: DbCheckTarget, sql: string): Promise<unknown[]> {
  const dbPath = path.join(target.dataDir, 'state.db')
  let migrated = false
  try {
    migrated = fs.lstatSync(dbPath).isSymbolicLink()
  } catch {
    // Missing file: fall through to the host path so fileMustExist raises the
    // same error PR1 callers/tests expect.
  }

  if (!migrated) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      // Don't fail instantly on a transiently locked DB; a couple of seconds
      // is plenty for WAL readers.
      db.pragma('busy_timeout = 2000')
      const rows = db.pragma(sql)
      return Array.isArray(rows) ? rows : [rows]
    } finally {
      db.close()
    }
  }

  try {
    const stdout = await execTransport(
      target.containerName,
      ['python3', '-c', pragmaPython(sql)],
      EXEC_PRAGMA_TIMEOUT_MS,
    )
    return stdout.split('\n').filter((l) => l.length > 0)
  } catch (err) {
    if ((err as { code?: unknown })?.code === EXEC_NO_DB_EXIT_CODE) {
      // pragmaPython's distinct exit: db missing in-container (fresh migrated
      // harness). Shape it so checkDb can report benign 'no-db', not 'error'.
      const noDb: Error & { code?: string } = new Error('no state.db in container yet')
      noDb.code = NO_DB_CODE
      throw noDb
    }
    if (isContainerDownError(err)) throw err // checkDb reports 'container not running'
    throw shapeExecError(err)
  }
}

/** Map a better-sqlite3 error to an integrity status. Exported for tests. */
export function classifyDbError(err: unknown): 'busy' | 'corrupt' | 'error' {
  const code = String((err as { code?: unknown })?.code ?? '')
  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) return 'busy'
  if (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB')) return 'corrupt'
  return 'error'
}

/**
 * Run a readonly quick_check against the target's state.db.
 * A missing DB is not an error — fresh harnesses simply have no DB yet. The
 * gate is lstat-based: a migrated harness's state.db is a HOST-dangling
 * symlink that existsSync would misreport as no-db (silently disabling
 * integrity monitoring for exactly the harnesses that were migrated to make
 * it trustworthy) — it routes to the docker-exec transport instead.
 *
 * Returns the RAW single-sample verdict; callers must not surface a raw
 * 'corrupt' directly — publish through the corruption-hysteresis gate
 * (applyCheckResult) instead.
 */
export async function checkDb(target: DbCheckTarget): Promise<DbIntegrityResult> {
  const start = Date.now()
  const dbPath = path.join(target.dataDir, 'state.db')
  let st: fs.Stats
  try {
    st = fs.lstatSync(dbPath)
  } catch {
    return { status: 'no-db', detail: null, checkedAt: start, durationMs: 0 }
  }
  try {
    if (st.isSymbolicLink()) {
      // Migrated: the only viable transport is in-container. A stopped
      // container is an explicit 'error' (check impossible), NOT 'no-db' —
      // the DB exists on the volume; we just can't reach it right now.
      try {
        const rows = await runDbPragma(target, 'quick_check')
        return verdictFromRows(rows, start)
      } catch (err) {
        if ((err as { code?: unknown })?.code === NO_DB_CODE) {
          // Dangling symlink, target not created yet (fresh migrated harness,
          // pre-first-write) — benign, same verdict the unmigrated path gives
          // a missing file. NOT an error badge.
          return { status: 'no-db', detail: null, checkedAt: start, durationMs: Date.now() - start }
        }
        if (isContainerDownError(err)) {
          return {
            status: 'error',
            detail: 'container not running — cannot check migrated DB',
            checkedAt: start,
            durationMs: Date.now() - start,
          }
        }
        throw err
      }
    }
    const rows = await runDbPragma(target, 'quick_check')
    return verdictFromRows(rows, start)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      status: classifyDbError(err),
      detail: msg.slice(0, DETAIL_MAX_CHARS),
      checkedAt: start,
      durationMs: Date.now() - start,
    }
  }
}

function verdictFromRows(rows: unknown[], start: number): DbIntegrityResult {
  // quick_check returns a single 'ok' row on a healthy DB, otherwise one row
  // per finding. Host transport yields objects ({quick_check: 'ok'}), the
  // exec transport plain strings — both normalize here.
  const findings = rows.map((r) =>
    r !== null && typeof r === 'object' ? String(Object.values(r)[0]) : String(r),
  )
  const ok = findings.length === 1 && findings[0] === 'ok'
  return {
    status: ok ? 'ok' : 'corrupt',
    detail: ok ? null : findings.join('; ').slice(0, DETAIL_MAX_CHARS),
    checkedAt: start,
    durationMs: Date.now() - start,
  }
}

// --- Write-failure signal ---------------------------------------------------

// Harness logs use Python logging format: `2026-05-16 02:18:50,965 LEVEL ...`.
// A signature only counts on a real WARNING/ERROR/CRITICAL line — bare
// substring hits (traceback frames, recovery chatter merely mentioning the
// strings) don't count.
const LOG_LINE_RE =
  /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(?:[,.](\d{3}))?\s+(ERROR|WARNING|CRITICAL)\b/

const LOG_TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})(?:[,.](\d{3}))?/

/**
 * Parse the leading timestamp of a log line to epoch ms, if present.
 *
 * Caveat (L1): the log timestamp is naive (no zone). Date.parse treats it as
 * HOST-local time, while the container likely logs in UTC — so firstSeen/
 * lastSeen can be skewed by the host's UTC offset. Acceptable for a
 * recency/staleness signal; do not treat these as exact incident timestamps.
 */
export function parseLogLineTimestamp(line: string): number | null {
  const m = LOG_TS_RE.exec(line)
  if (!m) return null
  const base = Date.parse(m[1].replace(' ', 'T'))
  if (Number.isNaN(base)) return null
  return base + (m[2] ? parseInt(m[2], 10) : 0)
}

/** Scan raw log text for DB-write-failure signatures. Pure; exported for tests. */
export function scanLogTextForWriteFailures(
  text: string,
  opts?: { now?: number; alertWindowMs?: number },
): DbWriteFailureSignal {
  const now = opts?.now ?? Date.now()
  const alertWindowMs = opts?.alertWindowMs ?? writeFailureAlertWindowMs()
  const lines = text ? text.split('\n') : []
  const bySignature: Record<string, number> = {}
  let count = 0
  let firstSeen: number | null = null
  let lastSeen: number | null = null

  for (const line of lines) {
    if (!LOG_LINE_RE.test(line)) continue // not a leveled log line
    const lower = line.toLowerCase()
    let matched = false
    for (const sig of DB_WRITE_FAILURE_SIGNATURES) {
      if (lower.includes(sig)) {
        bySignature[sig] = (bySignature[sig] ?? 0) + 1
        matched = true
      }
    }
    if (!matched) continue
    count++
    const ts = parseLogLineTimestamp(line)
    if (ts !== null) {
      if (firstSeen === null || ts < firstSeen) firstSeen = ts
      if (lastSeen === null || ts > lastSeen) lastSeen = ts
    }
  }

  // Unparseable timestamps mean unknown recency — degrade to warn rather
  // than latching a red badge (or hiding the count entirely).
  const recent = count > 0 && lastSeen !== null && now - lastSeen <= alertWindowMs

  return { count, firstSeen, lastSeen, recent, bySignature, scannedLines: lines.length }
}

/**
 * Scan the tail of `<dataDir>/logs/errors.log` for write-failure signatures.
 * When the current file holds fewer than `lines` lines (fresh rotation), the
 * remainder of the window is filled from `errors.log.1`.
 */
export function scanErrorLogForWriteFailures(
  dataDir: string,
  lines = DEFAULT_SCAN_LINES,
): DbWriteFailureSignal {
  const logPath = path.join(dataDir, 'logs', 'errors.log')
  let text = tailLogFile(logPath, lines)
  const got = text ? text.split('\n').length : 0
  if (got < lines) {
    const rotated = tailLogFile(`${logPath}.1`, lines - got)
    if (rotated) text = text ? `${rotated}\n${text}` : rotated
  }
  return scanLogTextForWriteFailures(text)
}

// Log scans are cheap but not free (bounded file read per harness); cache
// briefly so a 5s-polling fleet page doesn't re-read every log on every tick.
const writeFailureCache = new Map<string, { signal: DbWriteFailureSignal; ts: number }>()
const WRITE_FAILURE_TTL_MS = 60_000

export function getWriteFailureSignal(harnessId: string): DbWriteFailureSignal {
  const cached = writeFailureCache.get(harnessId)
  if (cached && Date.now() - cached.ts < WRITE_FAILURE_TTL_MS) return cached.signal
  const signal = scanErrorLogForWriteFailures(dataDirForHarnessId(harnessId))
  writeFailureCache.set(harnessId, { signal, ts: Date.now() })
  return signal
}

// --- Fleet sweep + cache ----------------------------------------------------

export type SweepTarget = { harnessId: string; name: string; dataDir: string; containerName: string }

const SWEEP_STAGGER_MS = 250

// Corruption hysteresis (audit H1): a torn read of a live WAL DB across the
// VirtioFS boundary can present as genuine SQLITE_CORRUPT on a perfectly
// healthy DB — and a false red badge primes an operator to run destructive
// recovery. So a single non-ok quick_check is NEVER surfaced as 'corrupt':
// the first corrupt sample publishes 'recheck-pending' (yellow) and schedules
// a re-check after a short delay; only a second consecutive corrupt sample
// (re-check or next sweep) confirms 'corrupt'. Any non-corrupt sample clears
// the pending state.
const DEFAULT_RECHECK_DELAY_MS = 5 * 60 * 1000 // 5 min — outlast a write burst

function recheckDelayMs(): number {
  const env = parseInt(process.env.INTEGRITY_RECHECK_DELAY_MS ?? '', 10)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_RECHECK_DELAY_MS
}

const integrityCache = new Map<string, FleetIntegrityEntry>()
const unconfirmedCorruption = new Map<string, { detectedAt: number }>()
const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
let lastSweepAt: number | null = null
let sweepInProgress = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build a sweep target from a harness id/name pair. containerName feeds the
 * docker-exec transport for migrated harnesses (container == service name for
 * hermes; the personal quirk applies only to the data dir).
 */
export function sweepTargetFor(harnessId: string, name: string, runtime?: Harness['runtime']): SweepTarget {
  return {
    harnessId,
    name,
    dataDir: agentDataDirForName(name),
    containerName: adapterForRuntime(runtime).serviceName(name),
  }
}

/** Publish a raw check result through the corruption-hysteresis gate. */
function applyCheckResult(t: SweepTarget, result: DbIntegrityResult, delayMs: number): void {
  if (result.status !== 'corrupt') {
    unconfirmedCorruption.delete(t.harnessId)
    integrityCache.set(t.harnessId, { harnessId: t.harnessId, name: t.name, ...result })
    return
  }
  if (unconfirmedCorruption.has(t.harnessId)) {
    // Second consecutive corrupt sample → confirmed.
    integrityCache.set(t.harnessId, { harnessId: t.harnessId, name: t.name, ...result })
    return
  }
  unconfirmedCorruption.set(t.harnessId, { detectedAt: Date.now() })
  integrityCache.set(t.harnessId, {
    harnessId: t.harnessId,
    name: t.name,
    ...result,
    status: 'recheck-pending',
  })
  scheduleCorruptionRecheck(t, delayMs)
}

function scheduleCorruptionRecheck(t: SweepTarget, delayMs: number): void {
  if (recheckTimers.has(t.harnessId)) return
  const timer = setTimeout(() => {
    recheckTimers.delete(t.harnessId)
    void (async () => {
      try {
        if (!unconfirmedCorruption.has(t.harnessId)) return // cleared meanwhile
        applyCheckResult(t, await checkDb(t), delayMs)
      } catch (err) {
        console.error('[integrity] corruption re-check failed:', err)
      }
    })()
  }, delayMs)
  timer.unref?.()
  recheckTimers.set(t.harnessId, timer)
}

/**
 * Check every target sequentially (one DB at a time — quick_check is
 * synchronous) with a short yield between harnesses, and cache results.
 * Re-entrant calls while a sweep is running return the current snapshot.
 */
export async function runFleetIntegritySweep(
  targets: SweepTarget[],
  staggerMs = SWEEP_STAGGER_MS,
  corruptionRecheckDelayMs = recheckDelayMs(),
): Promise<FleetIntegritySnapshot> {
  if (sweepInProgress) return getFleetIntegritySnapshot()
  sweepInProgress = true
  try {
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]
      applyCheckResult(t, await checkDb(t), corruptionRecheckDelayMs)
      if (staggerMs > 0 && i < targets.length - 1) await sleep(staggerMs)
    }
    // Drop entries for harnesses that no longer exist.
    const ids = new Set(targets.map((t) => t.harnessId))
    for (const key of integrityCache.keys()) {
      if (!ids.has(key)) integrityCache.delete(key)
    }
    for (const key of unconfirmedCorruption.keys()) {
      if (!ids.has(key)) unconfirmedCorruption.delete(key)
    }
    lastSweepAt = Date.now()
  } finally {
    sweepInProgress = false
  }
  return getFleetIntegritySnapshot()
}

export function getIntegrityForHarness(harnessId: string): FleetIntegrityEntry | null {
  return integrityCache.get(harnessId) ?? null
}

export function getFleetIntegritySnapshot(): FleetIntegritySnapshot {
  return {
    lastSweepAt,
    sweepInProgress,
    results: Array.from(integrityCache.values()),
  }
}

/** Reset all module state. Test hook only. */
export function _resetIntegrityStateForTests(): void {
  _setExecTransportForTests(null)
  integrityCache.clear()
  writeFailureCache.clear()
  unconfirmedCorruption.clear()
  for (const timer of recheckTimers.values()) clearTimeout(timer)
  recheckTimers.clear()
  lastSweepAt = null
  sweepInProgress = false
}
