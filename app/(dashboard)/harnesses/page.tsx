'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { StatusDot } from '@/components/shared/status-dot'
import { TierBadge } from '@/components/shared/tier-badge'
import { DbHealthBadge, type DbIntegritySummary, type DbWriteFailureSummary } from '@/components/shared/db-health-badge'
import { DriftChip, DriftBanner, type DriftSummary } from '@/components/shared/drift-chip'
import { RetiredRows } from '@/components/fleet/retired-rows'
import { RuntimeBadge } from '@/components/shared/runtime-badge'
import { isDoorRuntime } from '@/lib/services/runtime-adapter'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { AddDoorAgentDialog } from '@/components/harness/add-door-agent-dialog'
import { Button } from '@/components/ui/button'
import type { Harness } from '@/lib/types'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

type FleetDrift = {
  checkedAt: number
  agents: DriftSummary[]
}

// Stop and restart cut off whatever an agent is doing, so each is asked about
// before it runs. So is removing a door agent, which forgets its rules.
type PendingAction =
  | { kind: 'restart' | 'stop' | 'remove-door'; id: string; name: string }
  | { kind: 'restart-all'; count: number }

function confirmCopy(action: PendingAction): { title: string; description: string; confirmLabel: string } {
  if (action.kind === 'restart-all') {
    const agents = `${action.count} running agent${action.count === 1 ? '' : 's'}`
    return {
      title: `Restart ${agents}?`,
      description: 'Each one drops the conversation it is in the middle of and is unavailable until it comes back up.',
      confirmLabel: 'Restart all',
    }
  }
  if (action.kind === 'remove-door') {
    return {
      title: `Remove ${action.name}?`,
      description: 'This stops its door and forgets its rules, its receipts and its spend record. The two secret files are left where they are.',
      confirmLabel: 'Remove',
    }
  }
  if (action.kind === 'stop') {
    return {
      title: `Stop ${action.name}?`,
      description: 'It drops the conversation it is in the middle of and stays offline until you start it again.',
      confirmLabel: 'Stop',
    }
  }
  return {
    title: `Restart ${action.name}?`,
    description: 'It drops the conversation it is in the middle of and is unavailable until it comes back up.',
    confirmLabel: 'Restart',
  }
}

type FleetDbHealth = {
  harnesses: Array<{
    harnessId: string
    integrity: DbIntegritySummary | null
    writeFailures: DbWriteFailureSummary | null
  }>
  githubCredentials?: { status: 'ok' | 'pending' | 'key-old' | 'fail'; message: string }
}

