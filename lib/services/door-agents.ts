/**
 * Door agents as citizens of the fleet.
 *
 * A door agent is one harness in a sealed cell with a door beside it. This
 * service is its lifecycle adapter (DoorRuntimeAdapter): create, start, stop,
 * status, logs, receipts, usage, remove. It owns the rules record, renders
 * the launcher's files from it, and reads what the door wrote back.
 *
 * Where things are:
 *
 *   <data dir>/harnesses.json            one row, { id, name, runtime }. It
 *                                        reserves the name. Hermes code has no
 *                                        adapter for the tag and leaves the
 *                                        row alone.
 *   <data dir>/door-agents/<id>/         the record, the rendered config and
 *                                        start script, the last dry run, the
 *                                        door's log, and its state folder.
 *
 * The bot token and the model key are in two files named by the record. This
 * service checks that the files are in place and passes their paths on. It
 * never reads a secret into anything it returns, stores or logs.
 */
import fs from 'fs'
import path from 'path'
import { createMemoryStore, MEMORY_FILES, MEMORY_HEADINGS, MEMORY_LIMITS, type MemoryFile, type MemoryStore, type RoomNotes } from '@/lib/door/memory'
import type { Receipt } from '@/lib/door/receipts'
import { createSanitizer } from '@/lib/door/sanitizer'
import { monthOf } from '@/lib/door/spend-ledger'
import { parseConfig, policyFor, systemPromptFor } from '@/lib/lab/pi-discord/config'
import { harnessFacts, isLauncherHarness, LAUNCHER_HARNESSES } from '@/lib/lab/pi-discord/harnesses'
import { doorAgentName, doorNameClash, doorNameTaken } from '@/lib/door-agent-name'
import type { Harness } from '@/lib/types'
import type { AuditService } from './audit'
import type { DoorLauncher } from './door-launcher'
import { tailLogFile } from './harness'
import {
  checkRecordInput, doorAgentPaths, draftRecord, renderConfig, renderStartScript, rulesProblems, secretProblems,
  supervisorCommand, type DoorRulesRecord,
} from './door-record'
import { isDoorRuntime, type DoorRuntime, type DoorRuntimeAdapter, type DoorStatus, type DoorUsage } from './runtime-adapter'
import type { Storage } from './storage'

const HARNESSES_FILE = 'harnesses.json'
// One line of ordinary text, the launcher's own rule for what an agent says about itself.
const ONE_LINE = /^[^\u0000-\u001f\u007f]*$/
const READY_LINE = 'RESULT: ready to start.'

/** A refusal with the HTTP status a route should answer with. */
export class DoorError extends Error {
  constructor(readonly status: number, message: string, readonly details?: string[]) {
    super(message)
    this.name = 'DoorError'
  }
}

export interface DryRunRecord {
  at: string
  /** `node-unusable`: the dry run was not run, because the Node that would run it cannot be used. */
  result: 'ready' | 'secrets-missing' | 'not-ready' | 'node-unusable'
  /** The lines that say what failed, and the result line. */
  lines: string[]
}

export interface DoorAgentView {
  record: DoorRulesRecord
  status: DoorStatus
  usage: DoorUsage
  dryRun: DryRunRecord | null
  /** What still stands between this record and a start. */
  problems: { rules: string[]; secrets: string[] }
  supervisor: { command: string; startScript: string }
  /** Which harness is in the cell, the one version of it that is pinned, and what it cannot do here. */
  harness: { runtime: DoorRuntime; label: string; version: string; oneRoomOnly: boolean; limits: string[] }
  /** What the agent is told, persona and all, from the saved rules. Null while the rules cannot be started. */
  systemPrompt: string | null
}

/** The Memory tab: the door's notes for each room, and a kept scratch folder. Nothing in it is secret-shaped: it is redacted on read. */
export interface DoorMemoryView {
  notes: boolean
  rooms: RoomNotes[]
  limits: { noteChars: number; fileBytes: number }
  /** A kept scratch folder: its size and when it was kept. Null when there is none. */
  scratch: { kept: boolean; bytes: number; savedAt: string } | null
  running: boolean
}

type Row = { id?: string; name?: string; runtime?: string | null }

