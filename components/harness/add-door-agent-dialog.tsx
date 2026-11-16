'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { DOOR_NAME_RULE, doorAgentName, doorNameProblem } from '@/lib/door-agent-name'
import { DEFAULT_HARNESS, harnessFacts, LAUNCHER_HARNESSES, type LauncherHarness } from '@/lib/lab/pi-discord/harnesses'

/** Where the steps that are done by hand are written down. */
export const DOOR_RUNBOOK = 'https://github.com/cyborg-garden/swarm-map/blob/main/docs/lab/pi-discord.md'

// One such dialog is on a page, so its title has a fixed id. Nothing is asked of React for the
// closed dialog: a page that draws it closed is, id for id, the page it was without it.
const TITLE_ID = 'add-door-agent-title'

type Props = {
  open: boolean
  /** Every agent in the fleet, so a name that is taken is said to be taken while it is typed. */
  agents: ReadonlyArray<{ id?: string; name?: string }>
  onClose: () => void
  /** Called with the new agent's id once the server has made it. */
  onCreated: (id: string) => void
}

/**
 * The form that makes a door agent: a name, a harness, and one line about
 * what it is for. It is a native <dialog>, like the app's confirm dialog, so
 * focus stays inside it and Escape closes it. Nothing is sent until the form
 * is submitted, and no secret is asked for here or anywhere on the page.
 *
 *  POST /api/harnesses/door   { name, runtime, description }
 */
export function AddDoorAgentDialog({ open, agents, onClose, onCreated }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (open) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      data-door-agent-form
      onClose={() => { if (open) onClose() }}
      aria-labelledby={open ? TITLE_ID : undefined}
      className="backdrop:bg-black/50 rounded-xl border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)] p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-xl"
    >
      {/* Mounted only while open, so the form is empty each time it is opened. */}
      {open && <AddDoorAgentForm agents={agents} onClose={onClose} onCreated={onCreated} />}
    </dialog>
  )
}

const inputClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm aria-invalid:border-red-600'

function AddDoorAgentForm({ agents, onClose, onCreated }: Omit<Props, 'open'>) {
  const ids = { intro: useId(), name: useId(), nameHint: useId(), nameStatus: useId(), harness: useId(), description: useId(), descriptionHint: useId() }
  const limitsId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const sending = useRef(false)

  const [name, setName] = useState('')
  const [runtime, setRuntime] = useState<LauncherHarness>(DEFAULT_HARNESS)
  const [description, setDescription] = useState('')
  // A name is not called wrong before anything has been typed or sent.
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)

  const problem = doorNameProblem(name, agents)
  const named = doorAgentName(name)
  const shown = touched ? problem : undefined

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (problem) { nameRef.current?.focus(); return }
    if (sending.current) return
    sending.current = true
    setBusy(true)
    setRefused(null)
    try {
      const res = await fetch('/api/harnesses/door', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), runtime, description: description.trim() }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || typeof body.id !== 'string') {
        setRefused(typeof body.error === 'string' ? body.error : 'The door agent could not be made')
        nameRef.current?.focus()
        return
      }
      onCreated(body.id)
    } catch {
      setRefused('The door agent could not be made. Swarm Map did not answer')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-describedby={ids.intro} className="space-y-4">
      <h2 id={TITLE_ID} className="text-lg font-semibold">Add a door agent</h2>
      <p id={ids.intro} className="text-sm text-muted-foreground">
        A door agent is one agent in a sealed cell: a container with no way out to the internet or to this machine.
        A small guard process beside it, the door, holds its Discord connection, its model key and its rules, so the agent never holds them.
      </p>

      <div className="space-y-1">
        <label htmlFor={ids.name} className="block text-sm">Name</label>
        <input
          ref={nameRef} id={ids.name} name="name" type="text" autoFocus autoComplete="off" spellCheck={false} maxLength={64}
          value={name}
          onChange={(e) => { setName(e.target.value); setTouched(true); setRefused(null) }}
          aria-invalid={shown ? true : undefined}
          aria-describedby={`${ids.nameHint} ${ids.nameStatus}`}
          className={inputClass}
        />
        <p id={ids.nameHint} className="text-xs text-muted-foreground">{DOOR_NAME_RULE}. It cannot be changed later.</p>
        {/* Read out when it changes, without interrupting: it changes as the name is typed. */}
        <p id={ids.nameStatus} aria-live="polite" className={`text-xs min-h-4 ${shown ? 'text-red-600' : 'text-muted-foreground'}`}>
          {shown ?? ('name' in named ? `It will be called ${named.name}.` : '')}
        </p>
      </div>

      <div role="radiogroup" aria-labelledby={ids.harness} className="space-y-2">
        <p id={ids.harness} className="text-sm">Harness</p>
        {LAUNCHER_HARNESSES.map((harness) => {
          const facts = harnessFacts(harness)
          const describedBy = `${limitsId}-${harness}`
          return (
            <div key={harness} className="rounded-md border border-[var(--border)] p-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="radio" name="runtime" value={harness} checked={runtime === harness}
                  onChange={() => setRuntime(harness)} aria-describedby={describedBy}
                />
                {facts.label} {facts.version}
              </label>
              <ul id={describedBy} className="mt-1 pl-6 list-disc text-xs text-muted-foreground space-y-0.5">
                {facts.limits.map((limit) => <li key={limit}>{limit}</li>)}
              </ul>
            </div>
          )
        })}
        <p className="text-xs text-muted-foreground">The harness cannot be changed later.</p>
      </div>

      <div className="space-y-1">
        <label htmlFor={ids.description} className="block text-sm">Description <span className="text-muted-foreground">(optional)</span></label>
        <input
          id={ids.description} name="description" type="text" autoComplete="off" maxLength={600}
          value={description} onChange={(e) => setDescription(e.target.value)}
          aria-describedby={ids.descriptionHint} className={inputClass}
        />
        <p id={ids.descriptionHint} className="text-xs text-muted-foreground">One line about what it is for. The agent is told it. It cannot give the agent an ability.</p>
      </div>

      <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-[var(--foreground)]">Two things are done by hand before it can start</p>
        <ol className="list-decimal pl-5 space-y-0.5">
          <li>Make a Discord application for its bot, and invite the bot to the one channel.</li>
          <li>Put the bot token and the model key in two secret files that only you can read. This page asks for their paths, never for what is in them.</li>
        </ol>
        <p>
          <a className="underline" href={DOOR_RUNBOOK} target="_blank" rel="noreferrer">The runbook</a> has the steps. Making the agent here starts nothing: its rules are filled in on the next page.
        </p>
      </div>

      {refused && <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{refused}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" aria-disabled={busy || undefined}>{busy ? 'Adding…' : 'Add door agent'}</Button>
      </div>
    </form>
  )
}
