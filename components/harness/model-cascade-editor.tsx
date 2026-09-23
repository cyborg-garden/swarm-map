'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import { isTrackableProvider, rowKey } from '@/lib/model-row-status'

export const MODEL_PROVIDERS = ['anthropic', 'openrouter', 'ollama', 'custom', 'gemini', 'nous', 'bedrock', 'zai'] as const

export type FallbackProviderEntry = { provider: string; model: string; base_url?: string }

/**
 * Optional per-row status the editor can decorate rows with. All keys are
 * rowKey(entry) = "provider/model". Everything is optional and absent means
 * "render nothing" — the editor never invents status.
 */
export type RowStatus = {
  /** "Track latest" flags (harness.modelTracking). */
  tracking?: Record<string, boolean>
  onTrackingChange?: (entry: FallbackProviderEntry, tracked: boolean) => void
  /** Rows whose id the provider's live list no longer serves. */
  retiredKeys?: ReadonlySet<string>
  /** Row → successor id from the fleet model-updates report. */
  successors?: Record<string, string>
  onApplyUpdate?: (entry: FallbackProviderEntry, to: string) => void
  /** Row whose Update is in flight. */
  updatingKey?: string | null
  /** Row → reason the fleet report blocked its successor (Update is disabled with it). */
  blocked?: Record<string, string>
}

/**
 * Build the cascade the editor should show for a given set of server props.
 *
 * Preference order:
 *   1. the chain from GET /models — the primary (model.provider /
 *      model.default) first, then every fallback_providers row, each with
 *      its own provider + base_url. Row 1 IS the primary by construction.
 *   2. string models stamped with the known model.provider.
 *   3. nothing. When the provider is unknown AND there is no chain we do NOT
 *      guess — a guessed provider was issue #149: rows seeded as `anthropic`
 *      before GET /models resolved, then saved back over real ollama rows.
 */
export function buildCascadeFromProps(
  models: string[],
  provider: string,
  chain: FallbackProviderEntry[]
): FallbackProviderEntry[] {
  if (chain.length > 0) {
    return chain.map((fp) => ({
      provider: fp.provider,
      model: fp.model,
      ...(fp.base_url ? { base_url: fp.base_url } : {}),
    }))
  }
  if (provider) {
    return models.map((m) => ({ provider, model: m }))
  }
  return []
}