/**
 * Whether an agent already answers to `name`: a stored row, or a Hermes agent
 * that is listed from its running container and has no stored row. Without
 * the second, a door agent made under that name would take the Hermes agent's
 * id, and the Hermes agent would drop out of the fleet.
 */
export function agentNameTaken(
  hermes: { nameTaken(name: string): boolean; list(): Array<{ id: string; name: string }> },
  name: string,
): boolean {
  const id = 'h_' + name.replace(/-/g, '_')
  return hermes.nameTaken(name) || hermes.list().some((h) => h.id === id || h.name === name)
}

export class DoorAgentService implements DoorRuntimeAdapter {
  private storage: Storage
  private audit: AuditService
  private dataDir: string
  private launcher: DoorLauncher
  private repoRoot: string
  private now: () => Date
  private nameTaken: (name: string) => boolean
  // One change at a time per agent: a dry run takes a while.
  private busy = new Set<string>()

  constructor(o: {
    storage: Storage; audit: AuditService; dataDir: string; launcher: DoorLauncher
    repoRoot: string; nameTaken: (name: string) => boolean; now?: () => Date
  }) {
    this.storage = o.storage
    this.audit = o.audit
    this.dataDir = o.dataDir
    this.launcher = o.launcher
    this.repoRoot = o.repoRoot
    this.nameTaken = o.nameTaken
    this.now = o.now ?? (() => new Date())
  }

  // --- rows -----------------------------------------------------------------

  private rows(): Row[] {
    const rows = this.storage.read<Row[]>(HARNESSES_FILE, [])
    return Array.isArray(rows) ? rows.filter((r) => typeof r?.id === 'string' && isDoorRuntime(r.runtime)) : []
  }

  private doorRow(id: string): Row {
    const row = this.rows().find((r) => r.id === id)
    if (!row) throw new DoorError(404, 'No door agent has this id')
    return row
  }

  private readRecord(id: string): DoorRulesRecord | undefined {
    try {
      const record = JSON.parse(fs.readFileSync(doorAgentPaths(this.dataDir, id).record, 'utf8')) as DoorRulesRecord
      // A record that is not whole is treated as missing: nothing is read out of half of one.
      const isObject = (v: unknown): boolean => v !== null && typeof v === 'object' && !Array.isArray(v)
      const whole = record?.schema === 1 && record.id === id && typeof record.name === 'string' && typeof record.version === 'number'
        && isObject(record.secrets) && isObject(record.rules)
        && [record.rules.persona, record.rules.discord, record.rules.budget, record.rules.model].every(isObject)
      return whole ? record : undefined
    } catch { return undefined }
  }

  private record(id: string): DoorRulesRecord {
    this.doorRow(id)
    const record = this.readRecord(id)
    if (!record) throw new DoorError(404, 'This agent has no rules record. Remove it and create it again')
    return record
  }

  /** Every door agent, as a fleet row. */
  list(): Harness[] {
    return this.rows().map((row) => this.project(row))
  }

  /** One door agent as a fleet row, or undefined when `id` is not a door agent. */
  row(id: string): Harness | undefined {
    const row = this.rows().find((r) => r.id === id)
    return row ? this.project(row) : undefined
  }

  private project(row: Row): Harness {
    const id = row.id as string
    const record = this.readRecord(id)
    const name = record?.name ?? row.name ?? id.replace(/^h_/, '').replace(/_/g, '-')
    return {
      id,
      name,
      runtime: row.runtime as DoorRuntime,
      status: this.statusOf(id, record).state,
      health: { errors: 0 },
      persona: record?.rules.persona.description || record?.rules.persona.name || name,
      // Every door agent is closed to a listed set of people in one channel.
      tier: 'team',
      platform: 'discord',
      channel: record?.rules.discord.channelId ?? '',
      lastSeen: 0,
      models: record?.rules.model.id ? [record.rules.model.id] : [],
      // The door keeps a monthly ledger and no daily figure or call count.
      // Unknown is null, and a page shows it as a dash, never as $0.
      costToday: null,
      invocations: null,
      cpu: 0,
      mem: 0,
      tools: [],
    }
  }

  // --- create and remove ----------------------------------------------------

