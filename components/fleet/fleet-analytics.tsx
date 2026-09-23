'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { RangeSelector, AnalyticsNotes, type RangeDays } from '@/components/charts/range-selector'
import { formatCompact, formatUsd } from '@/components/charts/chart-tokens'
import type { FleetAnalytics as FleetAnalyticsData } from '@/lib/services/analytics'

/** Dashboard section: fleet daily cost stacked by harness + sessions by surface. */
export function FleetAnalytics() {
  const [days, setDays] = useState<RangeDays>(30)
  const { data, error, loading } = useApi<FleetAnalyticsData>(`/api/fleet/analytics?days=${days}`)

  const costByHarness = data ? data.days.map((d) => ({
    label: d.date,
    values: Object.fromEntries(Object.entries(d.byHarness).map(([h, v]) => [h, v.cost])),
  })) : []
  const sessionsBySource = data ? data.days.map((d) => ({ label: d.date, values: d.bySource })) : []

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 mt-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-medium text-sm">Fleet analytics</h3>
        <RangeSelector value={days} onChange={setDays} />
      </div>

      {error && <p className="text-sm text-[var(--danger)]">Could not load fleet analytics: {error}</p>}
      {loading && !data && !error && <p className="text-sm text-muted-foreground">Loading...</p>}

      {data && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <StackedBarChart title="Cost by harness" data={costByHarness} valueFormatter={formatUsd} />
            <StackedBarChart title="Sessions by surface" data={sessionsBySource} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Per harness totals">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="text-left px-2 py-1.5">Harness</th>
                  <th className="text-right px-2 py-1.5">Cost</th>
                  <th className="text-right px-2 py-1.5">Sessions</th>
                  <th className="text-right px-2 py-1.5">Tool calls</th>
                  <th className="text-right px-2 py-1.5">Tokens</th>
                </tr>
              </thead>
              <tbody>
                {data.harnesses.map((h) => (
                  <tr key={h.harnessId} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-2 py-1.5 font-mono text-xs">
                      {h.name}
                      {h.stale && <span className="ml-1 text-muted-foreground" title="read from snapshot">·snapshot</span>}
                    </td>
                    {h.pending ? (
                      <td className="px-2 py-1.5 text-right text-xs text-muted-foreground" colSpan={4}>pending — no snapshot yet</td>
                    ) : (
                      <>
                        <td className="px-2 py-1.5 text-right font-medium">{h.costStatus === 'unknown' ? '—' : formatUsd(h.cost ?? 0)}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{h.sessions ?? 0}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{formatCompact(h.toolCalls ?? 0)}</td>
                        <td className="px-2 py-1.5 text-right text-muted-foreground">{formatCompact(h.tokens ?? 0)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <AnalyticsNotes stale={data.stale} costStatus={data.costStatus} pendingCount={data.pendingCount} />
        </div>
      )}
    </section>
  )
}
