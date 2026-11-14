// One Pi agent in one Discord channel: check it, start it, stop it.
//
//   node lib/lab/pi-discord/cli.ts dry-run  --config <file>
//   node lib/lab/pi-discord/cli.ts start    --config <file>
//   node lib/lab/pi-discord/cli.ts stop     --config <file>      the kill switch
//   node lib/lab/pi-discord/cli.ts status   --config <file>
//   node lib/lab/pi-discord/cli.ts receipts --config <file> [--last 20]
//
// The config holds ids and limits (config.example.json). The bot token and
// the model key are read from two files, named by SMLAB_DISCORD_TOKEN_FILE
// and SMLAB_MODEL_KEY_FILE. See docs/lab/pi-discord.md.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseConfig, policyFor, type LabConfig } from './config.ts'
import { alive, prepareStateDir, readRun, REPO_ROOT, sealChecks, start, stopRun, type Check } from './launch.ts'
import { dockerProblems, docker } from './cell.ts'
import { MODEL_KEY_FILE_ENV, readSecretFile, secretFileProblem, TOKEN_FILE_ENV } from './secrets.ts'
import { monthOf } from '../../door/spend-ledger.ts'
import type { Receipt } from '../../door/receipts.ts'

const [command, ...rest] = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const say = (line: string): void => { console.log(line) }
const fail = (line: string, code = 1): never => { console.error(line); process.exit(code) }

function loadConfig(): LabConfig {
  const file = flag('config')
  if (!file) return fail('usage: cli.ts dry-run|start|stop|status|receipts --config <file> [--state <folder>]', 2)
  let raw: unknown
  try { raw = JSON.parse(readFileSync(path.resolve(file), 'utf8')) } catch { return fail(`config: ${file} is not there or is not JSON`) }
  const { config, errors } = parseConfig(raw)
  if (!config) return fail(['config: refused', ...errors.map((e) => `  ${e}`)].join('\n'))
  return config
}
const stateDirFor = (config: LabConfig): string =>
  prepareStateDir(path.resolve(flag('state') ?? process.env.SMLAB_STATE_DIR ?? path.join(os.homedir(), '.swarm-map-lab', config.agentId)))
const mark = (c: Check): string => `  ${c.pass ? 'pass' : 'FAIL'}  ${c.id.padEnd(4)} ${c.title}${c.pass ? '' : `\n          ${c.detail}`}`

async function dryRun(): Promise<void> {
  const config = loadConfig()
  const policy = policyFor(config)
  const d = config.discord
  say('config')
  say(`  ok    agent ${config.agentId}: one server, one channel${d.mentionRequired ? ', answers only when mentioned' : ', answers without a mention'}`)
  say(`  ok    heard: ${d.adminUserIds.length} admin(s), ${d.allowedUserIds.length} other people, ${d.allowedRoleIds.length} role(s)${d.anyoneInChannel ? ', and anyone in the channel' : ''}`)
  say(`  ok    other bots: ${d.bots === 'none' ? 'ignored' : `heard when they write the mention, up to ${d.botLoopLimit} in a row`}; direct messages: refused; tools: none`)
  say(`  ok    budget $${config.budget.monthlyUsd} a month, then model calls are refused; model ${config.model.id}`)
  if (config.model.usdPerMTokIn === 0 && config.model.usdPerMTokOut === 0) say('  note  both prices are 0, so the budget can never be reached')
  say(`  ok    policy ${policy.hash.slice(0, 12)}`)

  say('secrets (the files are checked, not opened to Discord or the model)')
  const missing = [TOKEN_FILE_ENV, MODEL_KEY_FILE_ENV].map((name) => secretFileProblem(name, process.env, REPO_ROOT)).filter((p): p is string => p !== undefined)
  for (const name of [TOKEN_FILE_ENV, MODEL_KEY_FILE_ENV]) {
    const problem = secretFileProblem(name, process.env, REPO_ROOT)
    say(problem ? `  FAIL  ${problem}` : `  ok    ${name}: a file only you can read, outside the repo`)
  }

  say('docker')
  const dockerIssues = dockerProblems()
  for (const p of dockerIssues) say(`  FAIL  ${p}`)
  let checks: Check[] = []
  if (dockerIssues.length === 0) {
    say('  ok    this machine\'s Docker, both lab images built')
    say('containment (the real cell is started, probed from inside and watched from outside, then removed)')
    const workDir = mkdtempSync(path.join(os.tmpdir(), 'smlab-dry-'))
    try { checks = await sealChecks({ model: config.model.id, workDir, log: () => {} }) } finally { rmSync(workDir, { recursive: true, force: true }) }
    for (const c of checks) say(mark(c))
  }
  const sealed = dockerIssues.length === 0 && checks.length > 0 && checks.every((c) => c.pass)
  say('')
  say('Nothing was connected: no Discord connection was opened and no model was called.')
  if (!sealed) fail('RESULT: not ready. The cell is not shown to be sealed.')
  if (missing.length > 0) fail('RESULT: the cell is sealed, but the secret files are not in place yet.', 3)
  say('RESULT: ready to start.')
}