  /** Make a draft door agent from a name. Nothing is started. */
  create(rawName: unknown, runtime: unknown = 'pi', rawDescription: unknown = ''): DoorRulesRecord {
    // Only a harness the launcher has a cell for.
    if (!isDoorRuntime(runtime) || !isLauncherHarness(runtime)) {
      throw new DoorError(400, `Swarm Map cannot start a "${String(runtime)}" agent behind a door. Only: ${LAUNCHER_HARNESSES.join(', ')}`)
    }
    const named = doorAgentName(rawName)
    if ('error' in named) throw new DoorError(400, named.error)
    const { name, id } = named
    const description = typeof rawDescription === 'string' ? rawDescription.trim() : undefined
    if (description === undefined || description.length > 600 || !ONE_LINE.test(description)) {
      throw new DoorError(400, 'Description: one line, up to 600 characters')
    }
    const stored = this.storage.read<Row[]>(HARNESSES_FILE, [])
    if (this.nameTaken(name) || doorNameTaken(named, Array.isArray(stored) ? stored : [])) {
      throw new DoorError(409, doorNameClash(name))
    }
    const record = draftRecord(id, name, runtime, this.now(), description)
    this.writeRecord(record)
    this.storage.write(HARNESSES_FILE, [...stored, { id, name, runtime }])
    this.audit.append({ who: 'admin', what: 'door:create', target: name, meta: { runtime } })
    return record
  }

  /** Stop the door, then forget the record, its folder and the fleet row. The secret files are not touched. */
  async remove(id: string): Promise<{ removed: true }> {
    const row = this.doorRow(id)
    return this.exclusive(id, async () => {
      const record = this.readRecord(id)
      if (record && rulesProblems(record).length === 0) await this.stopDoor(record)
      fs.rmSync(doorAgentPaths(this.dataDir, id).dir, { recursive: true, force: true })
      this.storage.write(HARNESSES_FILE, this.storage.read<Row[]>(HARNESSES_FILE, []).filter((r) => r?.id !== id))
      this.audit.append({ who: 'admin', what: 'door:remove', target: record?.name ?? row.name ?? id })
      return { removed: true as const }
    })
  }

  // --- status, usage, logs, receipts ----------------------------------------

  status(id: string): DoorStatus {
    this.doorRow(id)
    return this.statusOf(id, this.readRecord(id))
  }

  private statusOf(id: string, record: DoorRulesRecord | undefined): DoorStatus {
    const p = doorAgentPaths(this.dataDir, id)
    const dryRun = this.readDryRun(id)
    // A dry run that never ran says nothing about the cell.
    const seal = dryRun && dryRun.result !== 'node-unusable'
      ? { cellSealed: dryRun.result !== 'not-ready', sealCheckedAt: dryRun.at }
      : { cellSealed: null }
    let run: { pid?: unknown; startedAt?: unknown; policyHash?: unknown } | undefined
    try { run = JSON.parse(fs.readFileSync(path.join(p.stateDir, 'run.json'), 'utf8')) } catch { /* no run on record */ }
    if (!run || typeof run.pid !== 'number' || !this.launcher.alive(run.pid)) {
      return { state: 'stopped', ...seal, rulesInForce: null, startedBy: null }
    }
    let rulesInForce = false
    try { rulesInForce = record !== undefined && policyFor(record.rules).hash === run.policyHash } catch { /* rules that cannot be a policy are not in force */ }
    return {
      state: 'running', pid: run.pid,
      ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
      ...seal, rulesInForce, startedBy: this.startedBy(id, run.pid),
    }
  }

  /**
   * Who started the door that runs as `pid`. A supervisor is asked first: one
   * that restarts a door the page started keeps the same start script, and is
   * then the one that starts it again.
   */
  private startedBy(id: string, pid: number): NonNullable<DoorStatus['startedBy']> {
    if (this.launcher.supervisor?.(pid)) return 'supervisor'
    try {
      const started = JSON.parse(fs.readFileSync(doorAgentPaths(this.dataDir, id).startedByPage, 'utf8')) as { pid?: unknown }
      if (started?.pid === pid) return 'page'
    } catch { /* this page started nothing that is on record */ }
    return 'elsewhere'
  }

  usage(id: string): DoorUsage {
    const record = this.record(id)
    const month = monthOf(this.now())
    return {
      month,
      spentThisMonthUsd: this.spent(id, month),
      budgetMonthlyUsd: rulesProblems(record).length === 0 ? record.rules.budget.monthlyUsd : null,
      costToday: null,
      invocations: null,
    }
  }

