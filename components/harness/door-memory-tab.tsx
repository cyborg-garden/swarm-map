'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { Button } from '@/components/ui/button'
import { useApi } from '@/lib/hooks/use-api'
import type { DoorMemoryView } from '@/lib/services/door-agents'

/**
 * The Memory tab of a door agent: the notes the door keeps for each room, and
 * a kept scratch folder. View, edit, wipe and download. What the page is sent
 * is redacted by the server, so a secret is never drawn here, and an edit is
 * checked by the same rules the door holds the agent to.
 *
 *  GET    /api/harnesses/:id/door/memory
 *  PUT    /api/harnesses/:id/door/memory            { room, files }
 *  DELETE /api/harnesses/:id/door/memory?room=…     one room
 *  DELETE /api/harnesses/:id/door/memory?all=notes  every room
 *  DELETE /api/harnesses/:id/door/memory?all=scratch
 *  GET    /api/harnesses/:id/door/memory/download   one Markdown file
 */

const FILES = [
  { key: 'room', label: 'About this room', hint: 'Shared: anyone the agent talks to here may be told these.' },
  { key: 'people', label: 'People who asked to be remembered', hint: 'One line each: "- [id] name: note". The agent only keeps one for a person who asked.' },
  { key: 'threads', label: 'Ongoing threads', hint: 'What is still going on.' },
] as const
type FileKey = (typeof FILES)[number]['key']

type Wipe = { what: 'room'; room: string } | { what: 'notes' } | { what: 'scratch' }

export function DoorMemoryTab({ id, name }: { id: string; name: string }) {
  const { data, loading, refetch } = useApi<DoorMemoryView>(`/api/harnesses/${id}/door/memory`)
  const [asking, setAsking] = useState<Wipe | null>(null)
  const [problems, setProblems] = useState<string[]>([])

  async function call(method: 'PUT' | 'DELETE', query: string, body?: unknown, done?: string): Promise<boolean> {
    setProblems([])
    try {
      const res = await fetch(`/api/harnesses/${id}/door/memory${query}`, {
        method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error ?? 'That did not work')
        setProblems(Array.isArray(json.details) ? json.details : [])
        return false
      }
      if (done) toast.success(done)
      return true
    } catch {
      toast.error('That did not work')
      return false
    } finally {
      refetch()
    }
  }

  if (!data) return <p className="text-muted-foreground">{loading ? 'Loading...' : 'The notes could not be read.'}</p>

  const wipeText = (w: Wipe): { title: string; description: string } => (
    w.what === 'room' ? { title: 'Wipe this room\'s notes?', description: 'The files are removed now. If the agent is running, its conversation in that room starts again without them.' }
      : w.what === 'notes' ? { title: `Wipe every note ${name} keeps?`, description: 'Every room\'s notes are removed now. This cannot be undone. Download them first if you want a copy.' }
        : { title: 'Wipe the kept scratch folder?', description: 'The kept copy is removed now, and the folder starts empty next time.' }
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <a className="text-sm px-3 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-muted" href={`/api/harnesses/${id}/door/memory/download`} download>
          Download notes
        </a>
        <Button variant="outline" size="sm" disabled={data.rooms.length === 0} onClick={() => setAsking({ what: 'notes' })} className="text-destructive border-destructive/30 hover:bg-destructive/10">
          Wipe all notes
        </Button>
        <span className="text-xs text-muted-foreground">
          {data.notes
            ? 'The door keeps these on this machine, for each room, and gives them to the agent when a conversation starts. Secret-shaped text is never shown here.'
            : 'Notes are off for this agent. Switch them on under Memory on the Rules tab. Notes kept before are still here until you wipe them.'}
        </span>
      </div>

      {problems.length > 0 && (
        <ul role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 list-disc pl-6 font-mono">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      {data.rooms.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : data.rooms.map((room) => (
        <RoomNotes
          key={`${room.key} ${JSON.stringify(room.files)}`} room={room} limit={data.limits.fileBytes}
          onSave={(files) => call('PUT', '', { room: room.key, files }, 'Notes saved')}
          onWipe={() => setAsking({ what: 'room', room: room.key })}
        />
      ))}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-2">
        <h3 className="font-medium text-sm">Kept scratch folder</h3>
        {data.scratch === null ? (
          <p className="text-sm text-muted-foreground">Nothing is kept.</p>
        ) : (
          <>
            <p className="text-sm">{(data.scratch.bytes / 1024).toFixed(1)} KB, kept {new Date(data.scratch.savedAt).toLocaleString()}.{data.scratch.kept ? '' : ' Keeping is off now, so it is not put back.'}</p>
            <Button variant="outline" size="sm" disabled={data.running} onClick={() => setAsking({ what: 'scratch' })} className="text-destructive border-destructive/30 hover:bg-destructive/10">
              Wipe scratch folder
            </Button>
            {data.running && <p className="text-xs text-muted-foreground">Stop the agent first: its folder is kept again when it stops.</p>}
          </>
        )}
      </div>

      <ConfirmDialog
        open={asking !== null}
        title={asking ? wipeText(asking).title : ''}
        description={asking ? wipeText(asking).description : ''}
        confirmLabel="Wipe"
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const w = asking
          setAsking(null)
          if (!w) return
          void call('DELETE', w.what === 'room' ? `?room=${encodeURIComponent(w.room)}` : `?all=${w.what}`, undefined, 'Wiped')
        }}
      />
    </div>
  )
}

function RoomNotes({ room, limit, onSave, onWipe }: {
  room: DoorMemoryView['rooms'][number]; limit: number
  onSave: (files: Record<FileKey, string>) => Promise<boolean>
  onWipe: () => void
}) {
  const [draft, setDraft] = useState<Record<FileKey, string>>({ room: room.files.room, people: room.files.people, threads: room.files.threads })
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  return (
    <section aria-label={`Notes for ${room.key}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-sm">Room <span className="font-mono text-xs">{room.key}</span></h3>
        <div className="flex gap-2">
          <Button size="sm" disabled={!dirty || saving} onClick={async () => { setSaving(true); if (await onSave(draft)) setDirty(false); setSaving(false) }}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="outline" size="sm" onClick={onWipe} className="text-destructive border-destructive/30 hover:bg-destructive/10">Wipe room</Button>
        </div>
      </div>
      {FILES.map((f) => (
        <label key={f.key} className="block space-y-1">
          <span className="text-sm">{f.label}</span>
          <textarea
            aria-label={`${f.label}, ${room.key}`} rows={4} value={draft[f.key]}
            onChange={(e) => { setDraft({ ...draft, [f.key]: e.target.value }); setDirty(true) }}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 font-mono text-xs"
          />
          <span className="block text-xs text-muted-foreground">{f.hint} Up to {limit} bytes.</span>
        </label>
      ))}
    </section>
  )
}
