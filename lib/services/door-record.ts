/**
 * The rules record for one door agent, and what is rendered from it.
 *
 * Swarm Map owns the record: who the agent hears, its one channel, whether a
 * mention is needed, which bots are named, the loop limit, the budget, the
 * persona and the model. The rules are the launcher's own config type
 * (lib/lab/pi-discord/config.ts), checked by the launcher's own parser and
 * policy validator, so there is one set of rules and one place that decides
 * whether they are sound.
 *
 * The launcher's config file and the start script are RENDERED from the
 * record on every save and every start. Nothing patches them.
 *
 * The record names the two secret files by path. It never holds what is in
 * them, and nothing in this file reads them into a value that is returned.
 */
import path from 'path'
import { parseConfig, type LabConfig } from '@/lib/lab/pi-discord/config'
import { isLauncherHarness, LAUNCHER_HARNESSES } from '@/lib/lab/pi-discord/harnesses'
import { secretFilePlaceProblem, MODEL_KEY_FILE_ENV, SEARCH_KEY_FILE_ENV, TOKEN_FILE_ENV } from '@/lib/lab/pi-discord/secrets'
import { defaultPersona } from '@/lib/lab/pi-discord/persona'
import type { DoorRuntime } from './runtime-adapter'

/**
 * The rules as the launcher is handed them: under the record's own name, and
 * with the record's own harness. Neither is taken from an edit. A Pi agent's
 * rules name no harness, which is how the launcher reads Pi.
 */
function launcherRules(record: Pick<DoorRulesRecord, 'name' | 'runtime'>, rules: object): Record<string, unknown> {
  const { harness: _dropped, ...rest } = rules as Record<string, unknown>
  void _dropped
  return { ...rest, agentId: record.name, ...(record.runtime === 'pi' ? {} : { harness: record.runtime }) }
}

export interface DoorSecretPaths {
  /** Path of the file that holds the bot token. Empty until it is set. */
  discordTokenFile: string
  /** Path of the file that holds the model key. Empty until it is set. */
  modelKeyFile: string
  /** Path of the file that holds the web search key. Needed only when the rules switch search on. */
  searchKeyFile?: string
}

export interface DoorRulesRecord {
  schema: 1
  /** The fleet id, `h_<name>`. */
  id: string
  /** The agent's name, which is also the launcher's agent id. */
  name: string
  runtime: DoorRuntime
  /** Goes up by one on every save. A save must name the version it edited. */
  version: number
  updatedAt: string
  rules: LabConfig
  secrets: DoorSecretPaths
}

const SECRET_LABELS: Record<keyof DoorSecretPaths, string> = {
  discordTokenFile: 'bot token file',
  modelKeyFile: 'model key file',
  searchKeyFile: 'search key file',
}
const SECRET_ENV: Record<keyof DoorSecretPaths, string> = {
  discordTokenFile: TOKEN_FILE_ENV,
  modelKeyFile: MODEL_KEY_FILE_ENV,
  searchKeyFile: SEARCH_KEY_FILE_ENV,
}

/** The folder that holds everything Swarm Map keeps for one door agent. */
export function doorAgentDir(dataDir: string, id: string): string {
  return path.join(dataDir, 'door-agents', id)
}

export function doorAgentPaths(dataDir: string, id: string) {
  const dir = doorAgentDir(dataDir, id)
  return {
    dir,
    record: path.join(dir, 'record.json'),
    config: path.join(dir, 'config.json'),
    candidateConfig: path.join(dir, 'config.next.json'),
    startScript: path.join(dir, 'start.sh'),
    dryRun: path.join(dir, 'dry-run.json'),
    /** Which process Swarm Map itself started last, by pid. Written by Swarm Map, beside the door's own state and not in it. */
    startedByPage: path.join(dir, 'started-by-page.json'),
    log: path.join(dir, 'door.log'),
    stateDir: path.join(dir, 'state'),
    /** The door's notes for each room (lib/door/memory.ts). The launcher's `memoryDir` of the state folder. */
    memory: path.join(dir, 'state', 'memory'),
    /** A kept scratch folder, as a tar the cell made. The launcher's KEPT_SCRATCH_FILE. Never unpacked on this machine. */
    keptScratch: path.join(dir, 'state', 'scratch.tar'),
    /** The tool rules the kept folder was kept under (the launcher's KEPT_SCRATCH_RULES_FILE). */
    keptScratchRules: path.join(dir, 'state', 'scratch.json'),
  }
}

/**
 * A new record: named, closed, and not startable until the ids, the budget
 * and the model are filled in. Every switch starts at its closed setting.
 * It starts with the default persona and with notes on: the notes are the
 * door's, kept per room, and an agent can only change them through the door.
 */
export function draftRecord(id: string, name: string, runtime: DoorRuntime, now: Date = new Date(), description = ''): DoorRulesRecord {
  return {
    schema: 1, id, name, runtime, version: 1, updatedAt: now.toISOString(),
    rules: {
      agentId: name,
      ...(runtime === 'pi' ? {} : { harness: runtime }),
      persona: { name, description, document: defaultPersona(name) },
      memory: { notes: true },
      discord: {
        guildId: '', channelId: '', adminUserIds: [], allowedUserIds: [], allowedRoleIds: [],
        anyoneInChannel: false, mentionRequired: true, bots: 'none', allowedBotIds: [], botLoopLimit: 4, readAllMessages: false,
      },
      budget: { monthlyUsd: 5 },
      model: { baseUrl: '', id: '', usdPerMTokIn: 0, usdPerMTokOut: 0 },
    },
    secrets: { discordTokenFile: '', modelKeyFile: '' },
  }
}

