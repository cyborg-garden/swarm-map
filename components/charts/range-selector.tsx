'use client'

export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]

/** 7d / 30d / 90d toggle. One row, above the charts (dataviz: filters live above). */
export function RangeSelector({ value, onChange }: { value: RangeDays; onChange: (d: RangeDays) => void }) {
  return (
    <div role="group" aria-label="Date range" className="inline-flex rounded-lg border border-[var(--border)] p-[2px] text-xs">
      {RANGE_OPTIONS.map((d) => {
        const active = d === value
        return (
          <button
            key={d}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(d)}
            className={
              'px-2.5 py-1 rounded-md transition-colors ' +
              (active ? 'bg-[var(--muted)] text-foreground font-medium' : 'text-muted-foreground hover:text-foreground')
            }
          >
            {d}d
          </button>
        )
      })}
    </div>
  )
}

/** Freshness / pricing caveats shared by the harness tab and the fleet section. */
export function AnalyticsNotes({
  stale,
  snapshotAt,
  costStatus,
  pendingCount,
}: {
  stale: boolean
  snapshotAt?: number
  costStatus?: 'estimated' | 'partial' | 'unknown'
  pendingCount?: number
}) {
  // Clock time, not an age: an age needs Date.now() during render, which is
  // impure (react-hooks/purity) and would drift between renders anyway.
  const exportedAt = snapshotAt ? new Date(snapshotAt).toLocaleTimeString() : null
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      {stale && (
        <p>
          Read from a snapshot export (≤5 min stale)
          {exportedAt ? ` — exported at ${exportedAt}.` : '.'}
        </p>
      )}
      {pendingCount ? (
        <p>{pendingCount} harness{pendingCount === 1 ? '' : 'es'} pending: migrated, no snapshot exported yet. Not counted, not zero.</p>
      ) : null}
      {costStatus === 'estimated' && <p>Costs are estimates from published model pricing.</p>}
      {costStatus === 'partial' && <p>Some models have unknown pricing; costs are partially estimated.</p>}
      {costStatus === 'unknown' && <p>Model pricing not available; token counts are shown but costs cannot be estimated.</p>}
    </div>
  )
}
