'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { Button } from '@/components/ui/button'
import { ModelAutoUpdateControls, useModelAutoUpdate } from './model-auto-update-controls'
import type { ModelUpdateReport } from '@/lib/services/model-update-scheduler'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

type ReportShape = Omit<ModelUpdateReport, 'checkedAt'> & { checkedAt: number | null }

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/**
 * Fleet dashboard card: the global model-update policy, a manual check, and
 * every pending successor across harnesses with a one-click Update.
 *
 *  GET/PUT /api/settings/model-auto-update  (via useModelAutoUpdate)
 *  GET     /api/fleet/model-updates          last persisted report
 *  POST    /api/fleet/model-updates/check    run a check now
 *  POST    /api/fleet/model-updates/apply    { harnessId, from, to }
 */
export function ModelUpdatesCard() {
  const policy = useModelAutoUpdate()
  const { data: report, error: reportError, refetch: refetchReport } = useApi<ReportShape>('/api/fleet/model-updates')
  const [checking, setChecking] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)

  const pending = (report?.harnesses ?? []).flatMap((h) =>
    h.entries
      .filter((e) => e.successor && !e.applied)
      .map((e) => ({ harnessId: h.id, harnessName: h.name, ...e, successor: e.successor as string })),
  )

  async function checkNow() {
    setChecking(true)
    try {
      const res = await fetch('/api/fleet/model-updates/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Model update check failed')
        return
      }
      // In apply mode the check ALSO rotates tracked successors and restarts
      // those harnesses — say so, never "every model is current".
      type H = { name?: string; entries?: Array<{ successor?: string; applied?: boolean }> }
      const harnesses: H[] = body.harnesses ?? []
      const n = harnesses.reduce((s, h) => s + (h.entries ?? []).filter((e) => e.successor && !e.applied).length, 0)
      const appliedNames = harnesses.filter((h) => (h.entries ?? []).some((e) => e.applied)).map((h) => h.name ?? '?')
      const applied = harnesses.reduce((s, h) => s + (h.entries ?? []).filter((e) => e.applied).length, 0)
      const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`
      if (applied > 0) {
        const more = n > 0 ? `, ${n} more available` : ''
        toast.success(`Checked — ${plural(applied, 'update')} applied, ${appliedNames.join(', ')} restarting${more}`)
      } else {
        toast.success(n === 0 ? 'Checked — every model is current' : `Checked — ${plural(n, 'update')} available`)
      }
      refetchReport()
    } catch {
      toast.error('Model update check failed')
    } finally {
      setChecking(false)
    }
  }

  async function applyRow(row: { harnessId: string; model: string; successor: string }) {
    const key = `${row.harnessId}:${row.model}`
    setApplying(key)
    try {
      const res = await fetch('/api/fleet/model-updates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harnessId: row.harnessId, from: row.model, to: row.successor }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Failed to apply update')
        return
      }
      toast.success(`Updated ${row.model} → ${row.successor} — restarting agent`)
      refetchReport()
    } catch {
      toast.error('Failed to apply update')
    } finally {
      setApplying(null)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 mt-6" aria-label="Model updates">
      <div className="flex items-center justify-between mb-3 gap-3">
        <h3 className="font-medium text-sm">Model updates</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {report?.checkedAt ? `Checked ${relativeTime(report.checkedAt)}` : 'Never checked'}
          </span>
          <Button size="xs" variant="outline" onClick={checkNow} disabled={checking}>
            {checking ? <><Loader2 className="h-3 w-3 animate-spin" /> Checking…</> : 'Check now'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3">
          {policy.error && <p className="text-xs text-[var(--danger)]">Could not load policy: {policy.error}</p>}
          <ModelAutoUpdateControls settings={policy.settings} saving={policy.saving} update={policy.update} idPrefix="fleet-model-auto-update" />
        </div>

        <div className="min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Pending successors</p>
          {reportError && <p className="text-xs text-[var(--danger)]">Could not load report: {reportError}</p>}
          {report && pending.length === 0 && !reportError && (
            <p className="text-xs text-muted-foreground italic">No pending updates.</p>
          )}
          {pending.length > 0 && (
            <ul aria-label="Pending model updates" className="divide-y divide-[var(--border)]">
              {pending.map((row) => {
                const key = `${row.harnessId}:${row.model}`
                return (
                  <li key={key} className="flex items-center gap-2 py-1.5 text-xs">
                    <div className="flex-1 min-w-0">
                      <p className="truncate">
                        <span className="font-medium">{row.harnessName}</span>
                        <span className="text-muted-foreground"> · </span>
                        <span className="font-mono">{row.model}</span>
                        <span className="text-muted-foreground"> → </span>
                        <span className="font-mono text-[var(--warning)]">{row.successor}</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {row.provider}
                        {row.kind ? ` · ${row.kind}` : ''}
                        {typeof row.priceRatio === 'number' ? ` · ${row.priceRatio.toFixed(2)}× price` : ''}
                        {row.retired ? ' · current model retired' : ''}
                        {row.blocked ? ` · blocked: ${row.blocked}` : ''}
                      </p>
                    </div>
                    <Button
                      size="xs"
                      onClick={() => applyRow(row)}
                      disabled={applying !== null}
                      aria-label={applying === key ? `Updating ${row.model}` : `Update ${row.model} to ${row.successor}`}
                    >
                      {applying === key ? 'Updating…' : 'Update'}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}