  /** The month's figure from the door's ledger. Null when there is no ledger, or it cannot be trusted. */
  private spent(id: string, month: string): number | null {
    try {
      const ledger = JSON.parse(fs.readFileSync(path.join(doorAgentPaths(this.dataDir, id).stateDir, 'spend.json'), 'utf8')) as { schema?: unknown; months?: unknown }
      const months = ledger?.months
      if (ledger?.schema !== 1 || months === null || typeof months !== 'object' || Array.isArray(months)) return null
      const values = Object.values(months as Record<string, unknown>)
      if (!values.every((usd) => typeof usd === 'number' && Number.isFinite(usd) && usd >= 0)) return null
      return (months as Record<string, number>)[month] ?? 0
    } catch { return null }
  }

  logs(id: string, lines: number): string {
    this.doorRow(id)
    // Read from the end: a log that has grown for months is not loaded whole.
    return tailLogFile(doorAgentPaths(this.dataDir, id).log, lines)
  }

  /**
   * The door's decisions, newest first, read from the end of the file. A line
   * that is not a receipt is skipped, and only a receipt's own fields are
   * handed on, each as text or a number: a page draws them as they are.
   */
  receipts(id: string, last: number): Receipt[] {
    this.doorRow(id)
    const lines = tailLogFile(path.join(doorAgentPaths(this.dataDir, id).stateDir, 'receipts.jsonl'), 0).split('\n')
    const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const out: Receipt[] = []
    for (let i = lines.length - 1; i >= 0 && out.length < last; i--) {
      if (lines[i].trim() === '') continue
      let r: Record<string, unknown>
      try { r = JSON.parse(lines[i]) } catch { continue /* a half-written last line */ }
      const e = r?.event as Record<string, unknown> | null | undefined
      const [ts, verdict, rule, why, kind] = [text(r?.ts), text(r?.verdict), text(r?.rule), text(r?.why), text(e?.kind)]
      if (ts === undefined || verdict === undefined || rule === undefined || why === undefined || kind === undefined || !e) continue
      const event: Record<string, unknown> = { kind }
      for (const key of ['surface', 'room', 'sender', 'messageId', 'turnId']) if (text(e[key]) !== undefined) event[key] = e[key]
      if (typeof e.bytes === 'number') event.bytes = e.bytes
      out.push({
        ts, agentId: text(r.agentId) ?? '', policyHash: text(r.policyHash) ?? '', event, verdict, rule, why,
        ...(text(r.note) !== undefined ? { note: r.note } : {}),
      } as Receipt)
    }
    return out
  }

  /** Everything the agent page shows. Holds the two secret paths, and nothing the files hold. */
  view(id: string): DoorAgentView {
    const record = this.record(id)
    const p = doorAgentPaths(this.dataDir, id)
    return {
      record,
      status: this.statusOf(id, record),
      usage: this.usage(id),
      dryRun: this.readDryRun(id),
      problems: { rules: rulesProblems(record), secrets: secretProblems(record, this.repoRoot) },
      supervisor: { command: supervisorCommand(record, { startScript: p.startScript, logPath: p.log }), startScript: p.startScript },
      harness: this.harnessOf(record),
      systemPrompt: this.promptOf(record),
    }
  }

  private promptOf(record: DoorRulesRecord): string | null {
    if (rulesProblems(record).length > 0) return null
    const { config } = parseConfig({ ...record.rules, agentId: record.name })
    return config ? systemPromptFor(config) : null
  }

  // --- memory -----------------------------------------------------------------

  /**
   * The door's notes, read with the redactor: something secret-shaped that reached a file is never
   * shown. The page never sees a secret file either: the redactor here knows the patterns, not the keys.
   */
  private notesStore(id: string): MemoryStore {
    return createMemoryStore({ dir: doorAgentPaths(this.dataDir, id).memory, sanitizer: createSanitizer() })
  }

  memory(id: string): DoorMemoryView {
    const record = this.record(id)
    const p = doorAgentPaths(this.dataDir, id)
    let scratch: DoorMemoryView['scratch'] = null
    try {
      const st = fs.statSync(p.keptScratch)
      scratch = { kept: record.rules.tools?.keepScratch === true, bytes: st.size, savedAt: st.mtime.toISOString() }
    } catch { /* nothing kept */ }
    return {
      notes: record.rules.memory?.notes === true,
      rooms: this.notesStore(id).rooms(),
      limits: { noteChars: MEMORY_LIMITS.noteChars, fileBytes: MEMORY_LIMITS.fileBytes },
      scratch,
      running: this.statusOf(id, record).state === 'running',
    }
  }