/** Why the record's rules cannot be started, in the launcher's words. Empty when they can. */
export function rulesProblems(record: DoorRulesRecord): string[] {
  return parseConfig(launcherRules(record, record.rules)).errors
}

/**
 * Check an edit before anything is stored. Returns the rules and the secret
 * paths as they would be stored, or every reason the edit is refused.
 */
export function checkRecordInput(
  record: DoorRulesRecord,
  input: { rules: unknown; secrets: unknown },
): { rules?: LabConfig; secrets?: DoorSecretPaths; errors: string[] } {
  const errors: string[] = []
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

  const rulesIn = asObject(input.rules)
  // The agent id is fixed when the record is made: it names the state folder. So is the harness: it names the cell.
  // A harness the launcher does not have is refused as any other setting it does not have would be.
  const parsed = rulesIn
    ? rulesIn.harness !== undefined && !isLauncherHarness(rulesIn.harness)
      ? { errors: [`harness: must be one of ${LAUNCHER_HARNESSES.join(', ')}`] }
      : parseConfig(launcherRules(record, rulesIn))
    : { errors: ['rules: must be an object'] }
  errors.push(...parsed.errors)

  const secretsIn = asObject(input.secrets)
  const secrets: DoorSecretPaths = { discordTokenFile: '', modelKeyFile: '' }
  if (!secretsIn) {
    errors.push('secrets: must be an object with the two file paths')
  } else {
    for (const key of Object.keys(secretsIn)) {
      if (!(key in SECRET_LABELS)) errors.push(`secrets.${key}: not a setting. Only the paths of the secret files are kept, never a secret`)
    }
    for (const key of Object.keys(SECRET_LABELS) as Array<keyof DoorSecretPaths>) {
      const value = secretsIn[key] ?? ''
      // A path is written into a shell script and shown on a page: one line of ordinary text, from the root.
      if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || value.length > 1024 || (value !== '' && !path.isAbsolute(value))) {
        errors.push(`secrets.${key}: the ${SECRET_LABELS[key]} must be given as a full path on one line`)
      } else {
        if (key !== 'searchKeyFile' || value !== '') secrets[key] = value
      }
    }
  }

  if (errors.length > 0) return { errors }
  return { rules: (parsed as { config?: LabConfig }).config, secrets, errors: [] }
}

/**
 * Why the two secret files cannot be used, by the launcher's own check of
 * where they are: not there, readable by others, a link, or inside the repo.
 * Says where, never what. Empty when both are in place. The files are not
 * opened here: what they hold is checked by the launcher's dry run, in the
 * launcher's process.
 */
export function secretProblems(record: DoorRulesRecord, repoRoot: string): string[] {
  const problems: string[] = []
  for (const key of Object.keys(SECRET_LABELS) as Array<keyof DoorSecretPaths>) {
    // The search key is needed only when search is on. Then it has to be in place like the other two.
    if (key === 'searchKeyFile' && record.rules.tools?.web?.search !== true) continue
    const name = SECRET_ENV[key]
    const problem = secretFilePlaceProblem(name, { [name]: record.secrets[key] || undefined }, repoRoot)
    if (problem) problems.push(problem.replace(name, `The ${SECRET_LABELS[key]}`).replace('Point it at', 'Give the path of'))
  }
  return problems
}

/** The launcher's config file, as text. Holds ids and limits, and no path to a secret. */
export function renderConfig(record: DoorRulesRecord): string {
  return JSON.stringify({
    $generated: 'Written by Swarm Map from the rules record. Do not edit: it is written again on every save and every start.',
    ...launcherRules(record, record.rules),
  }, null, 2) + '\n'
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/**
 * The script a supervisor runs to start the door. It names the two secret
 * files and the state folder, then becomes the launcher. Paths only.
 */
export function renderStartScript(
  record: DoorRulesRecord,
  o: { node: string; cli: string; configPath: string; stateDir: string },
): string {
  return [
    '#!/bin/sh',
    '# Written by Swarm Map from the rules record. Do not edit: it is written again on every save and every start.',
    `export ${TOKEN_FILE_ENV}=${shellQuote(record.secrets.discordTokenFile)}`,
    `export ${MODEL_KEY_FILE_ENV}=${shellQuote(record.secrets.modelKeyFile)}`,
    ...(record.secrets.searchKeyFile ? [`export ${SEARCH_KEY_FILE_ENV}=${shellQuote(record.secrets.searchKeyFile)}`] : []),
    `export SMLAB_STATE_DIR=${shellQuote(o.stateDir)}`,
    `exec ${shellQuote(o.node)} ${shellQuote(o.cli)} start --config ${shellQuote(o.configPath)}`,
    '',
  ].join('\n')
}

/**
 * One command that puts the door under pm2. A door that exits with an error
 * is restarted. A stop asked for through Swarm Map ends with exit code 0 and
 * stays stopped, and so does a door killed by a signal: pm2 counts that as 0.
 */
export function supervisorCommand(record: DoorRulesRecord, o: { startScript: string; logPath: string }): string {
  return [
    'pm2 start', shellQuote(o.startScript), '--name', shellQuote(`door-${record.name}`), '--interpreter sh',
    '--stop-exit-codes 0', '--output', shellQuote(o.logPath), '--error', shellQuote(o.logPath),
  ].join(' ')
}
