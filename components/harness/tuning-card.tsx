// components/harness/tuning-card.tsx
'use client'

import { useState, useEffect } from 'react'
import { Brain, Loader2, Save, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import type { TuningKey, TuningSpec, TuningValues } from '@/lib/services/tuning-writer'

const LABELS: Record<TuningKey, { label: string; hint: string }> = {
  memoryCharLimit: { label: 'Memory length (chars)', hint: 'Notes the agent keeps about the world. ~2.75 chars per token, loaded every turn.' },
  userCharLimit: { label: 'User profile length (chars)', hint: 'What it remembers about the people it talks to.' },
  maxTurns: { label: 'Max tool turns', hint: 'Tool calls allowed per message before it stops.' },
  compressionThreshold: { label: 'Compress at (fraction of context)', hint: 'When the conversation is summarised. Higher keeps more raw history.' },
  protectLastN: { label: 'Keep last N messages', hint: 'Recent messages never summarised away.' },
}

type Props = { harnessId: string }

export function TuningCard({ harnessId }: Props) {
  const [spec, setSpec] = useState<TuningSpec[]>([])
  const [loaded, setLoaded] = useState<TuningValues | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)

  function load() {
    fetch(`/api/harnesses/${harnessId}/tuning`)
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          setError(data.error)
          return
        }
        setSpec(data.spec)
        setLoaded(data.values)
        setDraft(Object.fromEntries(Object.entries(data.values as TuningValues).map(([k, v]) => [k, v === null ? '' : String(v)])))
      })
      .catch(() => setError('Failed to load'))
  }

  useEffect(load, [harnessId])

  if (error) return null
  if (!loaded) return null

  // Only fields the operator actually changed are sent. Clearing a field
  // that has a value in the file sends null: the key is removed and the
  // runtime default applies — what the "(default)" placeholder promises.
  const edits = Object.fromEntries(
    spec.flatMap((s): Array<[TuningKey, number | null]> => {
      const raw = (draft[s.id] ?? '').trim()
      if (raw === '') return loaded[s.id] === null ? [] : [[s.id, null]]
      const n = Number(raw)
      return n === loaded[s.id] ? [] : [[s.id, n]]
    })
  )
  const dirty = Object.keys(edits).length > 0

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/tuning`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: edits, expected: loaded }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success(data.unchanged ? 'No changes.' : 'Saved — restart to apply.')
        setSaved(!data.unchanged)
        load()
      } else {
        toast.error(data.error || 'Failed to save')
        if (res.status === 409) load()
      }
    } catch {
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  async function handleRestart() {
    setRestarting(true)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/restart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'quick' }),
      })
      const data = await res.json()
      if (res.ok) {
        toast.success('Harness restarted')
        setSaved(false)
      } else {
        toast.error(data.error || 'Restart failed')
      }
    } catch {
      toast.error('Restart failed')
    } finally {
      setRestarting(false)
    }
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Memory &amp; Context</h3>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {spec.map(s => (
          <label key={s.id} className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">{LABELS[s.id].label}</span>
            <input
              type="number"
              inputMode="decimal"
              min={s.min}
              max={s.max}
              step={s.integer ? 1 : 0.05}
              value={draft[s.id] ?? ''}
              placeholder={`${s.runtimeDefault} (default)`}
              onChange={(e) => {
                setDraft({ ...draft, [s.id]: e.target.value })
                setSaved(false)
              }}
              className="w-40 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm"
            />
            <span className="text-xs text-muted-foreground">
              {LABELS[s.id].hint} Range {s.min}–{s.max}.
            </span>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Written to this agent&apos;s config.yaml. Blank means the runtime default. Takes effect after a restart.
      </p>
      {(dirty || saved) && (
        <div className="flex justify-end gap-2">
          {dirty && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
          )}
          {saved && !dirty && (
            <button
              onClick={handleRestart}
              disabled={restarting}
              className="flex items-center gap-2 px-4 py-2 text-sm rounded-md border border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--surface)] disabled:opacity-50"
            >
              {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              Restart to apply
            </button>
          )}
        </div>
      )}
    </div>
  )
}
