/**
 * Analytics service (#206 v1): per-harness and fleet-wide daily series built
 * from what state.db already records — no new collection.
 *
 *   - sessions: source, user_id, model, tokens, tool_call_count, started_at
 *   - messages.tool_calls (assistant rows): JSON array whose
 *     `$.function.name` is the tool name (messages.tool_name is usually NULL)
 *
 * Reads go through resolveStateDbPath like usage.ts: live DB for unmigrated
 * harnesses, `state.db.snapshot` (≤ ~5 min stale) for migrated ones, and a
 * migrated harness with no snapshot yet is PENDING — surfaced as null, never
 * as a zero series. Cost comes from lib/pricing only.
 *
 * Nothing here is wired into HarnessService.discover()/list() (the dashboard
 * polls that every 5s); the routes call this service, which caches per
 * (harnessId, days) for ANALYTICS_CACHE_TTL_MS (default 5 min).
 */
import fs from 'fs'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { lookupPricing, computeCost } from '@/lib/pricing'
import { resolveStateDbPath } from './db-path'

export type CostStatus = 'estimated' | 'partial' | 'unknown'

export type AnalyticsDay = {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  cost: number
  tokens: number
  sessions: number
  toolCalls: number
  byModel: Record<string, { cost: number; tokens: number }>
  bySource: Record<string, number>
}

export type HarnessAnalytics = {
  harnessId: string
  days: AnalyticsDay[]
  topTools: Array<{ name: string; count: number }>
  /** userHash = first 10 hex of sha256(user_id); display_name never leaves the API. */
  topUsers: Array<{ source: string; userHash: string; sessions: number }>
  costStatus: CostStatus
  /** True when read from a snapshot export (migrated harness), ≤ ~5 min stale. */
  stale: boolean
  /** Snapshot file mtime (ms epoch) when stale. */
  snapshotAt?: number
}

export type FleetDay = {
  date: string
  cost: number
  tokens: number
  sessions: number
  toolCalls: number
  byHarness: Record<string, { cost: number; tokens: number; sessions: number }>
  bySource: Record<string, number>
}

export type FleetHarnessTotals = {
  harnessId: string
  name: string
  /** null = pending (migrated, no snapshot yet) — render as "pending", never $0. */
  cost: number | null
  tokens: number | null
  sessions: number | null
  toolCalls: number | null
  costStatus: CostStatus
  stale: boolean
  pending: boolean
}

export type FleetAnalytics = {
  days: FleetDay[]
  harnesses: FleetHarnessTotals[]
  costStatus: CostStatus
  stale: boolean
  pendingCount: number
}

export type AnalyticsTarget = {
  harnessId: string
  name: string
  dataDir: string
}

const TOP_N = 10
const MAX_DAYS = 365
const DEFAULT_TTL_MS = 5 * 60 * 1000

type SessionRow = {
  source: string | null
  user_id: string | null
  model: string | null
  started_at: number
  tool_call_count: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
  reasoning_tokens: number | null
}

export function clampDays(raw: unknown, fallback = 30): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(Math.floor(n), MAX_DAYS)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local-midnight start of the day `daysBack` days before `nowUnix`. */
function startOfLocalDay(nowUnix: number, daysBack: number): Date {
  const d = new Date(nowUnix * 1000)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack)
}

function emptyDays(nowUnix: number, days: number): AnalyticsDay[] {
  const out: AnalyticsDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    out.push({
      date: localDateKey(startOfLocalDay(nowUnix, i)),
      cost: 0, tokens: 0, sessions: 0, toolCalls: 0, byModel: {}, bySource: {},
    })
  }
  return out
}

function emptyHarnessAnalytics(harnessId: string, nowUnix: number, days: number): HarnessAnalytics {
  return { harnessId, days: emptyDays(nowUnix, days), topTools: [], topUsers: [], costStatus: 'estimated', stale: false }
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return cols.some((c) => c.name === column)
  } catch {
    return false
  }
}

function hasTable(db: Database.Database, table: string): boolean {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table)
    return !!row
  } catch {
    return false
  }
}

function hashUser(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 10)
}

