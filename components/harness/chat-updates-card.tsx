// components/harness/chat-updates-card.tsx
'use client'

import { useState, useEffect } from 'react'
import { MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { CHAT_UPDATE_LEVELS, type ChatUpdateLevel } from '@/lib/chat-update-levels'
import type { ChatUpdateReading } from '@/lib/services/chat-updates'

const LABELS: Record<ChatUpdateLevel, { label: string; hint: string }> = {
  quiet: { label: 'Quiet', hint: 'Questions, approval prompts and final answers, plus rare notices such as a switch to a backup model or an error.' },
  some: { label: 'Some', hint: 'Also shows each new kind of step and short progress notes.' },
  all: { label: 'Everything', hint: 'Shows every step the agent takes.' },
}

type Props = { harnessId: string }

export function ChatUpdatesCard({ harnessId }: Props) {
  const [level, setLevel] = useState<ChatUpdateReading | undefined>(undefined)
  const [overridden, setOverridden] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`/api/harnesses/${harnessId}/chat-updates`)
      .then(res => res.json())
      .then(data => {
        setLevel(data.error ? undefined : data.level)
        setOverridden(Boolean(data.overridden))
      })
      .catch(() => setLevel(undefined))
  }, [harnessId])

  if (level === undefined) return null

  async function choose(next: ChatUpdateLevel) {
    const prev = level
    setLevel(next)
    setSaving(true)
    try {
      const res = await fetch(`/api/harnesses/${harnessId}/chat-updates`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level: next }),
      })
      const data = await res.json()
      if (res.ok) {
        if (!data.unchanged) toast.success('Saved — applies from the next message.')
        setOverridden(Boolean(data.overridden))
      } else {
        setLevel(prev)
        toast.error(data.error || 'Failed to save')
      }
    } catch {
      setLevel(prev)
      toast.error('Network error')
    } finally {
      setSaving(false)
    }
  }

  const note =
    level === 'unset'
      ? 'Not set, so Hermes uses its own defaults for each surface (every step on Discord). Pick one to set it.'
      : level === 'custom'
        ? 'Set by hand in config.yaml to a mix none of these match.'
        : LABELS[level].hint

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium text-sm">Chat updates</h3>
      </div>
      <div className="flex gap-3">
        {CHAT_UPDATE_LEVELS.map(l => (
          <label key={l} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name={`chatUpdates-${harnessId}`}
              checked={level === l}
              disabled={saving}
              onChange={() => choose(l)}
              className="accent-[var(--accent)]"
            />
            {LABELS[l].label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{note}</p>
      {overridden && (
        <p className="text-xs text-[var(--warning)]">
          This agent&apos;s config.yaml also has a per-surface setting (display.platforms or display.tool_progress_overrides), which wins on that surface. Remove it for this choice to apply everywhere.
        </p>
      )}
    </div>
  )
}
