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
  fallbackProviders?: FallbackProviderEntry[]
}

/**
 * The Models tab body: the cascade editor decorated with per-row status,
 * plus the saved-cascade library.
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
  const rows = useMemo(() => modelConfig.fallbackProviders ?? [], [modelConfig.fallbackProviders])

  // --- tracking ------------------------------------------------------------
  const [tracking, setTracking] = useState<Record<string, boolean>>(modelTracking ?? {})
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
      setTracking(data.modelTracking ?? {})
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
        fallbackProviders={rows}
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
