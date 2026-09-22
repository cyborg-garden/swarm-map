'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { LineChart } from '@/components/charts/line-chart'
import { HorizontalBarList } from '@/components/charts/horizontal-bar-list'
import { RangeSelector, AnalyticsNotes, type RangeDays } from '@/components/charts/range-selector'
import { formatCompact, formatUsd } from '@/components/charts/chart-tokens'
import type { HarnessAnalytics } from '@/lib/services/analytics'

type Response = HarnessAnalytics | { harnessId: string; pending: true }

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 ${className}`}>{children}</div>
}

export function AnalyticsTab({ harnessId }: { harnessId: string }) {
  const [days, setDays] = useState<RangeDays>(30)
  const { data, error, loading } = useApi<Response>(`/api/harnesses/${harnessId}/analytics?days=${days}`)

  const pending = !!data && 'pending' in data
  const a = data && !pending ? (data as HarnessAnalytics) : null

  const totals = a
    ? a.days.reduce(
        (s, d) => ({ cost: s.cost + d.cost, tokens: s.tokens + d.tokens, sessions: s.sessions + d.sessions, toolCalls: s.toolCalls + d.toolCalls }),
        { cost: 0, tokens: 0, sessions: 0, toolCalls: 0 },
      )
    : null

  const costByModel = a ? a.days.map((d) => ({
    label: d.date,
    values: Object.fromEntries(Object.entries(d.byModel).map(([m, v]) => [m, v.cost])),
  })) : []
  const sessionsBySource = a ? a.days.map((d) => ({ label: d.date, values: d.bySource })) : []
  const toolCallsPerDay = a ? a.days.map((d) => ({ label: d.date, value: d.toolCalls })) : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Last {days} days, local time.</p>
        <RangeSelector value={days} onChange={setDays} />
      </div>

      {error && (
        <Panel className="text-sm text-[var(--danger)]">Could not load analytics: {error}</Panel>
      )}

      {pending && (
        <Panel className="text-center">
          <p className="text-sm font-medium">Usage pending</p>
          <p className="text-xs text-muted-foreground mt-1">
            This harness has migrated its database and no snapshot has been exported yet. Analytics will appear after the next snapshot sweep (≤5 min).
          </p>
        </Panel>
      )}

      {a && totals && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile label="Cost" value={a.costStatus === 'unknown' ? '—' : formatUsd(totals.cost)} sub={a.costStatus === 'partial' ? 'partially estimated' : 'estimated'} />
            <Tile label="Sessions" value={String(totals.sessions)} />
            <Tile label="Tool calls" value={formatCompact(totals.toolCalls)} />
            <Tile label="Tokens" value={formatCompact(totals.tokens)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel><StackedBarChart title="Cost by model" data={costByModel} valueFormatter={formatUsd} /></Panel>
            <Panel><StackedBarChart title="Sessions by surface" data={sessionsBySource} /></Panel>
            <Panel><LineChart title="Tool calls per day" data={toolCallsPerDay} /></Panel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Panel><HorizontalBarList title="Top tools" items={a.topTools.map((t) => ({ label: t.name, value: t.count }))} /></Panel>
              <Panel>
                <HorizontalBarList
                  title="Top users"
                  items={a.topUsers.map((u) => ({ label: `${u.source} · ${u.userHash}`, value: u.sessions, hint: 'hashed user id — no PII' }))}
                />
              </Panel>
            </div>
          </div>

          <AnalyticsNotes stale={a.stale} snapshotAt={a.snapshotAt} costStatus={a.costStatus} />
        </>
      )}

      {loading && !data && !error && <p className="text-sm text-muted-foreground">Loading analytics...</p>}
    </div>
  )
}
