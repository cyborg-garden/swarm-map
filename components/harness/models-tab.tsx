'use client'

import { useEffect, useMemo, useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { ModelCascadeEditor, type FallbackProviderEntry } from './model-cascade-editor'
import { SavedCascades } from './saved-cascades'
import { isTrackableProvider, isRetiredIn, rowKey, type LiveListLike } from '@/lib/model-row-status'
import type { ModelUpdateReport } from '@/lib/services/model-update-scheduler'
import { toast } from 'sonner'

export type ModelConfig = {
  provider: string
  primary: string
  models: string[]
  /** Raw fallback_providers rows (a duplicate row 0 included). */
  fallbackProviders?: FallbackProviderEntry[]
  /** The chain the editor shows: the primary (model:) first, then the fallbacks. */
  chain?: FallbackProviderEntry[]
  primaryEntry?: FallbackProviderEntry | null
  /** The file repeats its primary as fallback_providers[0] — a convention the writer preserves. */
  primaryDuplicatedAsRow0?: boolean
}

/**
 * How the page should read a 409 from PUT /api/harnesses/:id/models. The
 * writer sends two conflicts under one status: the chain on disk no longer
 * matches what the editor was seeded from (reload, re-apply the edit); and
 * duplicate-sections — config.yaml has two top-level model: /
 * fallback_providers: headers and must be hand-edited. The latter is the
 * operator's to fix, so the page shows the writer's message and keeps the
 * editor state. Only the stale conflict reloads: a code-prefixed error
 * (`code: message`) is an instruction, never a stale read, and treating it
 * as one (r4) wiped the edit on every save and never showed the instruction.
 */
export function cascadeSaveConflict(body: unknown): { kind: 'message'; message: string } | { kind: 'stale' } {
  const error = body && typeof body === 'object' && 'error' in body ? (body as { error?: unknown }).error : undefined
  if (typeof error !== 'string') return { kind: 'stale' }
  if (/^[a-z][a-z0-9-]*: /.test(error)) return { kind: 'message', message: error }
  return { kind: 'stale' }
}

/**
 * The Models tab body: the cascade editor decorated with per-row status,
 * plus the saved-cascade library. Rows are the CHAIN from GET /models —
 * the primary (model.provider / model.default) first, then the
 * fallback_providers rows — so row 1 is the primary by construction and
 * every status source below (tracking, retired, successors) keys on it too.
 *
 * Status sources (all fail-soft — a missing source means no decoration):
 *  - tracking:   harness.modelTracking, edited via PUT /api/harnesses/:id/models/tracking
 *  - retired:    GET /api/models/live?provider=… per trackable provider in the
 *                cascade (204 = no live info = nothing flagged)
 *  - successors: GET /api/fleet/model-updates, this harness's entries only;
 *                Update → POST /api/fleet/model-updates/apply (the route
 *                rewrites config.yaml and restarts — no client restart)
 */
export function ModelsTab({
  harnessId,
  modelConfig,
  modelTracking,
  onSave,
  saving,
  editorKey,
  onCascadeChanged,
}: {
  harnessId: string
  modelConfig: ModelConfig
  modelTracking?: Record<string, boolean>
  onSave: (entries: FallbackProviderEntry[]) => void
  saving: boolean
  /** Remount key for the editor (per harness + generation). */
  editorKey: string
  /** Something rewrote the cascade on disk (apply / update) — refetch. */
  onCascadeChanged: () => void
}) {
  const rows = useMemo(() => modelConfig.chain ?? [], [modelConfig.chain])

  // --- tracking ------------------------------------------------------------
  // Derived from the prop, with a local override that lives only as long as
  // the prop it was made against. An apply moves the tracking key
  // server-side and the page refetches the harness, and an in-app harness
  // switch reuses this mounted tab — a once-only useState seed kept showing
  // the pre-rotation (or the previous harness's) toggles.
  const [override, setOverride] = useState<{ harnessId: string; base: Record<string, boolean> | undefined; value: Record<string, boolean> } | null>(null)
  const tracking = override && override.harnessId === harnessId && override.base === modelTracking ? override.value : modelTracking ?? {}
  async function changeTracking(entry: FallbackProviderEntry, tracked: boolean) {
    const key = rowKey(entry)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/models/tracking`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: tracked }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : 'Failed to update tracking')
        return
      }
      setOverride({ harnessId, base: modelTracking, value: data.modelTracking ?? {} })
    } catch {
      toast.error('Failed to update tracking')
    }
  }

  // --- retired -------------------------------------------------------------
  const providers = useMemo(
    () => Array.from(new Set(rows.map((r) => r.provider.trim().toLowerCase()).filter(isTrackableProvider))),
    [rows],
  )
  const providersKey = providers.join(',')
  const [live, setLive] = useState<Record<string, LiveListLike>>({})
  useEffect(() => {
    let cancelled = false
    const list = providersKey ? providersKey.split(',') : []
    for (const provider of list) {
      fetch(`/api/models/live?provider=${encodeURIComponent(provider)}`)
        .then(async (res) => {
          if (res.status !== 200) return null
          const data = await res.json().catch(() => null)
          return data && Array.isArray(data.models) ? (data as LiveListLike) : null
        })
        .catch(() => null)
        .then((result) => {
          if (!cancelled) setLive((prev) => ({ ...prev, [provider]: result }))
        })
    }
    return () => { cancelled = true }
  }, [providersKey])
  const retiredKeys = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const list = live[r.provider.trim().toLowerCase()]
      if (list && isRetiredIn(list, r.model)) set.add(rowKey(r))
    }
    return set
  }, [rows, live])

  // --- successors ----------------------------------------------------------
  const { data: report, refetch: refetchReport } = useApi<ModelUpdateReport>('/api/fleet/model-updates')
  const successors = useMemo(() => {
    const mine = report?.harnesses?.find((h) => h.id === harnessId)
    const out: Record<string, string> = {}
    for (const e of mine?.entries ?? []) {
      if (e.successor && !e.applied) out[rowKey(e)] = e.successor
    }
    return out
  }, [report, harnessId])
  const [updatingKey, setUpdatingKey] = useState<string | null>(null)
  async function applyUpdate(entry: FallbackProviderEntry, to: string) {
    const key = rowKey(entry)
    setUpdatingKey(key)
    try {
      const res = await fetch('/api/fleet/model-updates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ harnessId, from: entry.model, to }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof data.error === 'string' ? data.error : 'Failed to apply update')
        return
      }
      toast.success(`Updated ${entry.model} → ${to} — restarting agent`)
      onCascadeChanged()
      refetchReport()
    } catch {
      toast.error('Failed to apply update')
    } finally {
      setUpdatingKey(null)
    }
  }

  return (
    <div className="space-y-4">
      <ModelCascadeEditor
        key={editorKey}
        models={modelConfig.models ?? []}
        provider={modelConfig.provider ?? ''}
        chain={rows}
        harnessId={harnessId}
        onSave={onSave}
        saving={saving}
        rowStatus={{
          tracking,
          onTrackingChange: changeTracking,
          retiredKeys,
          successors,
          onApplyUpdate: applyUpdate,
          updatingKey,
        }}
      />
      <SavedCascades harnessId={harnessId} onApplied={onCascadeChanged} />
    </div>
  )
}
