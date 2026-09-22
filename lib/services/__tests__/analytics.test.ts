/**
 * Tests for the analytics service (#206 v1).
 *
 * Reads only what state.db already records: sessions (source, user_id, model,
 * tokens, tool_call_count) and assistant messages' tool_calls JSON. Every
 * query is exercised against a real sqlite file in a tmpdir — the schema
 * varies across agent builds (older DBs lack api_call_count / display_name and
 * carry NULL model), so the guards are tested against a minimal schema too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { createHash } from 'crypto'
import { computeCost, lookupPricing } from '@/lib/pricing'
import {
  AnalyticsService,
  computeHarnessAnalytics,
  type AnalyticsTarget,
} from '../analytics'

const DAY = 86_400

let tmp: string

function mkDataDir(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createDb(file: string, opts: { minimal?: boolean } = {}): Database.Database {
  const db = new Database(file)
  const extra = opts.minimal ? '' : `,
      api_call_count INTEGER DEFAULT 0,
      display_name TEXT,
      chat_id TEXT,
      chat_type TEXT`
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      user_id TEXT,
      model TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      message_count INTEGER DEFAULT 0,
      tool_call_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0${extra}
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL NOT NULL
    );
  `)
  return db
}

type SessionOpts = {
  id?: string
  source?: string
  userId?: string | null
  model?: string | null
  startedAt: number
  toolCalls?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

function insertSession(db: Database.Database, o: SessionOpts): string {
  const id = o.id ?? `s-${Math.random().toString(36).slice(2)}`
  db.prepare(`
    INSERT INTO sessions (id, source, user_id, model, started_at, tool_call_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, o.source ?? 'cli', o.userId ?? null, o.model === undefined ? 'claude-sonnet-4-6' : o.model,
    o.startedAt, o.toolCalls ?? 0, o.input ?? 0, o.output ?? 0,
    o.cacheRead ?? 0, o.cacheWrite ?? 0, o.reasoning ?? 0,
  )
  return id
}

function insertToolCalls(db: Database.Database, sessionId: string, ts: number, names: string[]) {
  const toolCalls = names.map((name, i) => ({
    id: `call_${i}`, call_id: `call_${i}`, type: 'function',
    function: { name, arguments: '{}' },
  }))
  db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', '', ?, ?)`)
    .run(sessionId, JSON.stringify(toolCalls), ts)
}

/** Local-midnight-anchored "now": 12:00 today, so day boundaries are unambiguous. */
function noonToday(): number {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.getTime() / 1000
}

function localDate(unix: number): string {
  const d = new Date(unix * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hsm-analytics-'))
})

afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
})

