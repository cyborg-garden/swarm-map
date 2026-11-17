'use client'

import { useState } from 'react'
import { parseWebEntry, SUGGESTED_WEB } from '@/lib/core/tools/web'
import type { LabConfig, ToolsConfig } from '@/lib/lab/pi-discord/config'

/**
 * The Tools card on a door agent's Rules tab. Three classes of tool, each
 * off, asking an admin, or allowed. All off by default. It edits the `tools`
 * part of the rules record and nothing else; what the choices mean is decided
 * by the launcher's own parser and by the door, never here.
 *
 * Types only are imported from the launcher: its code hashes records, which a
 * page has no use for. The three class names and the two defaults are written
 * out here, and a test holds them to the launcher's.
 */

type ToolClass = ToolsConfig['enabled'][number]
type Mode = 'never' | 'ask' | 'allow'

export const TOOL_ROWS: { key: ToolClass; label: string; hint: string }[] = [
  { key: 'file_read', label: 'Read files', hint: 'Read and list files in its scratch folder.' },
  { key: 'file_write', label: 'Write files', hint: 'Write and edit files in its scratch folder.' },
  { key: 'shell', label: 'Shell', hint: 'Run commands inside its sealed cell. No network, no secrets, nothing of this machine.' },
]
const EMPTY: ToolsConfig = { enabled: [], mode: {}, approvalSeconds: 120 }

/**
 * How one class is set: off unless it is switched on, then its mode, or the default for its class.
 * Writing files asks by default when the shell asks, as in the launcher.
 */
export function modeOf(tools: ToolsConfig | undefined, key: ToolClass): Mode {
  const t = tools ?? EMPTY
  if (!t.enabled.includes(key)) return 'never'
  const fallback: Mode = key === 'shell' ? 'ask' : key === 'file_read' ? 'allow' : modeOf(t, 'shell') === 'ask' ? 'ask' : 'allow'
  return t.mode[key] ?? fallback
}

/**
 * Whether a choice is one the launcher takes. A shell that asks with file writing that does not is
 * refused there: a yes to `sh run.sh` would run whatever the agent wrote into run.sh unseen.
 */
export function mayChoose(tools: ToolsConfig | undefined, key: ToolClass, mode: Mode): boolean {
  return !(key === 'file_write' && mode === 'allow' && modeOf(tools, 'shell') === 'ask')
}

/**
 * The tools part of the rules with one class set. A class that is off is taken off both lists.
 * Setting the shell to ask brings file writing that was allowed down to ask with it.
 */
export function withMode(tools: ToolsConfig | undefined, key: ToolClass, mode: Mode): ToolsConfig {
  const t = tools ?? EMPTY
  const enabled = TOOL_ROWS.map((r) => r.key).filter((k) => (k === key ? mode !== 'never' : t.enabled.includes(k)))
  const modes = { ...t.mode }
  if (mode === 'never') delete modes[key]
  else modes[key] = mode
  if (key === 'shell' && mode === 'ask' && modeOf(t, 'file_write') === 'allow') modes.file_write = 'ask'
  return { ...t, enabled, mode: modes }
}

/** The web allowlist with entries added, each at most once. An empty list switches the web off. */
export function withWeb(tools: ToolsConfig | undefined, allow: string[], mode?: 'allow' | 'ask'): ToolsConfig {
  const t = tools ?? EMPTY
  const unique = [...new Set(allow)]
  const { web: _old, ...rest } = t
  void _old
  const nextMode = mode ?? t.web?.mode
  return unique.length === 0 ? rest : { ...rest, web: { allow: unique, ...(nextMode ? { mode: nextMode } : {}) } }
}

const inputClass = 'rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm'

