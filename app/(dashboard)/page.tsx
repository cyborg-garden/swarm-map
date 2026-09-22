'use client'

import { useApi } from '@/lib/hooks/use-api'
import { HarnessCard } from '@/components/harness/harness-card'
import { DriftBanner, type DriftSummary } from '@/components/shared/drift-chip'
import { FleetAnalytics } from '@/components/fleet/fleet-analytics'
import { TIER_COLORS, TIER_ORDER } from '@/lib/constants'
import type { Harness, AuditEntry } from '@/lib/types'

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function TierBar({ harnesses }: { harnesses: Harness[] }) {
  const counts = Object.fromEntries(TIER_ORDER.map((t) => [t, 0])) as Record<string, number>
  harnesses.forEach((h) => { counts[h.tier] = (counts[h.tier] || 0) + 1 })
  const total = harnesses.length || 1
  return (
    <div className="flex rounded-full overflow-hidden h-2 gap-0.5">
      {TIER_ORDER.map((tier) => {
        const pct = (counts[tier] / total) * 100
        if (pct === 0) return null
        return (
          <div
            key={tier}
            style={{ width: `${pct}%`, backgroundColor: TIER_COLORS[tier] }}
            title={`${tier}: ${counts[tier]}`}
          />
        )
      })}
    </div>
  )
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return `${h}h ago`
}

export default function DashboardPage() {
  const { data: harnesses, loading: hLoading } = useApi<Harness[]>('/api/harnesses', 5000)
  const { data: audit, loading: aLoading } = useApi<AuditEntry[]>('/api/audit', 5000)
  // Code drift — a standing condition (nothing on this host rebuilds itself),
  // so a slow poll is plenty and the banner stays up until someone acts.
  const { data: drift } = useApi<{ checkedAt: number; agents: DriftSummary[] }>('/api/fleet/drift', 60000)
  const driftById = new Map((drift?.agents ?? []).map((a) => [a.harnessId, a]))

  const running = harnesses?.filter((h) => h.status === 'running').length ?? 0
  // null cost/invocations = unknown (migrated harness awaiting its first
  // snapshot export) — sum the known values rather than treating unknown as 0.
  const invocations = harnesses?.reduce((s, h) => s + (h.invocations ?? 0), 0) ?? 0
  const errors = harnesses?.reduce((s, h) => s + (h.health?.errors ?? 0), 0) ?? 0
  const costToday = harnesses?.reduce((s, h) => s + (h.costToday ?? 0), 0) ?? 0
  const recentAudit = audit?.slice(-10).reverse() ?? []

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6">Dashboard</h2>

      <DriftBanner agents={drift?.agents} />

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Running" value={hLoading ? '—' : running} sub={`of ${harnesses?.length ?? 0} harnesses`} />
        <StatCard label="Invocations today" value={hLoading ? '—' : invocations} />
        <StatCard label="Errors" value={hLoading ? '—' : errors} />
        <StatCard label="Cost today" value={hLoading ? '—' : `$${costToday.toFixed(2)}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Harness fleet */}
        <div className="lg:col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-sm">Harness Fleet</h3>
            <span className="text-xs text-muted-foreground">{harnesses?.length ?? 0} total</span>
          </div>
          {!hLoading && harnesses && harnesses.length > 0 && (
            <div className="mb-4">
              <TierBar harnesses={harnesses} />
              <div className="flex gap-3 mt-2 flex-wrap">
                {TIER_ORDER.map((tier) => {
                  const count = harnesses.filter((h) => h.tier === tier).length
                  if (count === 0) return null
                  return (
                    <span key={tier} className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span className="inline-block h-2 w-2 rounded-[2px]" style={{ backgroundColor: TIER_COLORS[tier] }} />
                      {tier} ({count})
                    </span>
                  )
                })}
              </div>
            </div>
          )}
          <div className="space-y-1">
            {hLoading && <p className="text-sm text-muted-foreground">Loading harnesses...</p>}
            {harnesses?.map((h) => (
              <HarnessCard key={h.id} harness={h} drift={drift ? driftById.get(h.id) ?? null : undefined} />
            ))}
          </div>
        </div>

        {/* Activity tail */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h3 className="font-medium text-sm mb-3">Recent Activity</h3>
          {aLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
          <div className="space-y-2">
            {recentAudit.map((entry, i) => (
              <div key={i} className="text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium truncate">{entry.who}</span>
                  <span className="text-muted-foreground shrink-0 ml-2">{relativeTime(entry.ts)}</span>
                </div>
                <p className="text-muted-foreground truncate">
                  {entry.what} — {entry.target}
                </p>
              </div>
            ))}
            {!aLoading && recentAudit.length === 0 && (
              <p className="text-xs text-muted-foreground">No activity yet.</p>
            )}
          </div>
        </div>
      </div>

      {/* Fleet analytics (#206): its own cached endpoint, not the 5s harness poll. */}
      <FleetAnalytics />
    </div>
  )
}
