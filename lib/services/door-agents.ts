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
import type { Receipt } from '@/lib/door/receipts'
import { monthOf } from '@/lib/door/spend-ledger'
import { policyFor } from '@/lib/lab/pi-discord/config'
import type { Harness } from '@/lib/types'
import type { AuditService } from './audit'
import type { DoorLauncher } from './door-launcher'
import {
  checkRecordInput, doorAgentPaths, draftRecord, renderConfig, renderStartScript, rulesProblems, secretProblems,
  supervisorCommand, type DoorRulesRecord,
} from './door-record'
import { isDoorRuntime, type DoorRuntime, type DoorRuntimeAdapter, type DoorStatus, type DoorUsage } from './runtime-adapter'
import type { Storage } from './storage'

const HARNESSES_FILE = 'harnesses.json'
// Runtimes this build can start. `letta-code` has a tag and a badge, and no launcher yet.
const LAUNCHABLE: readonly DoorRuntime[] = ['pi']
const NAME = /^[A-Za-z0-9][A-Za-z0-9 -]*$/
const AGENT_ID = /^[a-z0-9][a-z0-9-]{1,30}$/
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
  result: 'ready' | 'secrets-missing' | 'not-ready'
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
}

type Row = { id?: string; name?: string; runtime?: string | null }

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
  create(rawName: unknown, runtime: unknown = 'pi'): DoorRulesRecord {
    if (!isDoorRuntime(runtime) || !LAUNCHABLE.includes(runtime)) {
      throw new DoorError(400, `Swarm Map cannot start a "${String(runtime)}" agent yet. Only: ${LAUNCHABLE.join(', ')}`)
    }
    const name = typeof rawName === 'string' && NAME.test(rawName.trim()) ? rawName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : ''
    if (!AGENT_ID.test(name)) throw new DoorError(400, 'Name: letters, digits, spaces and dashes, 2 to 31 characters')
    const id = 'h_' + name.replace(/-/g, '_')
    const stored = this.storage.read<Row[]>(HARNESSES_FILE, [])
    if (this.nameTaken(name) || stored.some((r) => r?.id === id || r?.name === name)) {
      throw new DoorError(409, `An agent named "${name}" already exists`)
    }
    const record = draftRecord(id, name, runtime, this.now())
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
    const seal = dryRun
      ? { cellSealed: dryRun.result !== 'not-ready', sealCheckedAt: dryRun.at }
      : { cellSealed: null }
    let run: { pid?: unknown; startedAt?: unknown; policyHash?: unknown } | undefined
    try { run = JSON.parse(fs.readFileSync(path.join(p.stateDir, 'run.json'), 'utf8')) } catch { /* no run on record */ }
    if (!run || typeof run.pid !== 'number' || !this.launcher.alive(run.pid)) {
      return { state: 'stopped', ...seal, rulesInForce: null }
    }
    let rulesInForce = false
    try { rulesInForce = record !== undefined && policyFor(record.rules).hash === run.policyHash } catch { /* rules that cannot be a policy are not in force */ }
    return {
      state: 'running', pid: run.pid,
      ...(typeof run.startedAt === 'string' ? { startedAt: run.startedAt } : {}),
      ...seal, rulesInForce,
    }
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
    let text: string
    try { text = fs.readFileSync(doorAgentPaths(this.dataDir, id).log, 'utf8') } catch { return '' }
    const all = text.split('\n')
    if (all.at(-1) === '') all.pop()
    return (lines > 0 ? all.slice(-lines) : all).join('\n')
  }

  /** The door's decisions, newest first. A line that is not a receipt is skipped. */
  receipts(id: string, last: number): Receipt[] {
    this.doorRow(id)
    let text: string
    try { text = fs.readFileSync(path.join(doorAgentPaths(this.dataDir, id).stateDir, 'receipts.jsonl'), 'utf8') } catch { return [] }
    const out: Receipt[] = []
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0 && out.length < last; i--) {
      if (lines[i].trim() === '') continue
      try {
        const r = JSON.parse(lines[i]) as Receipt
        if (typeof r?.ts === 'string' && typeof r.verdict === 'string' && typeof r.rule === 'string' && typeof r.why === 'string' && r.event && typeof r.event === 'object') out.push(r)
      } catch { /* a half-written last line */ }
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
    }
  }

  // --- start, stop, save ------------------------------------------------------

  /** Dry-run the record's rules, and start the door only if the dry run ends ready. */
  async start(id: string): Promise<void> {
    const record = this.record(id)
    return this.exclusive(id, async () => {
      const problems = rulesProblems(record)
      if (problems.length > 0) throw new DoorError(422, 'Not started. Fill in the rules first', problems)
      if (this.statusOf(id, record).state === 'running') throw new DoorError(409, 'This agent is already running')
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
   * door is stopped and started on the new rules.
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
        fs.writeFileSync(p.candidateConfig, renderConfig(next), { mode: 0o600 })
        try { await this.dryRunOrRefuse(next, p.candidateConfig, 'Not saved. The door keeps running on the rules it had') } finally { fs.rmSync(p.candidateConfig, { force: true }) }
      }
      this.writeRecord(next)
      this.render(next)
      this.audit.append({ who: 'admin', what: 'door:rules', target: next.name, meta: { version: next.version, policy: policyFor(next.rules).hash.slice(0, 12) } })
      if (!running) return { record: next, applied: 'stored' as const }
      try {
        await this.stopDoor(current)
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
      return typeof d?.at === 'string' && ['ready', 'secrets-missing', 'not-ready'].includes(d.result) && Array.isArray(d.lines) ? d : null
    } catch { return null }
  }

  /** Run the dry run on a config, keep its result, and refuse unless it ended ready. */
  private async dryRunOrRefuse(record: DoorRulesRecord, configPath: string, refusedAs: string): Promise<void> {
    const p = doorAgentPaths(this.dataDir, record.id)
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
    await this.launcher.start({ startScript: p.startScript, logPath: p.log, stateDir: p.stateDir })
  }

  private async stopDoor(record: DoorRulesRecord): Promise<void> {
    const p = doorAgentPaths(this.dataDir, record.id)
    if (!fs.existsSync(p.config)) this.render(record)
    const { ok } = await this.launcher.stop({ configPath: p.config, stateDir: p.stateDir })
    if (!ok) throw new DoorError(500, 'The door could not be stopped cleanly. The Logs tab and the launcher\'s `stop` command say more')
  }
}
