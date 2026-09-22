'use client'

import { useState } from 'react'
import { useApi } from '@/lib/hooks/use-api'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import type { ModelAutoUpdateSettings } from '@/lib/types'

/**
 * The global model-auto-update policy (GET/PUT /api/settings/model-auto-update),
 * shared by the fleet dashboard card and the Settings page. Each control
 * sends a one-field patch; the server merges + validates and returns the
 * full policy, which replaces local state (a 400 leaves it untouched).
 */
export function useModelAutoUpdate() {
  const { data, loading, error, refetch } = useApi<ModelAutoUpdateSettings>('/api/settings/model-auto-update')
  const [local, setLocal] = useState<ModelAutoUpdateSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const settings = local ?? data

  async function update(patch: Partial<ModelAutoUpdateSettings>): Promise<boolean> {
    setSaving(true)
    try {
      const res = await fetch('/api/settings/model-auto-update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(typeof body.error === 'string' ? body.error : 'Failed to save model update policy')
        return false
      }
      setLocal(body as ModelAutoUpdateSettings)
      return true
    } catch {
      toast.error('Failed to save model update policy')
      return false
    } finally {
      setSaving(false)
    }
  }

  return { settings, loading, error, saving, update, refetch }
}

export function policyStatusLabel(s: ModelAutoUpdateSettings): string {
  if (!s.enabled) return 'Off — models stay pinned'
  return s.mode === 'apply' ? 'On — applies tracked updates' : 'On — notify only'
}

export function ModelAutoUpdateControls({
  settings,
  saving,
  update,
  idPrefix = 'model-auto-update',
}: {
  settings: ModelAutoUpdateSettings | null
  saving: boolean
  update: (patch: Partial<ModelAutoUpdateSettings>) => Promise<boolean>
  idPrefix?: string
}) {
  const [priceDraft, setPriceDraft] = useState<string | null>(null)

  if (!settings) return <p className="text-xs text-muted-foreground">Loading policy…</p>

  const priceValue = priceDraft ?? String(settings.maxPriceMultiplier)

  async function commitPrice() {
    if (priceDraft === null) return
    const n = Number(priceDraft)
    setPriceDraft(null)
    if (!settings || priceDraft.trim() === '' || n === settings.maxPriceMultiplier) return
    await update({ maxPriceMultiplier: n })
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">Automatic updates</p>
          <p className={`text-xs mt-0.5 ${settings.enabled ? 'text-[var(--success)]' : 'text-muted-foreground'}`}>
            {policyStatusLabel(settings)}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(v) => update({ enabled: v })}
          disabled={saving}
          aria-label="Automatic updates"
        />
      </div>

      {settings.enabled && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${idPrefix}-mode`} className="block text-xs text-muted-foreground mb-1">Mode</label>
            <select
              id={`${idPrefix}-mode`}
              value={settings.mode}
              onChange={(e) => update({ mode: e.target.value as ModelAutoUpdateSettings['mode'] })}
              disabled={saving}
              className="w-full text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--bg)]"
            >
              <option value="notify">Notify — report only</option>
              <option value="apply">Apply — rotate tracked models</option>
            </select>
          </div>
          <div>
            <label htmlFor={`${idPrefix}-price`} className="block text-xs text-muted-foreground mb-1">Price ceiling (× current)</label>
            <input
              id={`${idPrefix}-price`}
              type="number"
              inputMode="decimal"
              min="0.1"
              step="0.1"
              value={priceValue}
              onChange={(e) => setPriceDraft(e.target.value)}
              onBlur={commitPrice}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
              disabled={saving}
              className="w-full text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--bg)] font-mono"
            />
          </div>
          <p className="col-span-2 text-[11px] text-muted-foreground">
            A successor costing more than the ceiling × the current model is never applied. Checks run every {settings.intervalHours}h.
          </p>
        </div>
      )}
    </div>
  )
}