  /** Replace one room's notes with what was written on the page. Checked as the door checks a note: size, and no secret. */
  saveMemory(id: string, input: { room: unknown; files: unknown }): DoorMemoryView {
    const record = this.record(id)
    const store = this.notesStore(id)
    const known = store.rooms().map((r) => r.key)
    if (typeof input.room !== 'string' || !known.includes(input.room)) throw new DoorError(404, 'No notes are kept for that room')
    const files = input.files
    if (files === null || typeof files !== 'object' || Array.isArray(files)) throw new DoorError(422, 'Not saved. The notes were refused', ['files: must be an object'])
    const problems = store.replace(input.room, files as Partial<Record<MemoryFile, string>>)
    if (problems.length > 0) throw new DoorError(422, 'Not saved. The notes were refused', problems)
    this.audit.append({ who: 'admin', what: 'door:memory-edit', target: record.name })
    return this.memory(id)
  }

  /** Remove one room's notes, or all of them. A running door reads its notes for every turn, so this counts at once. */
  wipeMemory(id: string, room?: unknown): DoorMemoryView {
    const record = this.record(id)
    const store = this.notesStore(id)
    if (room !== undefined) {
      if (typeof room !== 'string' || !store.rooms().some((r) => r.key === room)) throw new DoorError(404, 'No notes are kept for that room')
      store.wipe(room)
    } else {
      store.wipe()
    }
    this.audit.append({ who: 'admin', what: 'door:memory-wipe', target: record.name, meta: { scope: room === undefined ? 'all' : 'room' } })
    return this.memory(id)
  }

  /**
   * Remove a kept scratch folder. Only while the agent is stopped: a running agent's folder is kept
   * again when it stops, so a wipe then would not be a wipe.
   */
  wipeScratch(id: string): DoorMemoryView {
    const record = this.record(id)
    if (this.statusOf(id, record).state === 'running') throw new DoorError(409, 'Stop the agent first. Its scratch folder is kept again when it stops, so wiping it now would not empty it')
    fs.rmSync(doorAgentPaths(this.dataDir, id).keptScratch, { force: true })
    fs.rmSync(doorAgentPaths(this.dataDir, id).keptScratchRules, { force: true })
    this.audit.append({ who: 'admin', what: 'door:scratch-wipe', target: record.name })
    return this.memory(id)
  }

  /** What the Memory tab's wipe buttons ask for: one room's notes, every room's, or the kept scratch folder. */
  wipe(id: string, what: { room: string | null; all: string | null }): DoorMemoryView {
    if (what.room !== null) return this.wipeMemory(id, what.room)
    if (what.all === 'notes') return this.wipeMemory(id)
    if (what.all === 'scratch') return this.wipeScratch(id)
    this.record(id)
    throw new DoorError(400, 'Say what to wipe: ?room=<key>, ?all=notes or ?all=scratch')
  }

  /** Every room's notes as one Markdown file, redacted, for the Download button. */
  memoryMarkdown(id: string): { name: string; text: string } {
    const record = this.record(id)
    const rooms = this.notesStore(id).rooms()
    const lines = [`# Notes kept by the door for ${record.name}`, '', `Downloaded ${this.now().toISOString()}. Secret-shaped text is redacted.`]
    for (const room of rooms) {
      lines.push('', `## Room ${room.key}`)
      for (const f of MEMORY_FILES) {
        lines.push('', `### ${MEMORY_HEADINGS[f]}`, '', room.files[f].trim() || '(none)')
      }
    }
    if (rooms.length === 0) lines.push('', 'No notes are kept.')
    return { name: `${record.name}-notes.md`, text: lines.join('\n') + '\n' }
  }

  private harnessOf(record: DoorRulesRecord): DoorAgentView['harness'] {
    const { label, version, oneRoomOnly, limits } = harnessFacts(record.runtime)
    return { runtime: record.runtime, label, version, oneRoomOnly, limits }
  }

