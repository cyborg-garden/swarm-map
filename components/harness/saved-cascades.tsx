'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { CascadeRecord } from '@/lib/types'

/**
 * The named cascade library, shown under the cascade editor.
 *
 *  - Apply    → POST /api/cascades/:name/apply { harnessId }. The route ports
 *               the rows through the guarded writer and quick-restarts the
 *               harness itself; this component never calls /restart.
 *  - Save as… → POST /api/harnesses/:id/cascade/save-as { name, overwrite? }.
 *               Snapshots what is on disk for this harness (not the editor's
 *               unsaved rows). 409 → offer overwrite.
 *  - Rename   → PUT /api/cascades/:name { name }
 *  - Delete   → DELETE /api/cascades/:name (after confirm)
 */
export function SavedCascades({ harnessId, onApplied }: { harnessId: string; onApplied?: () => void }) {
  const { data: cascades, loading, error, refetch } = useApi<CascadeRecord[]>('/api/cascades')
  const [busy, setBusy] = useState<string | null>(null)

  async function readError(res: Response, fallback: string): Promise<string> {
    const body = await res.json().catch(() => ({}))
    return typeof body?.error === 'string' ? body.error : fallback
  }

  async function apply(name: string) {
    setBusy(`apply:${name}`)
    try {
      const res = await fetch(`/api/cascades/${encodeURIComponent(name)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harnessId }),
      })
      if (!res.ok) {
        toast.error(await readError(res, 'Failed to apply cascade'))
        return
      }
      const data = await res.json().catch(() => ({}))
      if (data.restarted) toast.success(`Applied "${name}" — restarting agent to pick it up`)
      else toast.success(`Applied "${name}"${data.restartError ? ` — restart failed: ${data.restartError}` : ''}`)
      onApplied?.()
    } catch {
      toast.error('Failed to apply cascade')
    } finally {
      setBusy(null)
    }
  }

  async function saveAs() {
    const raw = window.prompt('Name for this cascade:')
    if (raw === null) return
    const name = raw.trim()
    if (!name) return
    setBusy('save-as')
    try {
      const post = (overwrite: boolean) =>
        fetch(`/api/harnesses/${harnessId}/cascade/save-as`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(overwrite ? { name, overwrite: true } : { name }),
        })
      let res = await post(false)
      if (res.status === 409) {
        const msg = await readError(res, `A cascade named "${name}" already exists`)
        if (!window.confirm(`${msg}\n\nOverwrite it with this harness's current cascade?`)) return
        res = await post(true)
      }
      if (!res.ok) {
        toast.error(await readError(res, 'Failed to save cascade'))
        return
      }
      const record = await res.json().catch(() => ({ name }))
      toast.success(`Saved "${record.name ?? name}"`)
      refetch()
    } catch {
      toast.error('Failed to save cascade')
    } finally {
      setBusy(null)
    }
  }

  async function rename(name: string) {
    const raw = window.prompt('New name:', name)
    if (raw === null) return
    const next = raw.trim()
    if (!next || next === name) return
    setBusy(`rename:${name}`)
    try {
      const res = await fetch(`/api/cascades/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      })
      if (!res.ok) {
        toast.error(await readError(res, 'Failed to rename cascade'))
        return
      }
      toast.success(`Renamed to "${next}"`)
      refetch()
    } catch {
      toast.error('Failed to rename cascade')
    } finally {
      setBusy(null)
    }
  }

  async function remove(name: string) {
    if (!window.confirm(`Delete saved cascade "${name}"? Harnesses using it are not affected.`)) return
    setBusy(`delete:${name}`)
    try {
      const res = await fetch(`/api/cascades/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error(await readError(res, 'Failed to delete cascade'))
        return
      }
      toast.success(`Deleted "${name}"`)
      refetch()
    } catch {
      toast.error('Failed to delete cascade')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sm">Saved cascades</h3>
        <Button size="xs" variant="outline" onClick={saveAs} disabled={busy !== null} title="Snapshot this harness's current cascade into the library">
          {busy === 'save-as' ? 'Saving…' : 'Save as…'}
        </Button>
      </div>

      {error && <p className="text-xs text-[var(--danger)]">Could not load the library: {error}</p>}
      {loading && !cascades && !error && (
        <p className="text-xs text-muted-foreground flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
      )}
      {cascades && cascades.length === 0 && (
        <p className="text-xs text-muted-foreground italic">No saved cascades yet. Save this harness&apos;s cascade to reuse it elsewhere.</p>
      )}

      {cascades && cascades.length > 0 && (
        <ul aria-label="Saved cascades" className="divide-y divide-[var(--border)]">
          {cascades.map((c) => {
            const first = c.chain[0]
            const rest = c.chain.length - 1
            return (
              <li key={c.name} className="flex items-center gap-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{c.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {c.chain.length} model{c.chain.length === 1 ? '' : 's'}
                    {first && <> · <span className="font-mono">{first.model}</span>{rest > 0 ? ` +${rest}` : ''}</>}
                    {c.sourceHarness && <> · from {c.sourceHarness}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="xs" onClick={() => apply(c.name)} disabled={busy !== null} aria-label={`Apply ${c.name}`}>
                    {busy === `apply:${c.name}` ? 'Applying…' : 'Apply'}
                  </Button>
                  <button
                    type="button"
                    onClick={() => rename(c.name)}
                    disabled={busy !== null}
                    aria-label={`Rename ${c.name}`}
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-muted disabled:opacity-30"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(c.name)}
                    disabled={busy !== null}
                    aria-label={`Delete ${c.name}`}
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-[var(--danger)]/10 text-[var(--danger)] disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