describe('computeHarnessAnalytics', () => {
  it('returns a dense day series covering exactly `days` local dates, oldest first', () => {
    const dir = mkDataDir('a')
    createDb(path.join(dir, 'state.db')).close()
    const now = noonToday()
    const r = computeHarnessAnalytics(dir, 7, now)
    expect(r).not.toBeNull()
    expect(r!.days).toHaveLength(7)
    expect(r!.days[6].date).toBe(localDate(now))
    expect(r!.days[0].date).toBe(localDate(now - 6 * DAY))
    for (const d of r!.days) {
      expect(d).toMatchObject({ cost: 0, tokens: 0, sessions: 0, toolCalls: 0, byModel: {}, bySource: {} })
    }
  })

  it('buckets sessions by local day with cost by model and sessions by source', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'))
    const now = noonToday()
    // Today: two sonnet sessions (discord + cli) and one haiku session.
    insertSession(db, { startedAt: now - 60, source: 'discord', model: 'claude-sonnet-4-6', input: 1_000_000, output: 100_000, toolCalls: 3 })
    insertSession(db, { startedAt: now - 30, source: 'cli', model: 'claude-sonnet-4-6', input: 1_000_000, toolCalls: 2 })
    insertSession(db, { startedAt: now - 10, source: 'cli', model: 'claude-haiku-4-5', input: 1_000_000 })
    // Yesterday: one session.
    insertSession(db, { startedAt: now - DAY, source: 'cron', model: 'claude-haiku-4-5', input: 2_000_000, toolCalls: 1 })
    // Outside the 7-day window: must not appear.
    insertSession(db, { startedAt: now - 10 * DAY, source: 'cli', model: 'claude-haiku-4-5', input: 5_000_000 })
    db.close()

    const r = computeHarnessAnalytics(dir, 7, now)!
    const today = r.days[6]
    const yesterday = r.days[5]

    const sonnet = lookupPricing('claude-sonnet-4-6')!
    const haiku = lookupPricing('claude-haiku-4-5')!
    const sonnetCost =
      computeCost({ input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, sonnet) +
      computeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, sonnet)
    const haikuToday = computeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, haiku)

    expect(today.sessions).toBe(3)
    expect(today.toolCalls).toBe(5)
    expect(today.tokens).toBe(3_100_000)
    expect(today.cost).toBeCloseTo(sonnetCost + haikuToday, 6)
    expect(today.byModel['claude-sonnet-4-6'].cost).toBeCloseTo(sonnetCost, 6)
    expect(today.byModel['claude-sonnet-4-6'].tokens).toBe(2_100_000)
    expect(today.byModel['claude-haiku-4-5'].tokens).toBe(1_000_000)
    expect(today.bySource).toEqual({ discord: 1, cli: 2 })

    expect(yesterday.sessions).toBe(1)
    expect(yesterday.bySource).toEqual({ cron: 1 })
    expect(yesterday.tokens).toBe(2_000_000)

    const total = r.days.reduce((s, d) => s + d.sessions, 0)
    expect(total).toBe(4)
    expect(r.costStatus).toBe('estimated')
  })

  it('buckets NULL model as "unknown" and reports partial cost status', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'))
    const now = noonToday()
    insertSession(db, { startedAt: now - 60, model: null, input: 1000 })
    insertSession(db, { startedAt: now - 30, model: 'claude-sonnet-4-6', input: 1000 })
    db.close()

    const r = computeHarnessAnalytics(dir, 7, now)!
    const today = r.days[6]
    expect(Object.keys(today.byModel).sort()).toEqual(['claude-sonnet-4-6', 'unknown'])
    expect(today.byModel.unknown.cost).toBe(0)
    expect(today.byModel.unknown.tokens).toBe(1000)
    expect(r.costStatus).toBe('partial')
  })

  it('reports unknown cost status when no model has pricing', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'))
    insertSession(db, { startedAt: noonToday() - 60, model: 'totally-unpriced-model', input: 1000 })
    db.close()
    expect(computeHarnessAnalytics(dir, 7, noonToday())!.costStatus).toBe('unknown')
  })

  it('ranks tool names from assistant messages.tool_calls ($.function.name) within the window', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'))
    const now = noonToday()
    const s1 = insertSession(db, { startedAt: now - 60 })
    insertToolCalls(db, s1, now - 50, ['read_file', 'read_file', 'web_search'])
    insertToolCalls(db, s1, now - 40, ['read_file', 'terminal'])
    // Old message outside the window: ignored.
    const old = insertSession(db, { startedAt: now - 20 * DAY })
    insertToolCalls(db, old, now - 20 * DAY, ['ancient_tool', 'ancient_tool', 'ancient_tool', 'ancient_tool'])
    // Malformed tool_calls JSON must not break the query.
    db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'assistant', '', ?, ?)`)
      .run(s1, '{not json', now - 30)
    // Non-assistant row with tool_calls is ignored.
    db.prepare(`INSERT INTO messages (session_id, role, content, tool_calls, timestamp) VALUES (?, 'user', '', ?, ?)`)
      .run(s1, JSON.stringify([{ function: { name: 'should_not_count' } }]), now - 20)
    db.close()

    const r = computeHarnessAnalytics(dir, 7, now)!
    expect(r.topTools).toEqual([
      { name: 'read_file', count: 3 },
      { name: 'terminal', count: 1 },
      { name: 'web_search', count: 1 },
    ])
  })

  it('ranks users per source by a 10-hex sha256 prefix and never exposes the raw id', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'))
    const now = noonToday()
    insertSession(db, { startedAt: now - 60, source: 'discord', userId: 'user-alice' })
    insertSession(db, { startedAt: now - 50, source: 'discord', userId: 'user-alice' })
    insertSession(db, { startedAt: now - 40, source: 'signal', userId: 'user-bob' })
    insertSession(db, { startedAt: now - 30, source: 'cron', userId: null })
    db.close()

    const r = computeHarnessAnalytics(dir, 7, now)!
    const alice = createHash('sha256').update('user-alice').digest('hex').slice(0, 10)
    const bob = createHash('sha256').update('user-bob').digest('hex').slice(0, 10)
    expect(r.topUsers).toEqual([
      { source: 'discord', userHash: alice, sessions: 2 },
      { source: 'signal', userHash: bob, sessions: 1 },
    ])
    expect(JSON.stringify(r)).not.toContain('user-alice')
    expect(JSON.stringify(r)).not.toContain('user-bob')
  })

  it('works against an older schema (no api_call_count / display_name, no messages rows)', () => {
    const dir = mkDataDir('a')
    const db = createDb(path.join(dir, 'state.db'), { minimal: true })
    db.exec('DROP TABLE messages')
    insertSession(db, { startedAt: noonToday() - 60, source: 'telegram', userId: 'u', toolCalls: 2 })
    db.close()

    const r = computeHarnessAnalytics(dir, 7, noonToday())!
    expect(r.days[6].sessions).toBe(1)
    expect(r.days[6].toolCalls).toBe(2)
    expect(r.topTools).toEqual([])
    expect(r.topUsers).toHaveLength(1)
  })

  it('returns an empty (not null) result for a harness with no state.db at all', () => {
    const dir = mkDataDir('fresh')
    const r = computeHarnessAnalytics(dir, 7, noonToday())
    expect(r).not.toBeNull()
    expect(r!.stale).toBe(false)
    expect(r!.days).toHaveLength(7)
    expect(r!.days.every((d) => d.sessions === 0)).toBe(true)
  })

  it('returns null (pending, never zero) for a migrated harness without a snapshot', () => {
    const dir = mkDataDir('migrated')
    fs.symlinkSync('/state/state.db', path.join(dir, 'state.db'))
    expect(computeHarnessAnalytics(dir, 7, noonToday())).toBeNull()
  })

  it('reads the snapshot for a migrated harness and flags it stale with the snapshot time', () => {
    const dir = mkDataDir('migrated')
    const snap = path.join(dir, 'state.db.snapshot')
    const db = createDb(snap)
    insertSession(db, { startedAt: noonToday() - 60 })
    db.close()
    fs.symlinkSync('/state/state.db', path.join(dir, 'state.db'))

    const r = computeHarnessAnalytics(dir, 7, noonToday())!
    expect(r.stale).toBe(true)
    expect(typeof r.snapshotAt).toBe('number')
    expect(Math.abs(r.snapshotAt! - fs.statSync(snap).mtimeMs)).toBeLessThan(1)
    expect(r.days[6].sessions).toBe(1)
  })

  it('returns null for an unreadable snapshot (unknown, not zero) but zeros for an unreadable live db', () => {
    const migrated = mkDataDir('migrated')
    fs.writeFileSync(path.join(migrated, 'state.db.snapshot'), 'torn export, not sqlite')
    fs.symlinkSync('/state/state.db', path.join(migrated, 'state.db'))
    expect(computeHarnessAnalytics(migrated, 7, noonToday())).toBeNull()

    const live = mkDataDir('live')
    fs.writeFileSync(path.join(live, 'state.db'), 'garbage')
    const r = computeHarnessAnalytics(live, 7, noonToday())
    expect(r).not.toBeNull()
    expect(r!.days.every((d) => d.sessions === 0)).toBe(true)
  })
})

describe('AnalyticsService', () => {
  function seed(name: string, n: number, source = 'cli'): AnalyticsTarget {
    const dir = mkDataDir(name)
    const db = createDb(path.join(dir, 'state.db'))
    for (let i = 0; i < n; i++) {
      insertSession(db, { startedAt: noonToday() - 60 - i, source, model: 'claude-haiku-4-5', input: 1_000_000, toolCalls: 1 })
    }
    db.close()
    return { harnessId: `h_${name}`, name, dataDir: dir }
  }

  it('resolves a harness by id through the injected target list', () => {
    const t = seed('iris', 2)
    const svc = new AnalyticsService({ listTargets: () => [t], now: noonToday })
    const r = svc.getHarnessAnalytics('h_iris', 7)
    expect(r).not.toBeNull()
    expect(r!.days[6].sessions).toBe(2)
  })

  it('throws a not-found error for an unknown harness id', () => {
    const svc = new AnalyticsService({ listTargets: () => [], now: noonToday })
    expect(() => svc.getHarnessAnalytics('h_nope', 7)).toThrow(/not found/i)
  })

  it('caches per (harnessId, days) for the TTL and clearCache() invalidates', () => {
    const t = seed('iris', 1)
    let calls = 0
    const svc = new AnalyticsService({
      listTargets: () => { calls++; return [t] },
      now: noonToday,
      ttlMs: 60_000,
    })
    svc.getHarnessAnalytics('h_iris', 7)
    svc.getHarnessAnalytics('h_iris', 7)
    expect(calls).toBe(1)
    svc.getHarnessAnalytics('h_iris', 30)
    expect(calls).toBe(2)
    svc.clearCache()
    svc.getHarnessAnalytics('h_iris', 7)
    expect(calls).toBe(3)
  })

  it('expires the cache after ttlMs', () => {
    const t = seed('iris', 1)
    let calls = 0
    let clock = noonToday()
    const svc = new AnalyticsService({
      listTargets: () => { calls++; return [t] },
      now: () => clock,
      ttlMs: 1000,
    })
    svc.getHarnessAnalytics('h_iris', 7)
    clock += 2 // seconds; still inside the 1s TTL? no — ttl is ms, clock is s: 2s > 1s
    svc.getHarnessAnalytics('h_iris', 7)
    expect(calls).toBe(2)
  })

  it('aggregates the fleet per day, per harness and per source; pending harnesses are listed, not zeroed', () => {
    const a = seed('alpha', 2, 'discord')
    const b = seed('beta', 3, 'cli')
    const pendingDir = mkDataDir('gamma')
    fs.symlinkSync('/state/state.db', path.join(pendingDir, 'state.db'))
    const c: AnalyticsTarget = { harnessId: 'h_gamma', name: 'gamma', dataDir: pendingDir }

    const svc = new AnalyticsService({ listTargets: () => [a, b, c], now: noonToday })
    const f = svc.getFleetAnalytics(7)

    expect(f.days).toHaveLength(7)
    const today = f.days[6]
    expect(today.sessions).toBe(5)
    expect(today.toolCalls).toBe(5)
    expect(today.bySource).toEqual({ discord: 2, cli: 3 })
    expect(today.byHarness.alpha.sessions).toBe(2)
    expect(today.byHarness.beta.sessions).toBe(3)
    expect(today.byHarness.gamma).toBeUndefined()

    const haiku = lookupPricing('claude-haiku-4-5')!
    const perSession = computeCost({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, haiku)
    expect(today.cost).toBeCloseTo(perSession * 5, 6)
    expect(today.byHarness.alpha.cost).toBeCloseTo(perSession * 2, 6)

    const rows = Object.fromEntries(f.harnesses.map((h) => [h.harnessId, h]))
    expect(rows.h_alpha).toMatchObject({ name: 'alpha', sessions: 2, pending: false, stale: false })
    expect(rows.h_alpha.cost).toBeCloseTo(perSession * 2, 6)
    expect(rows.h_gamma).toMatchObject({ name: 'gamma', pending: true, cost: null, sessions: null })
    expect(f.pendingCount).toBe(1)
    expect(f.costStatus).toBe('estimated')
  })
})