export function DoorToolsCard({ rules, builtFor, onChange }: {
  rules: LabConfig
  /** Set when this agent's harness has no tools: the name of the one that does. The card is then switched off. */
  builtFor?: string
  onChange: (tools: ToolsConfig) => void
}) {
  const tools = rules.tools
  const anyone = rules.discord.anyoneInChannel
  const off = anyone || builtFor !== undefined
  const webAllow = tools?.web?.allow ?? []
  const asks = TOOL_ROWS.some((r) => modeOf(tools, r.key) === 'ask') || (webAllow.length > 0 && tools?.web?.mode === 'ask')
  const [entry, setEntry] = useState('')
  const read = entry.trim() === '' ? undefined : parseWebEntry(entry)
  const add = (more: string[]) => onChange(withWeb(tools, [...webAllow, ...more]))
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3" data-testid="door-tools-card">
      <h3 className="font-medium text-sm">Tools</h3>
      <p className="text-xs text-muted-foreground">
        Off by default. Every tool runs inside the agent&apos;s sealed cell: a small scratch folder that is emptied when it stops, no network, no secrets.
        With &quot;Ask an admin&quot;, the door posts exactly what the agent wants to run in the channel, and it runs only if an admin replies approve or reacts ✅.
      </p>
      {builtFor !== undefined ? (
        <p role="note" className="text-xs text-amber-600">
          Tools are built for {builtFor} only. This agent&apos;s harness has none.
        </p>
      ) : anyone && (
        <p role="note" className="text-xs text-amber-600">
          This agent hears anyone in the channel, so it gets no tools in its cell. Name who it hears to switch one on. It can still read listed web pages.
        </p>
      )}
      {TOOL_ROWS.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm">{row.label}</p>
            <p className="text-xs text-muted-foreground">{row.hint}</p>
          </div>
          <select
            name={`tools.${row.key}`} aria-label={row.label} className={inputClass} disabled={off}
            value={off ? 'never' : modeOf(tools, row.key)}
            onChange={(e) => onChange(withMode(tools, row.key, e.target.value as Mode))}
          >
            <option value="never">Off</option>
            <option value="ask">Ask an admin</option>
            <option value="allow" disabled={!mayChoose(tools, row.key, 'allow')}>Allow</option>
          </select>
        </div>
      ))}
      {!off && modeOf(tools, 'shell') === 'ask' && modeOf(tools, 'file_write') !== 'never' && (
        <p className="text-xs text-muted-foreground">
          While the shell asks, writing files asks too: an admin is shown a command, not the files it runs.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        A yes to a shell command is a yes to whatever it leaves behind in the cell, running or written, until the agent is stopped.
      </p>
      <div className="space-y-2 border-t border-[var(--border)] pt-3" data-testid="door-web">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm">Web pages</p>
            <p className="text-xs text-muted-foreground">
              Off until a site is listed. The door fetches a page for the agent, never the cell: read-only, no logins or cookies, private addresses refused.
              A host is matched exactly; add a path to allow only what is under it. What a page says goes to the model as untrusted text, never into the channel.
            </p>
          </div>
          {webAllow.length > 0 && (
            <select
              name="tools.web.mode" aria-label="Web pages" className={inputClass} disabled={builtFor !== undefined}
              value={tools?.web?.mode ?? 'allow'}
              onChange={(e) => onChange(withWeb(tools, webAllow, e.target.value as 'allow' | 'ask'))}
            >
              <option value="ask">Ask an admin</option>
              <option value="allow">Allow listed sites</option>
            </select>
          )}
        </div>
        {webAllow.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Allowed sites">
            {webAllow.map((site) => (
              <li key={site} className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-0.5 text-xs">
                <span>{site}</span>
                <button type="button" aria-label={`Remove ${site}`} disabled={builtFor !== undefined}
                  onClick={() => onChange(withWeb(tools, webAllow.filter((s) => s !== site)))}>×</button>
              </li>
            ))}
          </ul>
        )}
        {builtFor === undefined && (
          <>
            <div className="flex gap-2">
              <input
                name="tools.web.add" aria-label="Add a site" placeholder="en.wikipedia.org or github.com/some-org" className={`flex-1 ${inputClass}`}
                value={entry} onChange={(e) => setEntry(e.target.value)}
              />
              <button type="button" className={inputClass} disabled={!read || 'problem' in read}
                onClick={() => { if (read && !('problem' in read)) { add([`${read.host}${read.path}`]); setEntry('') } }}>Add</button>
            </div>
            {read && 'problem' in read && <p className="text-xs text-amber-600">That is not a site the door takes: {read.problem}.</p>}
            <div className="flex flex-wrap gap-1.5" aria-label="Suggested sites">
              {SUGGESTED_WEB.filter((s) => !s.entries.every((e) => webAllow.includes(e))).map((s) => (
                <button key={s.label} type="button" title={s.entries.join(', ')}
                  className="rounded-full border border-dashed border-[var(--border)] px-2 py-0.5 text-xs text-muted-foreground"
                  onClick={() => add(s.entries)}>+ {s.label}</button>
              ))}
            </div>
          </>
        )}
      </div>
      {asks && builtFor === undefined && (
        <label className="block space-y-1">
          <span className="text-sm">Seconds an admin has to answer</span>
          <input
            type="number" name="tools.approvalSeconds" min={10} max={600} step={1} className={`w-full ${inputClass}`}
            value={Number.isFinite((tools ?? EMPTY).approvalSeconds) ? (tools ?? EMPTY).approvalSeconds : ''}
            onChange={(e) => onChange({ ...(tools ?? EMPTY), approvalSeconds: e.target.value === '' ? Number.NaN : Number(e.target.value) })}
          />
          <span className="block text-xs text-muted-foreground">10 to 600. With no answer by then, the call does not run.</span>
        </label>
      )}
    </div>
  )
}