function queryAnalytics(
  db: Database.Database,
  harnessId: string,
  nowUnix: number,
  days: number,
): Omit<HarnessAnalytics, 'stale' | 'snapshotAt'> {
  const series = emptyDays(nowUnix, days)
  const byDate = new Map(series.map((d) => [d.date, d]))
  const windowStart = startOfLocalDay(nowUnix, days - 1).getTime() / 1000

  // Older agent DBs may predate some columns; only the token/tool columns we
  // rely on are selected, and each is nullable in practice.
  const toolCol = hasColumn(db, 'sessions', 'tool_call_count') ? 'tool_call_count' : '0 AS tool_call_count'
  const rows = db.prepare(`
    SELECT source, user_id, model, started_at, ${toolCol},
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
    FROM sessions
    WHERE started_at >= ?
  `).all(windowStart) as SessionRow[]

  let hasUnknown = false
  let hasEstimated = false
  const userCounts = new Map<string, { source: string; userHash: string; sessions: number }>()

  for (const row of rows) {
    const day = byDate.get(localDateKey(new Date(row.started_at * 1000)))
    if (!day) continue // clock skew / future-dated row: not in the window

    const model = row.model || 'unknown'
    const pricing = row.model ? lookupPricing(row.model) : null
    const tokensIn = {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read_tokens ?? 0,
      cacheWrite: row.cache_write_tokens ?? 0,
      reasoning: row.reasoning_tokens ?? 0,
    }
    const tokens = tokensIn.input + tokensIn.output + tokensIn.cacheRead + tokensIn.cacheWrite + tokensIn.reasoning
    let cost = 0
    if (pricing) {
      cost = computeCost(tokensIn, pricing)
      hasEstimated = true
    } else {
      hasUnknown = true
    }

    day.sessions += 1
    day.cost += cost
    day.tokens += tokens
    day.toolCalls += row.tool_call_count ?? 0
    const m = day.byModel[model] ?? (day.byModel[model] = { cost: 0, tokens: 0 })
    m.cost += cost
    m.tokens += tokens
    const source = row.source || 'unknown'
    day.bySource[source] = (day.bySource[source] ?? 0) + 1

    if (row.user_id) {
      const key = `${source}\u0000${row.user_id}`
      const u = userCounts.get(key) ?? { source, userHash: hashUser(row.user_id), sessions: 0 }
      u.sessions += 1
      userCounts.set(key, u)
    }
  }

  const topUsers = [...userCounts.values()]
    .sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source) || a.userHash.localeCompare(b.userHash))
    .slice(0, TOP_N)

  let topTools: HarnessAnalytics['topTools'] = []
  if (hasTable(db, 'messages') && hasColumn(db, 'messages', 'tool_calls')) {
    try {
      topTools = (db.prepare(`
        SELECT json_extract(j.value, '$.function.name') AS name, COUNT(*) AS count
        FROM messages m, json_each(m.tool_calls) j
        WHERE m.role = 'assistant'
          AND m.tool_calls IS NOT NULL
          AND json_valid(m.tool_calls)
          AND m.timestamp >= ?
        GROUP BY name
        HAVING name IS NOT NULL
        ORDER BY count DESC, name ASC
        LIMIT ?
      `).all(windowStart, TOP_N) as Array<{ name: string; count: number }>)
    } catch {
      // A DB whose tool_calls column holds non-JSON blobs: tools stay empty
      // rather than failing the whole response.
      topTools = []
    }
  }

  const costStatus: CostStatus =
    hasUnknown && hasEstimated ? 'partial' : hasUnknown ? 'unknown' : 'estimated'

  return { harnessId, days: series, topTools, topUsers, costStatus }
}

/**
 * Pure per-harness computation. Returns null only for "pending" (migrated
 * harness with no readable snapshot) — the number|null contract from usage.ts.
 * A missing state.db is a fresh harness: an all-zero series, not null.
 */
export function computeHarnessAnalytics(
  dataDir: string,
  days: number,
  nowUnix: number = Date.now() / 1000,
  harnessId = '',
): HarnessAnalytics | null {
  const resolved = resolveStateDbPath(dataDir)
  if (resolved.kind === 'none') return emptyHarnessAnalytics(harnessId, nowUnix, days)
  if (resolved.kind === 'migrated-pending') return null

  const stale = resolved.kind === 'snapshot'
  let snapshotAt: number | undefined
  if (stale) {
    try { snapshotAt = fs.statSync(resolved.path).mtimeMs } catch { snapshotAt = undefined }
  }

  try {
    const db = new Database(resolved.path, { readonly: true, fileMustExist: true })
    try {
      const base = queryAnalytics(db, harnessId, nowUnix, days)
      return stale ? { ...base, stale, snapshotAt } : { ...base, stale }
    } finally {
      db.close()
    }
  } catch {
    // Mirrors usage.ts onReadError: a broken LIVE file reads as zero (the
    // integrity sweep watches corruption there); an unreadable SNAPSHOT copy
    // is unknown — data exists, this export is torn.
    return stale ? null : emptyHarnessAnalytics(harnessId, nowUnix, days)
  }
}

