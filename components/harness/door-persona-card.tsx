'use client'

import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import type { LabConfig } from '@/lib/lab/pi-discord/config'
import { PERSONA_DOC_MAX_BYTES, PERSONA_GUIDE } from '@/lib/lab/pi-discord/persona'

/**
 * The Persona card and the Memory card on a door agent's Rules tab.
 *
 * The persona is a name, one line, and a document in Markdown: who the agent
 * is and how it talks. The preview shows the document as the agent reads it.
 * What the agent can do is not written here: the launcher adds it after the
 * persona, from the rules, and the box below the preview shows that text as
 * it is now, with the rules as saved. Nothing typed here can change it.
 *
 * The Memory card switches the door's notes on or off, and whether the
 * scratch folder is kept after a stop. Both are decided by the launcher's
 * parser and by the door, never here.
 */

const box = 'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm'
const bytes = (s: string): number => new TextEncoder().encode(s).length

export function DoorPersonaCard({ rules, savedPrompt, onChange }: {
  rules: LabConfig
  /** What the agent is told now, from the saved rules. Null while they cannot be started. */
  savedPrompt: string | null
  onChange: (persona: LabConfig['persona']) => void
}) {
  const [preview, setPreview] = useState(false)
  const p = rules.persona
  const doc = p.document ?? ''
  const size = bytes(doc)
  const set = (patch: Partial<LabConfig['persona']>) => onChange({ ...p, ...patch })
  return (
    <div className="col-span-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <h3 className="font-medium text-sm">Persona</h3>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1">
          <span className="text-sm">Name</span>
          <input type="text" name="persona.name" value={p.name} onChange={(e) => set({ name: e.target.value })} className={box} />
        </label>
        <label className="block space-y-1">
          <span className="text-sm">Description</span>
          <input type="text" name="persona.description" value={p.description} onChange={(e) => set({ description: e.target.value })} className={box} />
          <span className="block text-xs text-muted-foreground">One line about what it is for. It cannot give the agent an ability.</span>
        </label>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm">Who it is and how it talks</span>
        <div role="group" aria-label="Persona view" className="flex gap-1 text-xs">
          <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)} className={`px-2 py-0.5 rounded ${!preview ? 'bg-muted font-medium' : ''}`}>Edit</button>
          <button type="button" aria-pressed={preview} onClick={() => setPreview(true)} className={`px-2 py-0.5 rounded ${preview ? 'bg-muted font-medium' : ''}`}>Preview</button>
        </div>
      </div>
      {preview ? (
        <div data-testid="persona-preview" className="rounded-md border border-[var(--border)] bg-muted/40 p-3 text-sm whitespace-pre-wrap max-h-[360px] overflow-auto">
          {doc.trim() === '' ? <span className="text-muted-foreground">No persona yet. The agent is told only its name and its one line.</span> : doc}
        </div>
      ) : (
        <textarea
          name="persona.document" aria-label="Persona" value={doc} rows={14} spellCheck
          onChange={(e) => set({ document: e.target.value })}
          className={`${box} font-mono text-xs`}
        />
      )}
      <p className={`text-xs ${size > PERSONA_DOC_MAX_BYTES ? 'text-red-600' : 'text-muted-foreground'}`}>{size} of {PERSONA_DOC_MAX_BYTES} bytes</p>
      <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
        {PERSONA_GUIDE.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Everything the agent is told now, with the rules as saved</summary>
        {savedPrompt === null
          ? <p className="mt-2 text-muted-foreground">Fill in the rules first. Then this shows the persona and, after it, what the launcher writes from the rules.</p>
          : <pre data-testid="saved-prompt" className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-2 font-mono max-h-[360px] overflow-auto">{savedPrompt}</pre>}
      </details>
    </div>
  )
}

export function DoorMemoryCard({ rules, harnessLabel, writes, onChange }: {
  rules: LabConfig
  harnessLabel: string
  /** Whether a class of tool that writes to the scratch folder is on. A kept folder needs one. */
  writes: boolean
  onChange: (patch: { memory?: LabConfig['memory']; tools?: LabConfig['tools'] }) => void
}) {
  const notes = rules.memory?.notes === true
  const kept = rules.tools?.keepScratch === true
  const canWrite = harnessLabel === 'Pi'
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <h3 className="font-medium text-sm">Memory</h3>
      <Row
        label="Keep notes for each room"
        hint={`Short notes about the channel, about people who ask to be remembered, and about threads still going on. The door keeps them on this machine and gives them back after a restart. One room's notes never reach another. ${canWrite ? 'The agent changes them only through the door, which refuses anything secret-shaped.' : `${harnessLabel} cannot change them; you can, on the Memory tab.`}`}
        checked={notes}
        onChange={(on) => onChange({ memory: on ? { notes: true } : undefined })}
      />
      <Row
        label="Keep the scratch folder after a stop"
        hint={writes ? 'Off by default. What the agent wrote in its scratch folder comes back when it starts again, up to the folder\'s size. Wipe it on the Memory tab.' : 'Needs writing files or the shell switched on under Tools.'}
        checked={kept}
        disabled={!writes}
        onChange={(on) => rules.tools && onChange({ tools: { ...rules.tools, keepScratch: on ? true : undefined } })}
      />
    </div>
  )
}

function Row({ label, hint, checked, disabled, onChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}
