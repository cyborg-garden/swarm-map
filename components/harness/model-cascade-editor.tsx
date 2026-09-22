'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

export const MODEL_PROVIDERS = ['anthropic', 'openrouter', 'ollama', 'custom', 'gemini', 'nous', 'bedrock', 'zai'] as const

export type FallbackProviderEntry = { provider: string; model: string; base_url?: string }

/**
 * Build the cascade the editor should show for a given set of server props.
 *
 * Preference order:
 *   1. fallback_providers rows — they carry provider + base_url per row.
 *   2. string models stamped with the known model.provider.
 *   3. nothing. When the provider is unknown AND there are no rows we do NOT
 *      guess — a guessed provider was issue #149: rows seeded as `anthropic`
 *      before GET /models resolved, then saved back over real ollama rows.
 */
export function buildCascadeFromProps(
  models: string[],
  provider: string,
  fallbackProviders: FallbackProviderEntry[]
): FallbackProviderEntry[] {
  if (fallbackProviders.length > 0) {
    return fallbackProviders.map((fp) => ({
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
  fallbackProviders: initialFallbackProviders,
  onSave,
  saving,
  harnessId,
}: {
  models: string[]
  provider: string
  fallbackProviders: FallbackProviderEntry[]
  onSave: (entries: FallbackProviderEntry[]) => void
  saving: boolean
  harnessId: string
}) {
  const built = buildCascadeFromProps(initialModels, initialProvider, initialFallbackProviders)
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
            <span className="text-xs text-muted-foreground">Primary at top, fallbacks below</span>
          </div>
        </div>

        {cascade.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No models configured. Add one below.</p>
        ) : (
          <div className="space-y-1">
            {cascade.map((entry, i) => (
              <div
                key={`${entry.provider}-${entry.model}-${i}`}
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
                  </div>
                  {entry.base_url && (
                    <p className="text-[11px] font-mono text-muted-foreground mt-0.5 truncate">
                      {entry.base_url}
                    </p>
                  )}
                </div>
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
            ))}
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
          <Button size="sm" onClick={() => onSave(cascade)} disabled={saving}>
            {saving ? 'Saving...' : 'Save Cascade'}
          </Button>
        )}
      </div>
    </div>
  )
}