export default function HarnessesPage() {
  const router = useRouter()
  const { data: harnesses, loading, refetch } = useApi<Harness[]>('/api/harnesses', 5000)
  // DB integrity + write-failure signals (#204) — cached server-side, so a
  // slower poll is plenty.
  const { data: dbHealth } = useApi<FleetDbHealth>('/api/integrity', 30000)
  const dbHealthById = new Map((dbHealth?.harnesses ?? []).map((h) => [h.harnessId, h]))
  // Code drift — "is this agent running old code?". Nothing here pulls or
  // rebuilds, so this is a standing condition, not a transient: poll slowly and
  // keep it visible until a human rebuilds.
  const { data: drift } = useApi<FleetDrift>('/api/fleet/drift', 60000)
  const driftById = new Map((drift?.agents ?? []).map((a) => [a.harnessId, a]))

  // Door agents are not restarted by "Restart all running": that route drives Hermes agents only.
  const running = harnesses?.filter((h) => h.status === 'running' && !isDoorRuntime(h.runtime)) ?? []
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [addingDoorAgent, setAddingDoorAgent] = useState(false)

  function runPending() {
    const action = pending
    setPending(null)
    if (!action) return
    if (action.kind === 'restart-all') restartAll()
    else if (action.kind === 'remove-door') removeDoorAgent(action.id, action.name)
    else if (action.kind === 'stop') stopOne(action.id)
    else restartOne(action.id)
  }

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

  // A door agent is made from a small form. Its rules are filled in on its own page, which opens on them.
  function addDoorAgent() {
    setAddingDoorAgent(true)
  }

  // Asked about first, in the page's own dialog: see confirmCopy.
  async function removeDoorAgent(id: string, name: string) {
    try {
      const res = await fetch(`/api/harnesses/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Remove failed')
        return
      }
      toast.success(`Removed "${name}"`)
      refetch()
    } catch {
      toast.error('Remove failed')
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

  const githubCredentials = dbHealth?.githubCredentials

  return (
    <div>
      {githubCredentials && githubCredentials.status !== 'ok' && (
        <div
          role="alert"
          className={`mb-4 rounded-md px-3 py-2 text-sm ${githubCredentials.status === 'fail' ? 'bg-red-500/10 text-red-600' : 'bg-orange-500/10 text-orange-500'}`}
        >
          {githubCredentials.message}
        </div>
      )}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Harnesses</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={createNew}>
            Create New
          </Button>
          <Button variant="outline" size="sm" onClick={importHarness}>
            Import
          </Button>
          <Button variant="outline" size="sm" onClick={addDoorAgent}>
            Add door agent
          </Button>
          {running.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setPending({ kind: 'restart-all', count: running.length })}>
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
                      <RuntimeBadge runtime={h.runtime} />
                      {/* A door agent has no state database and no image built from this
                          checkout, so neither chip applies to it. Drawing them would say
                          "build unknown" about something that was never in question. */}
                      {!isDoorRuntime(h.runtime) && (
                        <DbHealthBadge
                          integrity={dbHealthById.get(h.id)?.integrity}
                          writeFailures={dbHealthById.get(h.id)?.writeFailures}
                        />
                      )}
                      {drift && !isDoorRuntime(h.runtime) && <DriftChip drift={driftById.get(h.id)} />}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <TierBadge tier={h.tier} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {h.platform} / {h.channel}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{h.models?.[0] ?? '—'}</td>
                  {/* null cost/invocations = unknown (migrated, snapshot pending) — '—', never $0 */}
                  <td className="px-4 py-3 text-right">{h.costToday == null ? '—' : `$${h.costToday.toFixed(2)}`}</td>
                  <td className="px-4 py-3 text-right">{h.invocations ?? '—'}</td>
                  <td className="px-4 py-3 text-right">
                    {isDoorRuntime(h.runtime) ? (
                      // Restart and Duplicate do not apply to a door agent. Start is on its page, where the dry run's result is shown.
                      <div className="flex items-center justify-end gap-2">
                        {h.status === 'running' && (
                          <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'stop', id: h.id, name: h.name ?? h.id })}>
                            Stop
                          </Button>
                        )}
                        <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'remove-door', id: h.id, name: h.name ?? h.id })} title="Remove" aria-label={`Remove ${h.name ?? h.id}`} className="text-destructive hover:text-destructive">
                          ✕
                        </Button>
                      </div>
                    ) : (
                    <div className="flex items-center justify-end gap-2">
                      <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'restart', id: h.id, name: h.name ?? h.id })} disabled={h.status === 'restarting'}>
                        {h.status === 'restarting' ? 'Rebuilding...' : 'Restart'}
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setPending({ kind: 'stop', id: h.id, name: h.name ?? h.id })}>
                        Stop
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => duplicateOne(h.id, h.name)} title="Duplicate">
                        ⧉
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => removeOne(h.id, h.name)} title="Remove" className="text-destructive hover:text-destructive">
                        ✕
                      </Button>
                    </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RetiredRows />

      <ConfirmDialog
        open={pending !== null}
        {...(pending ? confirmCopy(pending) : { title: '', description: '', confirmLabel: '' })}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />

      <AddDoorAgentDialog
        open={addingDoorAgent}
        agents={harnesses ?? []}
        onClose={() => setAddingDoorAgent(false)}
        onCreated={(id) => { setAddingDoorAgent(false); router.push(`/harnesses/${id}?tab=rules`) }}
      />
    </div>
  )
}