type CacheEntry<T> = { at: number; value: T }

export class AnalyticsService {
  private listTargets: () => AnalyticsTarget[]
  private now: () => number
  private ttlMs: number
  private cache = new Map<string, CacheEntry<HarnessAnalytics | null>>()

  constructor(deps: { listTargets: () => AnalyticsTarget[]; now?: () => number; ttlMs?: number }) {
    this.listTargets = deps.listTargets
    this.now = deps.now ?? (() => Date.now() / 1000)
    const envTtl = parseInt(process.env.ANALYTICS_CACHE_TTL_MS ?? '', 10)
    this.ttlMs = deps.ttlMs ?? (Number.isFinite(envTtl) && envTtl >= 0 ? envTtl : DEFAULT_TTL_MS)
  }

  clearCache(): void {
    this.cache.clear()
  }

  private cached(key: string, compute: () => HarnessAnalytics | null): HarnessAnalytics | null {
    const nowMs = this.now() * 1000
    const hit = this.cache.get(key)
    if (hit && nowMs - hit.at < this.ttlMs) return hit.value
    const value = compute()
    this.cache.set(key, { at: nowMs, value })
    return value
  }

  private forTarget(t: AnalyticsTarget, days: number): HarnessAnalytics | null {
    return this.cached(`${t.harnessId}\u0000${days}`, () =>
      computeHarnessAnalytics(t.dataDir, days, this.now(), t.harnessId))
  }

  /** Throws `Error('harness not found: <id>')` for an unknown id; null = pending. */
  getHarnessAnalytics(harnessId: string, days = 30): HarnessAnalytics | null {
    const key = `${harnessId}\u0000${days}`
    const nowMs = this.now() * 1000
    const hit = this.cache.get(key)
    if (hit && nowMs - hit.at < this.ttlMs) return hit.value
    const target = this.listTargets().find((t) => t.harnessId === harnessId)
    if (!target) throw new Error(`harness not found: ${harnessId}`)
    return this.forTarget(target, days)
  }

  getFleetAnalytics(days = 30): FleetAnalytics {
    const targets = this.listTargets()
    const nowUnix = this.now()
    const series: FleetDay[] = emptyDays(nowUnix, days).map((d) => ({
      date: d.date, cost: 0, tokens: 0, sessions: 0, toolCalls: 0, byHarness: {}, bySource: {},
    }))
    const byDate = new Map(series.map((d) => [d.date, d]))

    const harnesses: FleetHarnessTotals[] = []
    let anyStale = false
    let hasUnknown = false
    let hasEstimated = false
    let pendingCount = 0

    for (const t of targets) {
      const r = this.forTarget(t, days)
      if (!r) {
        pendingCount++
        harnesses.push({
          harnessId: t.harnessId, name: t.name,
          cost: null, tokens: null, sessions: null, toolCalls: null,
          costStatus: 'unknown', stale: false, pending: true,
        })
        continue
      }
      anyStale ||= r.stale
      if (r.costStatus === 'estimated') hasEstimated = true
      else if (r.costStatus === 'unknown') hasUnknown = true
      else { hasEstimated = true; hasUnknown = true }

      const totals = { cost: 0, tokens: 0, sessions: 0, toolCalls: 0 }
      for (const d of r.days) {
        const fd = byDate.get(d.date)
        if (!fd) continue
        fd.cost += d.cost
        fd.tokens += d.tokens
        fd.sessions += d.sessions
        fd.toolCalls += d.toolCalls
        if (d.sessions > 0) fd.byHarness[t.name] = { cost: d.cost, tokens: d.tokens, sessions: d.sessions }
        for (const [src, n] of Object.entries(d.bySource)) fd.bySource[src] = (fd.bySource[src] ?? 0) + n
        totals.cost += d.cost
        totals.tokens += d.tokens
        totals.sessions += d.sessions
        totals.toolCalls += d.toolCalls
      }
      harnesses.push({
        harnessId: t.harnessId, name: t.name, ...totals,
        costStatus: r.costStatus, stale: r.stale, pending: false,
      })
    }

    const costStatus: CostStatus =
      hasUnknown && hasEstimated ? 'partial' : hasUnknown ? 'unknown' : 'estimated'

    return { days: series, harnesses, costStatus, stale: anyStale, pendingCount }
  }
}