  // --- start, stop, save ------------------------------------------------------

  /** Dry-run the record's rules, and start the door only if the dry run ends ready. */
  async start(id: string): Promise<void> {
    const record = this.record(id)
    return this.exclusive(id, async () => {
      const problems = rulesProblems(record)
      if (problems.length > 0) throw new DoorError(422, 'Not started. Fill in the rules first', problems)
      if (this.statusOf(id, record).state === 'running') throw new DoorError(409, 'This agent is already running')
      // The launcher checks the two files again, and what they hold. This is the cheap refusal, before a dry run.
      const misplaced = secretProblems(record, this.repoRoot)
      if (misplaced.length > 0) throw new DoorError(422, 'Not started. The secret files are not in place', misplaced)
      const p = this.render(record)
      await this.dryRunOrRefuse(record, p.config, 'Not started')
      await this.startDoor(record)
      this.audit.append({ who: 'admin', what: 'door:start', target: record.name })
    })
  }

  async stop(id: string): Promise<void> {
    const record = this.record(id)
    return this.exclusive(id, async () => {
      // A draft has never been started: its rules are not ones the launcher will read.
      if (rulesProblems(record).length > 0) return
      await this.stopDoor(record)
      this.audit.append({ who: 'admin', what: 'door:stop', target: record.name })
    })
  }

  /**
   * Save an edit of the rules and apply it. On a stopped door the record is
   * stored and the files are rendered. On a running door the new rules are
   * dry-run first: only if that ends ready is anything stored, and then the
   * door is stopped and started on the new rules. A door that cannot be
   * stopped keeps its old rules, so nothing is stored: the record never says
   * something else than the door that is running.
   */
  async saveRules(id: string, input: { rules: unknown; secrets: unknown; version: unknown }): Promise<{ record: DoorRulesRecord; applied: 'stored' | 'restarted' }> {
    const current = this.record(id)
    return this.exclusive(id, async () => {
      const checked = checkRecordInput(current, input)
      if (checked.errors.length > 0) throw new DoorError(422, 'Not saved. The rules were refused', checked.errors)
      if (input.version !== current.version) {
        throw new DoorError(409, 'Not saved. The rules were changed somewhere else since this page loaded. Reload and try again')
      }
      const next: DoorRulesRecord = { ...current, rules: checked.rules!, secrets: checked.secrets!, version: current.version + 1, updatedAt: this.now().toISOString() }
      const running = this.statusOf(id, current).state === 'running'
      const p = doorAgentPaths(this.dataDir, id)
      if (running) {
        const misplaced = secretProblems(next, this.repoRoot)
        if (misplaced.length > 0) throw new DoorError(422, 'Not saved. The door keeps running on the rules it had. The secret files are not in place', misplaced)
        fs.writeFileSync(p.candidateConfig, renderConfig(next), { mode: 0o600 })
        try { await this.dryRunOrRefuse(next, p.candidateConfig, 'Not saved. The door keeps running on the rules it had') } finally { fs.rmSync(p.candidateConfig, { force: true }) }
        try { await this.stopDoor(current) } catch {
          throw new DoorError(500, 'Not saved. The door could not be stopped cleanly, so the rules on record are unchanged. The Logs tab and the launcher\'s `stop` command say more')
        }
      }
      this.writeRecord(next)
      this.render(next)
      this.audit.append({ who: 'admin', what: 'door:rules', target: next.name, meta: { version: next.version, policy: policyFor(next.rules).hash.slice(0, 12) } })
      if (!running) return { record: next, applied: 'stored' as const }
      try {
        await this.startDoor(next)
      } catch (err) {
        throw new DoorError(500, `The rules were saved, but the door did not come back up: ${err instanceof Error ? err.message : 'unknown error'}`)
      }
      return { record: next, applied: 'restarted' as const }
    })
  }

