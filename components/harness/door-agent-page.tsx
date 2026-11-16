'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useApi } from '@/lib/hooks/use-api'
import { StatusDot } from '@/components/shared/status-dot'
import { RuntimeBadge } from '@/components/shared/runtime-badge'
import { ConfirmDialog } from '@/components/shared/confirm-dialog'
import { DOOR_RUNBOOK } from '@/components/harness/add-door-agent-dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { TagInput } from '@/components/ui/tag-input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Harness } from '@/lib/types'
import type { DoorAgentView } from '@/lib/services/door-agents'
import type { DoorRulesRecord } from '@/lib/services/door-record'
import type { Receipt } from '@/lib/door/receipts'
import { DoorToolsCard } from './door-tools-card'

/**
 * The page of an agent that runs behind a door. It shows the four things
 * that apply to one: its status, its rules, the door's decisions and the
 * door's log. Nothing Hermes-specific is drawn or asked for here.
 *
 *  GET  /api/harnesses/:id/door            record, status, usage, last dry run
 *  PUT  /api/harnesses/:id/door/rules      save and apply
 *  GET  /api/harnesses/:id/door/receipts   decisions, newest first
 *  GET  /api/harnesses/:id/logs            the door's log
 *  POST /api/harnesses/:id/start | stop
 */

const RUNBOOK = DOOR_RUNBOOK
const TABS = ['overview', 'rules', 'receipts', 'logs'] as const

/**
 * The tab the address asks for (`?tab=rules`), or the Overview. A new agent's
 * page is opened on its Rules tab, since that is what is filled in next. Read
 * once, in the browser: this page is only drawn after the agent was fetched.
 */
function tabFromAddress(): (typeof TABS)[number] {
  if (typeof window === 'undefined') return 'overview'
  const asked = new URLSearchParams(window.location.search).get('tab')
  return TABS.find((tab) => tab === asked) ?? 'overview'
}
const SNOWFLAKE = /^\d{15,22}$/

type Rules = DoorRulesRecord['rules']
type Draft = { rules: Rules; secrets: DoorRulesRecord['secrets'] }

/** A sum of money, or a dash when it is not known. Never $0 for "not known". */
export function usd(v: number | null | undefined): string {
  return v == null ? '—' : `$${v.toFixed(2)}`
}