export function ModelCascadeEditor({
  models: initialModels,
  provider: initialProvider,
  chain: initialChain,
  primaryEntry,
  onSave,
  saving,
  harnessId,
  rowStatus,
}: {
  models: string[]
  provider: string
  /** The chain from GET /models: primary first, then the fallbacks. */
  chain: FallbackProviderEntry[]
  /**
   * GET /models' primaryEntry: null when the file has rows but no primary
   * (no model.default). Row 1 is then a fallback, not the primary — it is
   * not badged, and a save says so explicitly (setPrimary) because it WILL
   * make row 1 the primary. Undefined = unknown (pre-load) = no note.
   */
  primaryEntry?: FallbackProviderEntry | null
  /**
   * Called with the edited chain: entries[0] is the primary, the rest are
   * the fallbacks. `setPrimary` is passed only from the no-primary state.
   */
  onSave: (entries: FallbackProviderEntry[], opts?: { setPrimary: true }) => void
  saving: boolean
  harnessId: string
  rowStatus?: RowStatus
}) {
  const built = buildCascadeFromProps(initialModels, initialProvider, initialChain)
  const builtKey = JSON.stringify(built)

  const [cascade, setCascade] = useState<FallbackProviderEntry[]>(built)
  // True once the user has changed the cascade. While false the editor mirrors
  // the server props (so late-arriving data replaces an empty/partial seed);
  // once true, props changes never clobber the user's edits.
  const [dirty, setDirty] = useState(false)
  const [newModel, setNewModel] = useState('')
  const [newProvider, setNewProvider] = useState<string>('anthropic')
  const [newBaseUrl, setNewBaseUrl] = useState('')
  const [suggesting, setSuggesting] = useState(false)

  function edit(next: FallbackProviderEntry[]) {
    setCascade(next)
    setDirty(true)
  }

  async function suggestFromKeys() {
    setSuggesting(true)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/models/suggest`)
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load suggestions')
        return
      }
      if (!data.suggested?.length) {
        toast.info('No API keys detected — add keys to .env first')
        return
      }
      const newEntries: FallbackProviderEntry[] = data.suggested.map((s: { provider: string; model: string; base_url?: string }) => ({
        provider: s.provider === 'ollama' ? 'ollama' : s.provider,
        model: s.model,
        ...(s.base_url ? { base_url: s.base_url } : {}),
      }))
      edit(newEntries)
      toast.success(`Suggested ${data.suggested.length} models from ${data.providers.length} provider${data.providers.length === 1 ? '' : 's'}`)
    } catch {
      toast.error('Failed to load suggestions')
    } finally {
      setSuggesting(false)
    }
  }

  // Sync with server props (React's "adjust state while rendering" pattern —
  // no effect, no extra committed frame). Untouched editor → mirror them; this
  // is how the real rows replace a pre-load seed. Touched editor → leave the
  // user's edits alone, but if the server now matches what they have (their
  // save landed and was refetched) they are no longer dirty.
  const [seededKey, setSeededKey] = useState(builtKey)
  if (seededKey !== builtKey) {
    setSeededKey(builtKey)
    if (!dirty) setCascade(built)
    else if (builtKey === JSON.stringify(cascade)) setDirty(false)
  }

  const showBaseUrl = newProvider === 'ollama' || newProvider === 'custom'

  function addModel() {
    const m = newModel.trim()
    if (!m || !newProvider) return
    if (cascade.some((e) => e.model === m && e.provider === newProvider)) return
    const entry: FallbackProviderEntry = { provider: newProvider, model: m }
    if (showBaseUrl && newBaseUrl.trim()) {
      entry.base_url = newBaseUrl.trim()
    }
    edit([...cascade, entry])
    setNewModel('')
    setNewBaseUrl('')
  }

  function removeModel(index: number) {
    edit(cascade.filter((_, i) => i !== index))
  }

  function moveUp(index: number) {
    if (index === 0) return
    const next = [...cascade]
    ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
    edit(next)
  }

  function moveDown(index: number) {
    if (index >= cascade.length - 1) return
    const next = [...cascade]
    ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
    edit(next)
  }

  const isDirty = JSON.stringify(cascade) !== builtKey
  const noPrimaryOnDisk = primaryEntry === null && cascade.length > 0
  const save = () => (noPrimaryOnDisk ? onSave(cascade, { setPrimary: true }) : onSave(cascade))

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-sm">Model Cascade</h3>
          <div className="flex items-center gap-3">
            <button
              onClick={suggestFromKeys}
              disabled={suggesting}
              className="text-xs text-[var(--accent)] hover:underline disabled:opacity-50"
            >
              {suggesting ? 'Detecting...' : 'Suggest from connected keys'}
            </button>
            <span className="text-xs text-muted-foreground" title="Row 1 is written to model.default; the rest are the fallback_providers rows, tried in order">Row 1 is the primary; fallbacks follow in order</span>
          </div>
        </div>

        {cascade.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No models configured. Add one below.</p>
        ) : (
          <div className="space-y-1">
            {cascade.map((entry, i) => {
              const key = rowKey(entry)
              const trackable = !!rowStatus?.onTrackingChange && isTrackableProvider(entry.provider)
              const retired = rowStatus?.retiredKeys?.has(key) ?? false
              const successor = rowStatus?.successors?.[key]
              const updating = rowStatus?.updatingKey === key
              const blockedReason = rowStatus?.blocked?.[key]
              return (
              <div
                key={`${entry.provider}-${entry.model}-${i}`}
                data-row={key}
                className={`flex items-center gap-2 p-2 rounded-md border ${i === 0 ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-[var(--border)]'}`}
              >
                <span className="text-xs text-muted-foreground w-5 text-center font-medium">
                  {i + 1}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono truncate">{entry.model}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium uppercase tracking-wide shrink-0">
                      {entry.provider}
                    </span>
                    {i === 0 && !noPrimaryOnDisk && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)] font-medium uppercase tracking-wide shrink-0"
                        title="Written to model.provider / model.default — the model the agent tries first"
                      >
                        primary
                      </span>
                    )}
                    {i === 0 && noPrimaryOnDisk && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--warning)]/15 text-[var(--warning)] font-medium shrink-0"
                        title="config.yaml has fallback rows but no model.default, so the agent runs on its own built-in default; this row is a fallback today. Saving writes it to model.default."
                      >
                        no primary on disk — save will make this the primary
                      </span>
                    )}
                    {retired && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--danger)]/10 text-[var(--danger)] font-medium uppercase tracking-wide shrink-0"
                        title="The provider no longer serves this model id"
                      >
                        retired
                      </span>
                    )}
                  </div>
                  {entry.base_url && (
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                      {entry.base_url}
                    </p>
                  )}
                  {successor && (
                    <p className="text-[11px] mt-0.5 flex items-center gap-2 min-w-0">
                      <span className="text-[var(--warning)] font-mono truncate">{`newer: ${successor}`}</span>
                      {rowStatus?.onApplyUpdate && (
                        <button
                          type="button"
                          onClick={() => rowStatus.onApplyUpdate?.(entry, successor)}
                          disabled={updating || isDirty || !!blockedReason}
                          aria-label={updating ? `Updating ${entry.model}` : `Update ${entry.model} to ${successor}`}
                          title={blockedReason ? `Blocked: ${blockedReason}` : isDirty ? 'Save the cascade first' : `Replace ${entry.model} with ${successor} and restart`}
                          className="text-[11px] text-[var(--accent)] hover:underline disabled:opacity-50 disabled:no-underline shrink-0"
                        >
                          {updating ? 'Updating…' : 'Update'}
                        </button>
                      )}
                    </p>
                  )}
                </div>
                {trackable && (
                  <label
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground shrink-0"
                    title={isDirty ? 'Save the cascade first' : 'Let the model-update scheduler follow the newest version of this model'}
                  >
                    <span className="hidden sm:inline">Track latest</span>
                    <Switch
                      checked={rowStatus?.tracking?.[key] === true}
                      onCheckedChange={(v) => rowStatus?.onTrackingChange?.(entry, v)}
                      disabled={isDirty}
                      aria-label={`Track latest for ${entry.model}`}
                      className="scale-75"
                    />
                  </label>
                )}
                <div className="flex gap-0.5 shrink-0">
                  <button
                    onClick={() => moveUp(i)}
                    disabled={i === 0}
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-muted disabled:opacity-30"
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => moveDown(i)}
                    disabled={i >= cascade.length - 1}
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-muted disabled:opacity-30"
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => removeModel(i)}
                    className="text-xs px-1.5 py-0.5 rounded hover:bg-[var(--danger)]/10 text-[var(--danger)]"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              </div>
              )
            })}
          </div>
        )}

        {/* Add model */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <select
              value={newProvider}
              onChange={(e) => setNewProvider(e.target.value)}
              className="text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--bg)] w-36"
            >
              {MODEL_PROVIDERS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
            <input
              type="text"
              value={newModel}
              onChange={(e) => setNewModel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !showBaseUrl && addModel()}
              placeholder="Model name (e.g. claude-sonnet-4-6)"
              className="flex-1 text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--bg)] font-mono"
            />
            <Button size="sm" variant="outline" onClick={addModel} disabled={!newModel.trim()}>
              Add
            </Button>
          </div>
          {showBaseUrl && (
            <input
              type="text"
              value={newBaseUrl}
              onChange={(e) => setNewBaseUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addModel()}
              placeholder="Base URL (e.g. http://host.docker.internal:11434/v1)"
              className="w-full text-sm border border-[var(--border)] rounded-md px-2 py-1.5 bg-[var(--bg)] font-mono"
            />
          )}
        </div>

        {isDirty && (
          <Button size="sm" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save Cascade'}
          </Button>
        )}
      </div>
    </div>
  )
}
