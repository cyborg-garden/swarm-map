'use client'

import { useApi } from '@/lib/hooks/use-api'
import { Button } from '@/components/ui/button'
import type { RetiredHarnessRow } from '@/lib/services/runtime-adapter'
import { toast } from 'sonner'

/**
 * Stored rows whose runtime Swarm Map no longer drives (retired, or unknown to
 * this build). They are not in the fleet table and have no detail page. The
 * only action is "Forget row": DELETE /api/harnesses/:id, which for these rows
 * removes the stored entry and touches no container, file or volume.
 *
 *  GET    /api/harnesses/retired
 *  DELETE /api/harnesses/:id
 */
export function RetiredRows() {
  const { data, refetch } = useApi<RetiredHarnessRow[]>('/api/harnesses/retired', 30000)
  const rows = Array.isArray(data) ? data : []
  if (rows.length === 0) return null

  async function forget(row: RetiredHarnessRow) {
    const ok = window.confirm(
      `Forget "${row.name}"?\n\nThis removes the stored row only. No container, file or volume is touched.`,
    )
    if (!ok) return
    try {
      const res = await fetch(`/api/harnesses/${row.id}`, { method: 'DELETE' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Could not forget the row')
        return
      }
      toast.success(`Forgot "${row.name}"`)
      refetch()
    } catch {
      toast.error('Could not forget the row')
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">Rows Swarm Map no longer manages</h3>
        <p className="text-xs text-muted-foreground">
          These were stored under a runtime that is retired or unknown. Nothing can be started, stopped or
          changed through them, and no new agent can take one of these names until its row is forgotten.
        </p>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium">{row.name}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-mono">{row.runtime}</span>
              </div>
              <p className="text-xs text-muted-foreground">{row.note}</p>
            </div>
            <Button variant="ghost" size="xs" onClick={() => forget(row)}>
              Forget row
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}
