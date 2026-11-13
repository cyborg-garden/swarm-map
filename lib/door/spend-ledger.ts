// The spend ledger: what has been spent on model calls, month by month.
//
// The budget cap is only as good as the figure it is compared with. Kept in
// the route's own memory, that figure went back to zero on every restart and
// never rolled over at the end of a month. So the route keeps none of its
// own: it reads and writes a ledger, keyed by calendar month, and has no
// default for it. Whoever starts a route must say where spend is kept.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface SpendLedger {
  /** USD on the books for the calendar month that holds `at`. */
  spent(at: Date): number
  /** Put `usd` on the books for the calendar month that holds `at`. */
  add(at: Date, usd: number): void
}

/** The calendar month of `at`, in UTC, as `2026-11`. One clock for every agent, wherever it runs. */
export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7)
}

function ledgerOver(months: Record<string, number>, saved: () => void): SpendLedger {
  return {
    spent: (at) => months[monthOf(at)] ?? 0,
    add(at, usd) {
      if (!Number.isFinite(usd) || usd < 0) throw new Error(`spend ledger: ${usd} is not an amount of money`)
      months[monthOf(at)] = (months[monthOf(at)] ?? 0) + usd
      saved()
    },
  }
}

/** Forgets everything when the process ends. For tests and throwaway labs only. */
export function createMemoryLedger(): SpendLedger {
  return ledgerOver({}, () => {})
}

/**
 * Kept in one JSON file, so a restart does not hand the budget back. The file
 * belongs to one route at a time, and must sit outside the cell.
 *
 * A file that is missing is a first run and starts empty. A file that is
 * there but cannot be read is refused: reading it as zero would lift the cap.
 */
export function createFileLedger(file: string): SpendLedger {
  const months: Record<string, number> = {}
  if (existsSync(file)) {
    const refuse = (why: string): never => {
      throw new Error(`spend ledger: ${file} ${why}; refusing to start from zero`)
    }
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(file, 'utf8')) } catch { refuse('is not JSON') }
    const record = parsed as { schema?: unknown; months?: unknown } | null
    const held = record?.months
    if (record?.schema !== 1 || held === null || typeof held !== 'object' || Array.isArray(held)) refuse('is not a spend ledger')
    for (const [month, usd] of Object.entries(held as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}$/.test(month) || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) refuse(`holds a bad entry for ${month}`)
      months[month] = usd as number
    }
  }
  return ledgerOver(months, () => {
    // Written beside the file and moved into place, so a crash never leaves half a ledger.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: 1, months }) + '\n')
    renameSync(tmp, file)
  })
}
