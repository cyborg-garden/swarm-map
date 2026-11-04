'use client'

import { useState, useRef, useEffect } from 'react'
import { Pencil, Loader2, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { isSurfaceSlug } from '@/lib/surfaces/registry'
import { PLATFORM_CREDENTIAL_FIELDS } from './platform-ui'

type Props = {
  platform: string
  harnessId: string
  currentConfig: Record<string, string>
  open: boolean
  onClose: () => void
  onSaved: () => void
}

export function EditSurfaceDialog({ platform, harnessId, currentConfig, open, onClose, onSaved }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  const slug = platform.toLowerCase()
  const fields = isSurfaceSlug(slug) ? PLATFORM_CREDENTIAL_FIELDS[slug] : []

  useEffect(() => {
    if (open) {
      // Initialize form with current config values
      const initial: Record<string, string> = {}
      for (const field of fields) {
        initial[field.configKey] = currentConfig[field.configKey] || ''
      }
      setValues(initial)
      setError('')
      setDone(false)
      setLoading(false)
      dialogRef.current?.showModal()
    } else {
      dialogRef.current?.close()
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasChanges = fields.some(f => (values[f.configKey] || '') !== (currentConfig[f.configKey] || ''))
  const allFilled = fields.every(f => (values[f.configKey] || '').trim().length > 0)

  async function handleSave() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/surfaces/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: platform.toLowerCase(), config: values }),
      })
      const data = await res.json()

      if (data.success) {
        setDone(true)
        toast.success(`${platform} config updated`)
        if (data.warning) toast.warning(data.warning)
        onSaved()
      } else {
        setError(data.error || 'Failed to update')
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="backdrop:bg-black/50 rounded-xl border border-[var(--border)] bg-[var(--background)] p-6 w-full max-w-md shadow-xl"
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Pencil className="h-5 w-5 text-[var(--accent)]" />
          <h2 className="text-lg font-semibold">Edit {platform} Config</h2>
        </div>

        {!done ? (
          <div className="space-y-4">
            {fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="text-sm font-medium">{field.label}</label>
                <input
                  type="text"
                  value={values[field.configKey] || ''}
                  onChange={(e) => setValues(prev => ({ ...prev, [field.configKey]: e.target.value }))}
                  placeholder={field.placeholder}
                  className="w-full px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface)] text-sm font-mono"
                />
              </div>
            ))}

            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm rounded-md border border-[var(--border)] hover:bg-muted">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!hasChanges || !allFilled || loading}
                className="px-3 py-1.5 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-center py-4">
            <CheckCircle2 className="h-10 w-10 text-[var(--success)] mx-auto" />
            <p className="font-medium">Config updated!</p>
            <p className="text-sm text-muted-foreground">Restart the agent to apply changes.</p>
            <button onClick={onClose} className="px-4 py-2 text-sm rounded-md bg-[var(--accent)] text-white hover:opacity-90">
              Done
            </button>
          </div>
        )}
      </div>
    </dialog>
  )
}
