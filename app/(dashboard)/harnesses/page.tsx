'use client'

import { useApi } from '@/lib/hooks/use-api'
import { StatusDot } from '@/components/shared/status-dot'
import { TierBadge } from '@/components/shared/tier-badge'
import { DbHealthBadge, type DbIntegritySummary, type DbWriteFailureSummary } from '@/components/shared/db-health-badge'
import { DriftChip, DriftBanner, type DriftSummary } from '@/components/shared/drift-chip'
import { Button } from '@/components/ui/button'
import type { Harness } from '@/lib/types'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

type FleetDrift = {
  checkedAt: number
  agents: DriftSummary[]
}

type FleetDbHealth = {
  harnesses: Array<{
    harnessId: string
    integrity: DbIntegritySummary | null
    writeFailures: DbWriteFailureSummary | null
  }>
}

export default function HarnessesPage() {
  const router = useRouter()
  const { data: containerHarnesses, loading, refetch } = useApi<Harness[]>('/api/harnesses', 5000)
  // Letta agents come from a separate async REST path (design §1c) — merge them
  // into the fleet list. Failure is soft: no Letta server → just no Letta rows.
  const { data: lettaHarnesses } = useApi<Harness[]>('/api/letta/harnesses', 10000)
  // DB integrity + write-failure signals (#204) — cached server-side, so a
  // slower poll is plenty.
  const { data: dbHealth } = useApi<FleetDbHealth>('/api/integrity', 30000)
  const dbHealthById = new Map((dbHealth?.harnesses ?? []).map((h) => [h.harnessId, h]))
  // Code drift — "is this agent running old code?". Nothing here pulls or
  // rebuilds, so this is a standing condition, not a transient: poll slowly and
  // keep it visible until a human rebuilds.
  const { data: drift } = useApi<FleetDrift>('/api/fleet/drift', 60000)
  const driftById = new Map((drift?.agents ?? []).map((a) => [a.harnessId, a]))

  const harnesses =
    containerHarnesses || lettaHarnesses
      ? [...(containerHarnesses ?? []), ...(Array.isArray(lettaHarnesses) ? lettaHarnesses : [])]
      : undefined

  // Only container harnesses can be bulk-restarted (Letta agents aren't containers).
  const running = containerHarnesses?.filter((h) => h.status === 'running') ?? []

  const isLetta = (h: Harness) => h.runtime === 'letta' || h.runtime === 'letta-server'

  async function restartAll() {
    try {
      const res = await fetch('/api/harnesses/restart-running', { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success(`Restarting ${running.length} harnesses`)
      refetch()
    } catch {
      toast.error('Restart failed')
    }
  }

  async function restartOne(id: string) {
    try {
      const res = await fetch(`/api/harnesses/${id}/restart`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success('Harness restarted')
      refetch()
    } catch {
      toast.error('Restart failed')
    }
  }

  async function stopOne(id: string) {
    try {
      const res = await fetch(`/api/harnesses/${id}/stop`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      toast.success('Harness stopped')
      refetch()
    } catch {
      toast.error('Stop failed')
    }
  }

  function createNew() {
    router.push('/setup/wizard')
  }

  async function importHarness() {
    const dataDir = window.prompt('Path to harness data directory (e.g. ~/.hermes-myagent):')
    if (!dataDir?.trim()) return

    const name = window.prompt('Name for the imported harness:')
    if (!name?.trim()) return

    try {
      const res = await fetch('/api/harnesses/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir: dataDir.trim(), name: name.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Import failed')
        return
      }
      toast.success(`Imported "${name.trim()}"`)
      refetch()
    } catch {
      toast.error('Import failed')
    }
  }

  async function removeOne(id: string, name: string) {
    const confirmed = window.confirm(
      `Remove "${name}" from HSM?\n\nThis will stop the container and unregister it. Data files are kept unless you choose to delete them.`
    )
    if (!confirmed) return

    const deleteFiles = window.confirm(
      `Also delete all data files for "${name}"?\n\n• ~/.hermes-${name}/\n• compose config\n\nClick OK to delete files, or Cancel to keep them.`
    )

    try {
      const res = await fetch(`/api/harnesses/${id}?deleteFiles=${deleteFiles}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Remove failed')
        return
      }
      const result = await res.json()
      const msg = deleteFiles && result.filesDeleted
        ? `Removed "${name}" and deleted files`
        : `Removed "${name}" (files kept)`
      toast.success(msg)
      refetch()
    } catch {
      toast.error('Remove failed')
    }
  }

  async function duplicateOne(id: string, currentName: string) {
    const newName = window.prompt('Name for the duplicate harness:', `${currentName}-copy`)
    if (!newName?.trim()) return
    try {
      const res = await fetch(`/api/harnesses/${id}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Duplicate failed')
        return
      }
      toast.success(`Duplicated as "${newName.trim()}"`)
      refetch()
    } catch {
      toast.error('Duplicate failed')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Harnesses</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={createNew}>
            Create New
          </Button>
          <Button variant="outline" size="sm" onClick={importHarness}>
            Import
          </Button>
          {running.length > 0 && (
            <Button variant="outline" size="sm" onClick={restartAll}>
              Restart all running ({running.length})
            </Button>
          )}
        </div>
      </div>

      <DriftBanner agents={drift?.agents} />

      {loading && <p className="text-muted-foreground">Loading...</p>}

      {!loading && harnesses && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-left px-4 py-3">Tier</th>
                <th className="text-left px-4 py-3">Platform</th>
                <th className="text-left px-4 py-3">Model</th>
                <th className="text-right px-4 py-3">Cost</th>
                <th className="text-right px-4 py-3">Inv</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {harnesses.map((h) => (
                <tr key={h.id} className="border-b border-[var(--border)] last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/harnesses/${h.id}`} className="flex items-center gap-2 hover:underline">
                      <StatusDot status={h.status ?? 'stopped'} />
                      <span className="font-medium">{h.name ?? h.id}</span>
                      {h.health?.errors > 0 && (
                        <span className="text-xs text-destructive">({h.health.errors} err)</span>
                      )}
                      {!isLetta(h) && (
                        <DbHealthBadge
                          integrity={dbHealthById.get(h.id)?.integrity}
                          writeFailures={dbHealthById.get(h.id)?.writeFailures}
                        />
                      )}
                      {!isLetta(h) && drift && <DriftChip drift={driftById.get(h.id)} />}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <TierBadge tier={h.tier} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {isLetta(h) ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs uppercase tracking-wide">{h.runtime}</span>
                    ) : (
                      <>{h.platform} / {h.channel}</>
                    )}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{h.models?.[0] ?? '—'}</td>
                  {/* Letta agents have no per-agent container stats (design §4b) */}
                  {/* null cost/invocations = unknown (migrated, snapshot pending) — '—', never $0 */}
                  <td className="px-4 py-3 text-right">{isLetta(h) || h.costToday == null ? '—' : `$${h.costToday.toFixed(2)}`}</td>
                  <td className="px-4 py-3 text-right">{isLetta(h) ? '—' : (h.invocations ?? '—')}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isLetta(h) ? (
                        // No container lifecycle for a Postgres row — just open it.
                        <Link href={`/harnesses/${h.id}`}>
                          <Button variant="ghost" size="xs">Open</Button>
                        </Link>
                      ) : (
                        <>
                          <Button variant="ghost" size="xs" onClick={() => restartOne(h.id)} disabled={h.status === 'restarting'}>
                            {h.status === 'restarting' ? 'Rebuilding...' : 'Restart'}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => stopOne(h.id)}>
                            Stop
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => duplicateOne(h.id, h.name)} title="Duplicate">
                            ⧉
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => removeOne(h.id, h.name)} title="Remove" className="text-destructive hover:text-destructive">
                            ✕
                          </Button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