async function run(): Promise<void> {
  const config = loadConfig()
  const stateDir = stateDirFor(config)
  const secrets = { discordToken: '', modelKey: '' }
  try {
    secrets.discordToken = readSecretFile(TOKEN_FILE_ENV, process.env, REPO_ROOT)
    secrets.modelKey = readSecretFile(MODEL_KEY_FILE_ENV, process.env, REPO_ROOT)
  } catch (err) { fail(`secrets: ${(err as Error).message}`) }
  // Belt and braces: whatever a line says, the two secrets are never printed.
  const log = (line: string): void => {
    let out = line
    for (const s of Object.values(secrets)) out = out.split(s).join('[redacted]')
    say(`${new Date().toISOString()} ${out}`)
  }
  let running: Awaited<ReturnType<typeof start>> | undefined
  let stopping = false
  const stop = async (code: number): Promise<void> => {
    if (stopping) return
    stopping = true
    await running?.stop()
    process.exit(code)
  }
  process.on('SIGINT', () => { void stop(0) })
  process.on('SIGTERM', () => { void stop(0) })
  try {
    running = await start({ config, secrets, stateDir, log, onFatal: (code) => { log(`Discord refused the bot (code ${code}). Stopping.`); void stop(1) } })
  } catch (err) {
    fail(`start: ${(err as Error).message.split(secrets.discordToken).join('[redacted]').split(secrets.modelKey).join('[redacted]')}`)
  }
  log(`receipts: ${path.join(stateDir, 'receipts.jsonl')}`)
  log('to stop: run this command again with `stop`, or press Ctrl-C here')
}

async function status(): Promise<void> {
  const config = loadConfig()
  const stateDir = stateDirFor(config)
  const r = readRun(stateDir)
  if (!r) { say('not running: no run is recorded'); return }
  say(`door: pid ${r.pid} ${alive(r.pid) ? 'running' : 'NOT running'}, started ${r.startedAt}, policy ${r.policyHash.slice(0, 12)}`)
  const containers = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${r.project}`, '--format', '{{.Names}} {{.State}}']).out.trim()
  say(`cell: ${containers.split('\n').join(', ') || 'no containers'}`)
  try {
    const ledger = JSON.parse(readFileSync(path.join(stateDir, 'spend.json'), 'utf8')) as { months: Record<string, number> }
    say(`spent this month: $${(ledger.months[monthOf(new Date())] ?? 0).toFixed(4)} of $${config.budget.monthlyUsd}`)
  } catch { say('spent this month: nothing recorded yet') }
}

function receipts(): void {
  const config = loadConfig()
  const file = path.join(stateDirFor(config), 'receipts.jsonl')
  let lines: string[]
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { say('no receipts yet'); return }
  for (const line of lines.slice(-(Number(flag('last')) || 20))) {
    const r = JSON.parse(line) as Receipt
    const where = [r.event.room && `room ${r.event.room}`, r.event.sender && `from ${r.event.sender}`, r.event.messageId && `msg ${r.event.messageId}`].filter(Boolean).join(' ')
    say(`${r.ts}  ${r.event.kind.padEnd(8)} ${r.verdict.padEnd(7)} ${r.rule.padEnd(18)} ${r.why}${r.note ? ` (${r.note})` : ''}${where ? `  [${where}]` : ''}`)
  }
}

switch (command) {
  case 'dry-run': await dryRun(); process.exit(0); break
  case 'start': await run(); break
  case 'stop': process.exit(await stopRun(stateDirFor(loadConfig()), say) ? 0 : 1); break
  case 'status': await status(); break
  case 'receipts': receipts(); break
  default: fail('usage: cli.ts dry-run|start|stop|status|receipts --config <file> [--state <folder>]', 2)
}