  // --- the pieces -------------------------------------------------------------

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new DoorError(409, 'Another change to this agent is still running. Try again when it has finished')
    this.busy.add(id)
    try { return await work() } finally { this.busy.delete(id) }
  }

  private writeRecord(record: DoorRulesRecord): void {
    const p = doorAgentPaths(this.dataDir, record.id)
    fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(p.dir, 0o700)
    this.writeFile(p.record, JSON.stringify(record, null, 2) + '\n', 0o600)
  }

  private writeFile(file: string, content: string, mode: number): void {
    fs.writeFileSync(file, content, { mode })
    fs.chmodSync(file, mode)
  }

  /** Write the launcher's config and the start script from the record, over whatever is there. */
  private render(record: DoorRulesRecord): ReturnType<typeof doorAgentPaths> {
    const p = doorAgentPaths(this.dataDir, record.id)
    this.writeFile(p.config, renderConfig(record), 0o600)
    this.writeFile(p.startScript, renderStartScript(record, { ...this.launcher.command(), configPath: p.config, stateDir: p.stateDir }), 0o700)
    return p
  }

  private readDryRun(id: string): DryRunRecord | null {
    try {
      const d = JSON.parse(fs.readFileSync(doorAgentPaths(this.dataDir, id).dryRun, 'utf8')) as DryRunRecord
      return typeof d?.at === 'string' && ['ready', 'secrets-missing', 'not-ready', 'node-unusable'].includes(d.result) && Array.isArray(d.lines) ? d : null
    } catch { return null }
  }

  /** Run the dry run on a config, keep its result, and refuse unless it ended ready. */
  private async dryRunOrRefuse(record: DoorRulesRecord, configPath: string, refusedAs: string): Promise<void> {
    const p = doorAgentPaths(this.dataDir, record.id)
    // The start script names a Node by path. If that Node is gone or too old the door would
    // only crash, so say so here, where the page shows it, before anything is run or stopped.
    const noNode = this.launcher.nodeProblem()
    if (noNode) {
      this.writeFile(p.dryRun, JSON.stringify({ at: this.now().toISOString(), result: 'node-unusable', lines: [`FAIL  ${noNode}`] } satisfies DryRunRecord, null, 2) + '\n', 0o600)
      throw new DoorError(422, `${refusedAs}. Node cannot be used to run the door`, [noNode])
    }
    const { code, output } = await this.launcher.dryRun({
      configPath,
      env: { SMLAB_DISCORD_TOKEN_FILE: record.secrets.discordTokenFile, SMLAB_MODEL_KEY_FILE: record.secrets.modelKeyFile, SMLAB_STATE_DIR: p.stateDir },
    })
    const lines = output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('FAIL') || l.startsWith('RESULT:') || l.startsWith('config: refused'))
    // Exit code 3 is the launcher's "sealed, but the secret files are not in place".
    const result: DryRunRecord['result'] = code === 0 && output.includes(READY_LINE) ? 'ready' : code === 3 ? 'secrets-missing' : 'not-ready'
    this.writeFile(p.dryRun, JSON.stringify({ at: this.now().toISOString(), result, lines } satisfies DryRunRecord, null, 2) + '\n', 0o600)
    if (result !== 'ready') {
      throw new DoorError(422, `${refusedAs}. The dry run did not end "ready to start"`, lines.length > 0 ? lines : ['The dry run did not finish'])
    }
  }

  private async startDoor(record: DoorRulesRecord): Promise<void> {
    const p = doorAgentPaths(this.dataDir, record.id)
    fs.mkdirSync(p.stateDir, { recursive: true, mode: 0o700 })
    fs.rmSync(p.startedByPage, { force: true })
    await this.launcher.start({ startScript: p.startScript, logPath: p.log, stateDir: p.stateDir })
    // Which process this page started, so the page can tell it from one a supervisor started later.
    try {
      const run = JSON.parse(fs.readFileSync(path.join(p.stateDir, 'run.json'), 'utf8')) as { pid?: unknown }
      if (typeof run.pid === 'number') this.writeFile(p.startedByPage, JSON.stringify({ pid: run.pid, at: this.now().toISOString() }) + '\n', 0o600)
    } catch { /* no run on record: the status says stopped */ }
  }

  private async stopDoor(record: DoorRulesRecord): Promise<void> {
    const p = doorAgentPaths(this.dataDir, record.id)
    if (!fs.existsSync(p.config)) this.render(record)
    const { ok } = await this.launcher.stop({ configPath: p.config, stateDir: p.stateDir })
    if (!ok) throw new DoorError(500, 'The door could not be stopped cleanly. The Logs tab and the launcher\'s `stop` command say more')
    // Nothing this page started is running any more.
    fs.rmSync(p.startedByPage, { force: true })
  }
}