function when(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

async function failure(res: Response, fallback: string): Promise<{ error: string; details: string[] }> {
  const body = await res.json().catch(() => ({}))
  return { error: body.error ?? fallback, details: Array.isArray(body.details) ? body.details : [] }
}

export function DoorAgentPage({ harness }: { harness: Harness }) {
  const router = useRouter()
  const id = harness.id
  const { data: view, refetch } = useApi<DoorAgentView>(`/api/harnesses/${id}/door`, 5000)
  const [busy, setBusy] = useState<'start' | 'stop' | 'save' | 'remove' | null>(null)
  const [problem, setProblem] = useState<{ error: string; details: string[] } | null>(null)
  // Stop cuts off a conversation and Remove forgets the rules, so each is asked about first.
  const [asking, setAsking] = useState<'stop' | 'remove' | null>(null)
  const [firstTab] = useState(tabFromAddress)

  const status = view?.status
  const running = (status?.state ?? harness.status) === 'running'

  async function act(verb: 'start' | 'stop') {
    setBusy(verb)
    setProblem(null)
    try {
      const res = await fetch(`/api/harnesses/${id}/${verb}`, { method: 'POST' })
      if (!res.ok) {
        const f = await failure(res, verb === 'start' ? 'Start failed' : 'Stop failed')
        setProblem(f)
        toast.error(f.error)
      } else {
        toast.success(verb === 'start' ? 'The cell was checked and the door is starting' : 'Stopped')
      }
    } catch {
      toast.error(verb === 'start' ? 'Start failed' : 'Stop failed')
    } finally {
      setBusy(null)
      refetch()
    }
  }

  async function remove() {
    setBusy('remove')
    try {
      const res = await fetch(`/api/harnesses/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error((await failure(res, 'Remove failed')).error)
        return
      }
      toast.success(`Removed "${harness.name}"`)
      router.push('/harnesses')
    } catch {
      toast.error('Remove failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <StatusDot status={running ? 'running' : 'stopped'} />
          <div>
            <h2 className="text-2xl font-semibold">{harness.name}</h2>
            <div className="flex items-center gap-2 mt-1">
              <RuntimeBadge runtime={harness.runtime} />
              <span className="text-sm text-muted-foreground">{harness.persona}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setAsking('remove')} disabled={busy !== null} className="text-destructive border-destructive/30 hover:bg-destructive/10">
            Remove
          </Button>
          {running ? (
            <Button variant="outline" size="sm" onClick={() => setAsking('stop')} disabled={busy !== null}>
              {busy === 'stop' ? 'Stopping…' : 'Stop'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => act('start')} disabled={busy !== null}>
              {busy === 'start' ? 'Checking the cell…' : 'Start'}
            </Button>
          )}
        </div>
      </div>

      {problem && (
        <div role="alert" className="mb-4 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
          <p>{problem.error}</p>
          {problem.details.length > 0 && (
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {problem.details.map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={asking !== null}
        title={asking === 'remove' ? `Remove ${harness.name}?` : `Stop ${harness.name}?`}
        description={asking === 'remove'
          ? 'This stops its door and forgets its rules, its receipts and its spend record. The two secret files are left where they are.'
          : 'It drops the conversation it is in the middle of, its cell is removed, and it stays offline until you start it again.'}
        confirmLabel={asking === 'remove' ? 'Remove' : 'Stop'}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          const what = asking
          setAsking(null)
          if (what === 'remove') remove()
          else if (what === 'stop') act('stop')
        }}
      />

      <Tabs defaultValue={firstTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="receipts">Receipts</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          {view ? <Overview view={view} /> : <p className="text-muted-foreground">Loading...</p>}
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          {view ? (
            <RulesForm
              key={view.record.version}
              view={view}
              running={running}
              saving={busy === 'save'}
              onSave={async (draft) => {
                setBusy('save')
                setProblem(null)
                try {
                  const res = await fetch(`/api/harnesses/${id}/door/rules`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...draft, version: view.record.version }),
                  })
                  if (!res.ok) {
                    const f = await failure(res, 'Save failed')
                    setProblem(f)
                    toast.error(f.error)
                    return false
                  }
                  const { applied } = await res.json()
                  toast.success(applied === 'restarted' ? 'Saved. The door was restarted on the new rules' : 'Saved')
                  return true
                } catch {
                  toast.error('Save failed')
                  return false
                } finally {
                  setBusy(null)
                  refetch()
                }
              }}
            />
          ) : <p className="text-muted-foreground">Loading...</p>}
        </TabsContent>
        <TabsContent value="receipts" className="mt-4">
          <Receipts id={id} />
        </TabsContent>
        <TabsContent value="logs" className="mt-4">
          <Logs id={id} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3">
      <h3 className="font-medium text-sm">{title}</h3>
      {children}
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

function Overview({ view }: { view: DoorAgentView }) {
  const { status, usage, record, problems, dryRun, harness } = view
  const sealed = status.cellSealed === null ? 'not checked yet. It is checked at every Start' : status.cellSealed ? 'yes' : 'no'
  const startedBy = {
    page: 'this page, as a background process. Nothing restarts it if it exits',
    supervisor: 'a supervisor. It is started again if it exits with an error',
    // What is known, and no more. A door this page started before it kept a note of that is shown this way too.
    elsewhere: 'Swarm Map has no note that it started this door, and saw no supervisor. Whatever started it decides whether it is started again',
  }
  const todo = [...problems.rules, ...problems.secrets]
  return (
    <div className="grid grid-cols-2 gap-4">
      <Card title="Status">
        <Row label="Door" value={status.state === 'running' ? `running since ${when(status.startedAt)}` : 'stopped'} />
        <Row label="Harness" value={`${harness.label} ${harness.version}, pinned`} />
        <Row label="Cell sealed" value={status.sealCheckedAt ? `${sealed} (checked ${when(status.sealCheckedAt)})` : sealed} />
        {status.state === 'running' && (
          <Row label="Rules in force" value={status.rulesInForce ? 'the rules on record' : 'older rules than the ones on record. Save the rules, or stop and start, to apply them'} />
        )}
        {status.state === 'running' && status.startedBy && <Row label="Started by" value={startedBy[status.startedBy]} />}
        <Row label="Model" value={record.rules.model.id || '—'} />
        <div className="text-xs text-muted-foreground">
          <p>What {harness.label} cannot do here:</p>
          <ul className="list-disc pl-5 space-y-0.5">
            {harness.limits.map((limit) => <li key={limit}>{limit}</li>)}
          </ul>
        </div>
      </Card>
      <Card title={`Budget, ${usage.month}`}>
        <Row label="Spent this month" value={usd(usage.spentThisMonthUsd)} />
        <Row label="Monthly limit" value={usd(usage.budgetMonthlyUsd)} />
        <Row label="Cost today" value={usd(usage.costToday)} />
        <p className="text-xs text-muted-foreground">
          The door keeps one figure a month. A dash means it has no figure, not that nothing was spent.
        </p>
      </Card>
      {todo.length > 0 && (
        <div className="col-span-2">
          <Card title="Before it can start">
            <ul className="list-disc pl-5 text-sm space-y-1">
              {todo.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            <p className="text-xs text-muted-foreground">
              The Discord application and the two secret files are made by hand. <a className="underline" href={RUNBOOK} target="_blank" rel="noreferrer">The runbook</a> has the steps.
            </p>
          </Card>
        </div>
      )}
      {dryRun && dryRun.result !== 'ready' && (
        <div className="col-span-2">
          <Card title={`Last dry run, ${when(dryRun.at)}`}>
            <ul className="font-mono text-xs space-y-1">
              {dryRun.lines.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </Card>
        </div>
      )}
      <div className="col-span-2">
        <Card title="Run it under a supervisor">
          <p className="text-xs text-muted-foreground">
            Start runs the door as a background process. To have it restarted when it exits with an error, run it under pm2 instead. Stop on this page still stops it, and it stays stopped:
          </p>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs font-mono">{view.supervisor.command}</pre>
        </Card>
      </div>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

const inputClass = 'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm'

function Text({ value, onChange, name, placeholder, describedBy }: { value: string; onChange: (v: string) => void; name: string; placeholder?: string; describedBy?: string }) {
  return <input type="text" name={name} value={value} placeholder={placeholder} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} className={inputClass} />
}

function Amount({ value, onChange, name }: { value: number; onChange: (v: number) => void; name: string }) {
  return (
    <input
      type="number" name={name} min={0} step="any" value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))} className={inputClass}
    />
  )
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

const ONE_ROOM_NOTE = 'door-one-room-note'

function RulesForm({ view, running, saving, onSave }: {
  view: DoorAgentView; running: boolean; saving: boolean; onSave: (draft: Draft) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Draft>({ rules: view.record.rules, secrets: view.record.secrets })
  const [dirty, setDirty] = useState(false)
  const r = draft.rules
  const d = r.discord
  const set = (rules: Rules) => { setDraft({ ...draft, rules }); setDirty(true) }
  const discord = (patch: Partial<Rules['discord']>) => set({ ...r, discord: { ...d, ...patch } })
  const model = (patch: Partial<Rules['model']>) => set({ ...r, model: { ...r.model, ...patch } })
  const secret = (patch: Partial<Draft['secrets']>) => { setDraft({ ...draft, secrets: { ...draft.secrets, ...patch } }); setDirty(true) }
  const isId = (v: string) => SNOWFLAKE.test(v)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Card title="Persona">
          <Field label="Name"><Text name="persona.name" value={r.persona.name} onChange={(name) => set({ ...r, persona: { ...r.persona, name } })} /></Field>
          <Field label="Description" hint="One line about what it is for. It cannot give the agent an ability.">
            <Text name="persona.description" value={r.persona.description} onChange={(description) => set({ ...r, persona: { ...r.persona, description } })} />
          </Field>
        </Card>
        <Card title="Where">
          <Field label="Server id"><Text name="discord.guildId" value={d.guildId} onChange={(guildId) => discord({ guildId })} placeholder="digits only" /></Field>
          <Field label="Channel id" hint="The one channel. Its threads count as part of it.">
            <Text name="discord.channelId" value={d.channelId} onChange={(channelId) => discord({ channelId })} placeholder="digits only" describedBy={view.harness.oneRoomOnly ? ONE_ROOM_NOTE : undefined} />
          </Field>
          {/* Said beside the field it is about, for a harness that has the limit. The rules enforce it either way. */}
          {view.harness.oneRoomOnly && (
            <p id={ONE_ROOM_NOTE} className="text-xs text-muted-foreground">
              <span className="font-medium text-[var(--foreground)]">{view.harness.label}:</span> {view.harness.limits[0]}
            </p>
          )}
        </Card>
        <Card title="Who it hears">
          <Field label="Admins" hint="At least one. Admins are also heard.">
            <TagInput values={d.adminUserIds} onChange={(adminUserIds) => discord({ adminUserIds })} validate={isId} placeholder="user id" />
          </Field>
          <Field label="Other people"><TagInput values={d.allowedUserIds} onChange={(allowedUserIds) => discord({ allowedUserIds })} validate={isId} placeholder="user id" /></Field>
          <Field label="Roles"><TagInput values={d.allowedRoleIds} onChange={(allowedRoleIds) => discord({ allowedRoleIds })} validate={isId} placeholder="role id" /></Field>
          <Toggle label="Anyone in the channel" checked={d.anyoneInChannel} onChange={(anyoneInChannel) => discord({ anyoneInChannel })} />
        </Card>
        <Card title="When it answers">
          <Toggle label="Mention required" hint="Answer only when the bot is mentioned." checked={d.mentionRequired} onChange={(mentionRequired) => discord({ mentionRequired })} />
          <Toggle label="Read all messages" hint="Asks Discord for the text of every message. Needed when no mention is required." checked={d.readAllMessages} onChange={(readAllMessages) => discord({ readAllMessages })} />
          <Field label="Other bots, when none is named">
            <select name="discord.bots" value={d.bots} onChange={(e) => discord({ bots: e.target.value as Rules['discord']['bots'] })} className={inputClass}>
              <option value="none">Ignore all of them</option>
              <option value="mentions">Hear any bot that writes the mention</option>
            </select>
          </Field>
          <Field label="Named bots" hint="With any id here, only these bots are heard.">
            <TagInput values={d.allowedBotIds} onChange={(allowedBotIds) => discord({ allowedBotIds })} validate={isId} placeholder="bot user id" />
          </Field>
          <Field label="Bot loop limit" hint="Bot messages answered in a row before a person has to speak. 0 to 20.">
            <Amount name="discord.botLoopLimit" value={d.botLoopLimit} onChange={(botLoopLimit) => discord({ botLoopLimit })} />
          </Field>
        </Card>
        <Card title="Budget and model">
          <Field label="Monthly budget, USD" hint="After it, model calls are refused until the next month.">
            <Amount name="budget.monthlyUsd" value={r.budget.monthlyUsd} onChange={(monthlyUsd) => set({ ...r, budget: { monthlyUsd } })} />
          </Field>
          <Field label="Model base URL" hint="OpenAI-compatible, https, ending in /v1.">
            <Text name="model.baseUrl" value={r.model.baseUrl} onChange={(baseUrl) => model({ baseUrl })} placeholder="https://…/v1" />
          </Field>
          <Field label="Model"><Text name="model.id" value={r.model.id} onChange={(id) => model({ id })} placeholder="provider/model" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="USD per million tokens in"><Amount name="model.usdPerMTokIn" value={r.model.usdPerMTokIn} onChange={(usdPerMTokIn) => model({ usdPerMTokIn })} /></Field>
            <Field label="USD per million tokens out"><Amount name="model.usdPerMTokOut" value={r.model.usdPerMTokOut} onChange={(usdPerMTokOut) => model({ usdPerMTokOut })} /></Field>
          </div>
        </Card>
        <DoorToolsCard rules={r} onChange={(tools) => set({ ...r, tools })} />
        <Card title="Secret files">
          <p className="text-xs text-muted-foreground">
            The bot token and the model key stay in two files that only you can read, outside the repo. Give their paths here.
            Never paste a token or a key into this page. <a className="underline" href={RUNBOOK} target="_blank" rel="noreferrer">The runbook</a> says how to make the Discord application and the files.
          </p>
          <Field label="Bot token file"><Text name="secrets.discordTokenFile" value={draft.secrets.discordTokenFile} onChange={(discordTokenFile) => secret({ discordTokenFile })} placeholder="/full/path/to/the/file" /></Field>
          <Field label="Model key file"><Text name="secrets.modelKeyFile" value={draft.secrets.modelKeyFile} onChange={(modelKeyFile) => secret({ modelKeyFile })} placeholder="/full/path/to/the/file" /></Field>
        </Card>
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!dirty || saving} onClick={async () => { if (await onSave(draft)) setDirty(false) }}>
          {saving ? (running ? 'Checking the new rules…' : 'Saving…') : 'Save'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {running
            ? 'The agent is running. Save dry-runs the new rules, then restarts the door on them. If the dry run fails, nothing changes.'
            : 'The agent is stopped. The rules are applied when it is started.'}
        </span>
      </div>
    </div>
  )
}

function Receipts({ id }: { id: string }) {
  const { data, loading, refetch } = useApi<{ receipts: Receipt[] }>(`/api/harnesses/${id}/door/receipts?last=100`)
  const [approvalsOnly, setApprovalsOnly] = useState(false)
  // An approval is every step of a tool call that waited for an admin: asked, each answer, and how it ended.
  const receipts = (data?.receipts ?? []).filter((r) => !approvalsOnly || r.rule === 'priv.approval')
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button onClick={() => refetch()} className="text-sm px-3 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-muted">Refresh</button>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={approvalsOnly} onChange={(e) => setApprovalsOnly(e.target.checked)} />
          Approvals only
        </label>
        <span className="text-xs text-muted-foreground">Every decision the door made, newest first. Receipts hold ids and sizes, never message text.</span>
      </div>
      {receipts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{loading ? 'Loading...' : approvalsOnly ? 'No tool call has waited for an admin yet.' : 'No receipts yet. The door writes one for every message it sees.'}</p>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-muted-foreground uppercase tracking-wide">
                <th className="text-left px-4 py-2">When</th>
                <th className="text-left px-4 py-2">Decision</th>
                <th className="text-left px-4 py-2">Rule</th>
                <th className="text-left px-4 py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r, i) => (
                <tr key={`${r.ts}-${i}`} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">{when(r.ts)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{r.event.kind} · {r.verdict}{r.event.kind === 'approval' && r.event.sender ? ` · answer from ${r.event.sender}` : ''}</td>
                  <td className="px-4 py-2 font-mono text-xs">{r.rule}</td>
                  <td className="px-4 py-2">{r.why}{r.note ? ` (${r.note})` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Logs({ id }: { id: string }) {
  const [lines, setLines] = useState(100)
  const { data, loading, refetch } = useApi<{ logs: string }>(`/api/harnesses/${id}/logs?lines=${lines}`)
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <select value={lines} onChange={(e) => setLines(Number(e.target.value))} className="text-sm border border-[var(--border)] rounded-md px-2 py-1 bg-[var(--surface)]">
          <option value={50}>50 lines</option>
          <option value={100}>100 lines</option>
          <option value={250}>250 lines</option>
        </select>
        <button onClick={() => refetch()} disabled={loading} className="text-sm px-3 py-1 rounded-md border border-[var(--border)] bg-[var(--surface)] hover:bg-muted disabled:opacity-50">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <span className="text-xs text-muted-foreground">What the door printed. The decisions themselves are under Receipts.</span>
      </div>
      <div className="rounded-xl border border-[var(--border)] bg-black/90 overflow-auto max-h-[500px]">
        <pre className="text-xs font-mono text-green-400 p-4 whitespace-pre-wrap">
          {data?.logs || (loading ? 'Fetching logs…' : 'No log yet. The door writes one when it is started.')}
        </pre>
      </div>
    </div>
  )
}
