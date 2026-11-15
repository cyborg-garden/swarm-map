'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useApi } from '@/lib/hooks/use-api'
import { TierMix } from '@/components/shared/tier-mix'
import { StatusDot } from '@/components/shared/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { filterKeys } from '@/lib/keys-filter'
import { parseKeyRequestParams } from '@/lib/keys-request'
import { providerOptions } from '@/lib/key-providers'
import { BUDGET_HINT, BUDGET_LABEL } from '@/lib/budget-copy'
import { failedRestarts, restartFailureMessage } from '@/lib/restart-outcome'
import type { Key, Harness } from '@/lib/types'
import type { HabitatTier, HarnessStatus } from '@/lib/types'

function keyHealthToStatus(health: Key['health']): HarnessStatus {
  if (health === 'good') return 'running'
  if (health === 'warning') return 'idle'
  return 'error'
}

function KeysPageContent() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { data: keys, loading, refetch } = useApi<Key[]>('/api/keys')
  const { data: harnesses } = useApi<Harness[]>('/api/harnesses')

  // Search/filter state
  const [query, setQuery] = useState('')

  // Add key form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [newProvider, setNewProvider] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newBudget, setNewBudget] = useState('')
  const [newName, setNewName] = useState('')
  const [newEnvVar, setNewEnvVar] = useState('')
  const [newIdentifier, setNewIdentifier] = useState('')
  const [newAssignedTo, setNewAssignedTo] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  // Edit state — keyed by key id
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBudget, setEditBudget] = useState('')
  const [editValue, setEditValue] = useState('')
  const [editName, setEditName] = useState('')
  const [editAssignedTo, setEditAssignedTo] = useState<string[]>([])

  // Delete confirmation state
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Credential-request prefill (?request=hedra&assign=h_mare&name=...) — intent
  // only, applied once; the operator still pastes the secret value themselves.
  const prefillApplied = useRef(false)
  useEffect(() => {
    if (prefillApplied.current) return
    // Wait for the harness list before applying assignments so unknown ids are dropped.
    if (searchParams.get('assign') && !harnesses) return
    const prefill = parseKeyRequestParams(searchParams, harnesses?.map((h) => h.id))
    if (!prefill) return
    prefillApplied.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time sync of URL intent into form state
    setShowAddForm(true)
    setNewProvider(prefill.provider)
    setNewAssignedTo(prefill.assignTo)
    if (prefill.name) setNewName(prefill.name)
    if (prefill.identifier) setNewIdentifier(prefill.identifier)
  }, [searchParams, harnesses])

  function harnessNames(ids: string[]): string {
    if (!harnesses) return ids.join(', ')
    return ids.map((id) => harnesses.find((h) => h.id === id)?.name ?? id).join(', ')
  }

  const filteredKeys = filterKeys(keys, query, harnessNames)

  function tierMixForKey(key: Key): HabitatTier[] {
    if (!harnesses) return []
    const assigned = harnesses.filter((h) => key.assignedTo.includes(h.id))
    return [...new Set(assigned.map((h) => h.tier))] as HabitatTier[]
  }

  function touchesPublic(key: Key): boolean {
    return tierMixForKey(key).includes('public')
  }

  function resetAddForm() {
    setShowAddForm(false)
    setNewProvider('')
    setNewValue('')
    setNewBudget('')
    setNewName('')
    setNewEnvVar('')
    setNewIdentifier('')
    setNewAssignedTo([])
  }

  async function addKey() {
    if (!newProvider || !newValue) return
    setSaving(true)
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: newProvider,
          value: newValue,
          ...(newName ? { name: newName } : {}),
          ...(newEnvVar && newProvider === 'custom' ? { envVar: newEnvVar } : {}),
          ...(newIdentifier && newProvider === 'bluesky' ? { identifier: newIdentifier.trim() } : {}),
          ...(newBudget ? { budgetUsd: parseFloat(newBudget) } : {}),
          ...(newAssignedTo.length ? { assignedTo: newAssignedTo } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to add key')
        return
      }
      const addWarning = restartFailureMessage('Key added', failedRestarts(await res.json().catch(() => null)), (h) => harnessNames([h]))
      if (addWarning) toast.error(addWarning)
      else toast.success(`${newProvider} key added`)
      resetAddForm()
      // Drop prefill params so a refresh doesn't re-open the form.
      if (searchParams.has('request')) router.replace(pathname)
      refetch()
    } catch {
      toast.error('Failed to add key')
    } finally {
      setSaving(false)
    }
  }

  function startEdit(key: Key) {
    setEditingId(key.id)
    setEditBudget(key.budgetUsd != null ? String(key.budgetUsd) : '')
    setEditValue('')
    setEditName(key.name ?? '')
    setEditAssignedTo([...key.assignedTo])
  }

  function cancelEdit() {
    setEditingId(null)
    setEditBudget('')
    setEditValue('')
    setEditName('')
    setEditAssignedTo([])
  }

  async function saveEdit(keyId: string) {
    setSaving(true)
    try {
      const payload: Record<string, unknown> = {
        budgetUsd: editBudget ? parseFloat(editBudget) : null,
        assignedTo: editAssignedTo,
        ...(editName !== undefined ? { name: editName || undefined } : {}),
      }
      // Include value rotation if provided (min 8 chars to avoid autofill)
      if (editValue && editValue.trim().length >= 8) {
        payload.value = editValue.trim()
      }

      const res = await fetch(`/api/keys/${keyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Failed to update key')
        return
      }
      const editWarning = restartFailureMessage(payload.value ? 'Key rotated' : 'Key updated', failedRestarts(await res.json().catch(() => null)), (h) => harnessNames([h]))
      if (editWarning) toast.error(editWarning)
      else toast.success(payload.value ? 'Key rotated & updated across all harnesses' : 'Key updated')
      cancelEdit()
      refetch()
    } catch {
      toast.error('Failed to update key')
    } finally {
      setSaving(false)
    }
  }

  async function deleteKey(keyId: string) {
    setSaving(true)
    const key = keys?.find((k) => k.id === keyId)
    const affected = key?.assignedTo.length ?? 0
    try {
      const res = await fetch(`/api/keys/${keyId}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error('Failed to delete key')
        return
      }
      toast.success(`${key?.provider ?? 'Key'} key deleted everywhere — secret destroyed, stripped from ${affected} agent${affected === 1 ? '' : 's'}`)
      setConfirmDeleteId(null)
      refetch()
    } catch {
      toast.error('Failed to delete key')
    } finally {
      setSaving(false)
    }
  }

  function checkDuplicateProvider(harnessId: string, provider: string, currentKeyId?: string) {
    if (!keys) return
    const otherKeysOnHarness = keys.filter(
      (k) => k.id !== currentKeyId && k.provider === provider && k.assignedTo.includes(harnessId)
    )
    if (otherKeysOnHarness.length > 0) {
      toast.warning(`Warning: this harness already has a ${provider} key — the new one will overwrite it in .env`)
    }
  }

  function toggleHarness(harnessId: string, list: string[], setList: (v: string[]) => void, provider?: string, currentKeyId?: string) {
    if (list.includes(harnessId)) {
      setList(list.filter((h) => h !== harnessId))
    } else {
      if (provider) {
        checkDuplicateProvider(harnessId, provider, currentKeyId)
      }
      setList([...list, harnessId])
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold">Keys</h2>
        <div className="flex items-center gap-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keys..."
            aria-label="Search keys"
            className="w-56 rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm"
          />
          {keys && <span className="text-sm text-muted-foreground">{filteredKeys.length} keys</span>}
          <Button size="sm" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? 'Cancel' : '+ Add Key'}
          </Button>
        </div>
      </div>

      {/* Add Key Form */}
      {showAddForm && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 mb-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Provider</label>
              <select
                value={newProvider}
                onChange={(e) => {
                  setNewProvider(e.target.value)
                  if (e.target.value !== 'custom') setNewEnvVar('')
                  if (e.target.value !== 'bluesky') setNewIdentifier('')
                }}
                className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm"
              >
                <option value="">Select provider...</option>
                {providerOptions(newProvider).map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Name (optional)</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Team Key"
                className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm"
              />
            </div>
            {newProvider === 'bluesky' && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Account handle</label>
                <input
                  type="text"
                  value={newIdentifier}
                  onChange={(e) => setNewIdentifier(e.target.value)}
                  placeholder="e.g. nimbleco.ai — written as BLUESKY_IDENTIFIER"
                  className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm font-mono"
                />
              </div>
            )}
            {newProvider === 'custom' && (
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">Env var (optional)</label>
                <input
                  type="text"
                  value={newEnvVar}
                  onChange={(e) => setNewEnvVar(e.target.value)}
                  placeholder="e.g. CAPSOLVER_API_KEY — else derived from name"
                  className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm font-mono"
                />
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">API Key</label>
              <input
                type="password" autoComplete="off"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="sk-..."
                className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm font-mono"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block" title={BUDGET_HINT}>{BUDGET_LABEL}</label>
              <input
                type="number"
                value={newBudget}
                onChange={(e) => setNewBudget(e.target.value)}
                placeholder="Optional"
                className="w-full rounded-md border border-[var(--border)] bg-background px-3 py-1.5 text-sm"
              />
            </div>
          </div>
          {harnesses && harnesses.length > 0 && (
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Assign to harnesses</label>
              <div className="flex flex-wrap gap-2">
                {harnesses.map((h) => (
                  <label key={h.id} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newAssignedTo.includes(h.id)}
                      onChange={() => toggleHarness(h.id, newAssignedTo, setNewAssignedTo, newProvider)}
                      className="rounded"
                    />
                    {h.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={addKey} disabled={saving || !newProvider || !newValue || (newProvider === 'bluesky' && !newIdentifier.trim())}>
              {saving ? 'Adding...' : 'Add Key'}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetAddForm}>Cancel</Button>
          </div>
        </div>
      )}

      {loading && <p className="text-muted-foreground">Loading...</p>}

      {!loading && keys && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                <th className="text-left px-4 py-3">Provider</th>
                <th className="text-left px-4 py-3">Key</th>
                <th className="text-left px-4 py-3">Assigned To</th>
                <th className="text-left px-4 py-3">Tier Mix</th>
                <th className="text-right px-4 py-3" title={BUDGET_HINT}>{BUDGET_LABEL}</th>
                <th className="text-left px-4 py-3">Health</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredKeys.map((k) => (
                editingId === k.id ? (
                  // Editing row
                  <tr key={k.id} className="border-b border-[var(--border)] last:border-0 bg-muted/20">
                    <td className="px-4 py-3">
                      <span className="font-medium">{k.provider}</span>
                      <div className="mt-1">
                        <label className="text-[10px] text-muted-foreground uppercase tracking-wide">Display name</label>
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          placeholder="e.g. Team Key, Personal"
                          className="w-full text-xs border border-[var(--border)] rounded px-2 py-1 bg-[var(--bg)]"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <p className="font-mono text-xs text-muted-foreground">{k.maskedValue}</p>
                        <input
                          type="password" autoComplete="off"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          placeholder="Paste new key to rotate..."
                          className="w-full text-xs font-mono border border-[var(--border)] rounded px-2 py-1 bg-[var(--bg)]"
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3" colSpan={1}>
                      <div className="flex flex-wrap gap-1.5">
                        {harnesses?.map((h) => (
                          <label key={h.id} className="flex items-center gap-1 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editAssignedTo.includes(h.id)}
                              onChange={() => toggleHarness(h.id, editAssignedTo, setEditAssignedTo, k.provider, k.id)}
                              className="rounded"
                            />
                            {h.name}
                          </label>
                        )) ?? null}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {tierMixForKey(k).length > 0 ? <TierMix tiers={tierMixForKey(k)} /> : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <input
                        type="number"
                        value={editBudget}
                        onChange={(e) => setEditBudget(e.target.value)}
                        placeholder="—"
                        className="w-20 rounded-md border border-[var(--border)] bg-background px-2 py-1 text-sm text-right"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={keyHealthToStatus(k.health)} />
                        <span className="text-xs capitalize">{k.health}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={cancelEdit} disabled={saving}>Cancel</Button>
                        <Button size="sm" onClick={() => saveEdit(k.id)} disabled={saving}>
                          {saving ? 'Saving...' : 'Save'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  // Display row
                  <tr
                    key={k.id}
                    className={`border-b border-[var(--border)] last:border-0 hover:bg-muted/30 transition-colors ${touchesPublic(k) ? 'ring-1 ring-[var(--warning)]/40' : ''}`}
                  >
                    <td className="px-4 py-3 font-medium">
                      {k.provider}{k.name ? <span className="text-muted-foreground font-normal"> — {k.name}</span> : null}
                      {k.identifier ? <span className="text-muted-foreground font-normal font-mono text-xs"> ({k.identifier})</span> : null}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{k.maskedValue}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs max-w-[200px] truncate">
                      {k.assignedTo.length > 0 ? harnessNames(k.assignedTo) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {tierMixForKey(k).length > 0 ? <TierMix tiers={tierMixForKey(k)} /> : <span className="text-muted-foreground text-xs">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {k.budgetUsd != null ? `$${k.budgetUsd}/mo` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={keyHealthToStatus(k.health)} />
                        <span className="text-xs capitalize">{k.health}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => startEdit(k)} disabled={editingId !== null}>
                          Edit
                        </Button>
                        {confirmDeleteId === k.id ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs text-[var(--destructive)] whitespace-nowrap">
                              Destroys the secret, strips {k.assignedTo.length} agent{k.assignedTo.length === 1 ? '' : 's'}. Irreversible.
                            </span>
                            <Button size="sm" variant="destructive" onClick={() => deleteKey(k.id)} disabled={saving}>
                              {saving ? '...' : 'Delete everywhere'}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)} disabled={saving}>
                              Cancel
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirmDeleteId(k.id)} title="Destroy this key everywhere — it will be stripped from every assigned agent">
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
          {filteredKeys.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">
              {keys.length === 0 ? 'No keys yet.' : `No keys match "${query}".`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function KeysPage() {
  return (
    <Suspense>
      <KeysPageContent />
    </Suspense>
  )
}
