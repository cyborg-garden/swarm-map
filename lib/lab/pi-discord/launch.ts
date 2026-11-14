// Start, check and stop one Pi agent in one Discord channel.
//
// The door runs in this process, on this machine: it holds the bot token and
// the model key, talks to Discord and to the model, and writes a receipt for
// every decision. Pi runs in the sealed cell and reaches the door through
// the relay. Nothing here puts a secret in a container, a log or an error.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { findTargets, sinkProblems, startHostListener } from '../../../conformance/docker/runner.ts'
import type { SurfaceConnector } from '../../door/connector.ts'
import { createDiscordConnector } from '../../door/connectors/discord.ts'
import { createDoor, type Door } from '../../door/door.ts'
import { startModelRoute, type ModelRoute } from '../../door/model-route.ts'
import { OPENAI_CHAT } from '../../door/model-shapes.ts'
import { createReceiptLog } from '../../door/receipts.ts'
import { createSanitizer } from '../../door/sanitizer.ts'
import { createFileLedger, createMemoryLedger } from '../../door/spend-ledger.ts'
import { cellDown, cellUp, docker, dockerProblems, probeCell, renderCell, runningCellProblems, sealProblems, type CellOptions } from './cell.ts'
import { policyFor, type LabConfig } from './config.ts'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

export interface RunRecord { pid: number; project: string; agentId: string; policyHash: string; startedAt: string }
export interface Running { project: string; door: Door; stop(): Promise<void> }
export interface Check { id: string; title: string; pass: boolean; detail: string }

const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The folder that keeps receipts, the spend ledger and the record of what is running. Never in the repo. */
export function prepareStateDir(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error('the state folder must be an absolute path')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (inside(realpathSync(dir), realpathSync(REPO_ROOT))) throw new Error('the state folder is inside the repo. Keep it outside')
  return dir
}

export const runFile = (stateDir: string): string => path.join(stateDir, 'run.json')
export function readRun(stateDir: string): RunRecord | undefined {
  try { return JSON.parse(readFileSync(runFile(stateDir), 'utf8')) as RunRecord } catch { return undefined }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const withTimeout = <T>(work: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([
  work, new Promise<T>((_resolve, reject) => { const t = setTimeout(() => reject(new Error(what)), ms); t.unref?.() }),
])

export interface StartOptions {
  config: LabConfig
  secrets: { discordToken: string; modelKey: string }
  stateDir: string
  log: (line: string) => void
  /** Tests only: point the connector at a fake Discord. The command line never sets this. */
  discord?: { apiBase: string; gatewayUrl: string }
  /** Called if Discord closes the gateway for good. The caller should stop. */
  onFatal?: (code: number) => void
  cellReadyMs?: number
}

/** Bring one agent up. Either everything is up when this returns, or nothing is left running. */
export async function start(o: StartOptions): Promise<Running> {
  const stateDir = prepareStateDir(o.stateDir)
  const previous = readRun(stateDir)
  if (previous && alive(previous.pid)) throw new Error(`this agent is already running (pid ${previous.pid}). Stop it first`)
  const dockerIssues = dockerProblems()
  if (dockerIssues.length > 0) throw new Error(dockerIssues.join('; '))

  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const policy = policyFor(o.config)
  const receipts = createReceiptLog({ file: path.join(stateDir, 'receipts.jsonl') })
  const [brainPort, routePort] = [await freePort(), await freePort()]
  const secrets = [o.secrets.discordToken, o.secrets.modelKey]

  const cellOptions: CellOptions = { nonce, cellNonce, brainToken, brainPort, routePort, model: o.config.model.id }
  const file = renderCell(cellOptions)
  const problems = sealProblems(file, secrets)
  if (problems.length > 0) throw new Error(`the cell is not sealed: ${problems.join('; ')}`)

  let door: Door | undefined
  let route: ModelRoute | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await door?.close().catch(() => {})
    await route?.close().catch(() => {})
    const left = cellDown(project)
    rmSync(runFile(stateDir), { force: true })
    rmSync(path.join(stateDir, 'compose.json'), { force: true })
    o.log(left.length === 0 ? 'stopped: the door is closed and the cell is gone' : `stopped the door, but these containers are still there: ${left.join(', ')}`)
  }

  try {
    // Written first, so `stop` can clean up whatever happens next.
    writeFileSync(runFile(stateDir), JSON.stringify({ pid: process.pid, project, agentId: policy.agentId, policyHash: policy.hash, startedAt: new Date().toISOString() } satisfies RunRecord) + '\n', { mode: 0o600 })
    route = await startModelRoute({
      upstream: o.config.model.baseUrl, upstreamKey: o.secrets.modelKey, placeholder: `PLACEHOLDER-${cellNonce}`, shape: OPENAI_CHAT,
      policy: () => door?.policy() ?? policy, receipts,
      prices: { [o.config.model.id]: { inPerMTok: o.config.model.usdPerMTokIn, outPerMTok: o.config.model.usdPerMTokOut } },
      ledger: createFileLedger(path.join(stateDir, 'spend.json')),
      host: '127.0.0.1', port: routePort,
    })

    // The cell comes up, and is looked at from outside, before anything is connected to Discord.
    const composePath = path.join(stateDir, 'compose.json')
    writeFileSync(composePath, JSON.stringify(file, null, 2), { mode: 0o600 })
    cellUp(file, composePath)
    const running = runningCellProblems(project)
    if (running.length > 0) throw new Error(`the cell is not sealed: ${running.join('; ')}`)
    o.log(`cell up and sealed (${project})`)

    const connector: SurfaceConnector = createDiscordConnector({
      ...(o.discord ?? {}),
      sendScope: [o.config.discord.channelId], guildId: o.config.discord.guildId,
      messageContent: o.config.discord.readAllMessages, log: o.log, onFatal: o.onFatal,
    })
    door = await createDoor({
      policy, connectors: [connector], creds: { discord: { token: o.secrets.discordToken } }, live: ['discord'],
      receipts, brainToken, brainPort, sanitizer: createSanitizer({ extraSecrets: secrets }), turnDeadlineMs: 180_000,
    })
    await withTimeout(door.shimConnected(), o.cellReadyMs ?? 60_000, 'the cell did not reach the door in time')
    o.log(`live: agent ${policy.agentId}, policy ${policy.hash.slice(0, 12)}, one channel`)
    return { project, door, stop }
  } catch (err) {
    await stop()
    throw err
  }
}

/**
 * The dry run's containment checks. The real cell is started the way a real
 * run starts it, with a door that has no connector and a model route that
 * points nowhere. Then the lab's probe tries every way out from inside, and
 * a sink and a listener on this machine say what they saw from outside.
 * Nothing is connected to Discord and no model is called.
 */
export async function sealChecks(o: { model: string; workDir: string; log: (line: string) => void; broken?: CellOptions['broken'] }): Promise<Check[]> {
  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const [brainPort, routePort] = [await freePort(), await freePort()]
  const options: CellOptions = { nonce, cellNonce, brainToken, brainPort, routePort, model: o.model, withSink: true, broken: o.broken }
  const file = renderCell(options)
  const checks: Check[] = []
  const add = (id: string, title: string, problems: string[]): void => { checks.push({ id, title, pass: problems.length === 0, detail: problems.join('; ') || 'ok' }) }
  add('S0', 'the cell as written is sealed: one network with no way out, read-only, no host folder, no secret', sealProblems(file))

  const targets = findTargets()
  const host = await startHostListener()
  const policy = policyFor(DRY_POLICY_CONFIG(o.model))
  const receipts = createReceiptLog()
  const door = await createDoor({ policy, connectors: [], creds: {}, receipts, brainToken, brainPort })
  const route = await startModelRoute({
    upstream: 'http://127.0.0.1:9/v1', upstreamKey: `UPSTREAM-${cellNonce}`, placeholder: `PLACEHOLDER-${cellNonce}`, shape: OPENAI_CHAT,
    policy: () => policy, receipts, prices: {}, ledger: createMemoryLedger(), host: '127.0.0.1', port: routePort,
  })
  const composePath = path.join(o.workDir, `compose-${nonce}.json`)
  try {
    writeFileSync(composePath, JSON.stringify(file, null, 2), { mode: 0o600 })
    cellUp(file, composePath, ['sink', 'control'])
    const sinkIp = docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${project}_outside").IPAddress}}`, `${project}-sink-1`]).out.trim()
    cellUp(file, composePath, ['door', 'cell'])
    o.log(`cell up for the dry run (${project})`)
    const reached = await withTimeout(door.shimConnected().then(() => true), 60_000, '').catch(() => false)
    add('S0r', 'the cell reaches the door through the relay, with its own cell token', reached ? [] : ['the cell never reached the door, so nothing else was checked'])
    add('S0d', 'what Docker really gave the cell matches what was written', runningCellProblems(project))
    if (reached) {
      const seen = host.hits.length
      const probed = await probeCell(project, cellNonce, sinkIp, host.port, targets)
      await new Promise((resolve) => setTimeout(resolve, 300)) // let this process hear anything that reached its listener
      const sinkHits = docker(['logs', `${project}-sink-1`]).out.split('\n').filter((l) => l.startsWith('SINK-HIT '))
      const outside = [...sinkProblems(sinkHits, nonce), ...host.hits.slice(seen).map((url) => `a listener on this machine was reached from inside the cell (${url})`)]
      for (const c of probed) add(c.id, c.title, c.id === 'S1' ? [...c.problems, ...outside] : c.problems)
    }
  } finally {
    await door.close()
    await route.close()
    await host.close()
    const left = cellDown(project)
    rmSync(composePath, { force: true })
    add('S9', 'the dry run left no container behind', left)
  }
  return checks
}

/** A policy for the dry run's door. It has no connector, so the ids in it are never used. */
const DRY_POLICY_CONFIG = (model: string): LabConfig => ({
  agentId: 'dry-run',
  discord: {
    guildId: '100000000000000000', channelId: '100000000000000001', adminUserIds: ['100000000000000002'], allowedUserIds: [], allowedRoleIds: [],
    anyoneInChannel: false, mentionRequired: true, bots: 'none', botLoopLimit: 4, readAllMessages: false,
  },
  budget: { monthlyUsd: 1 },
  model: { baseUrl: 'https://model.invalid/v1', id: model, usdPerMTokIn: 0, usdPerMTokOut: 0 },
})

/** The kill switch, from another process: stop the door if it is running, then remove the cell by name. */
export async function stopRun(stateDir: string, log: (line: string) => void): Promise<boolean> {
  const run = readRun(stateDir)
  if (!run) { log('nothing to stop: no run is recorded here'); return true }
  // The pid is only signalled if it is still this launcher: a number on disk can outlive its process.
  const ours = (): boolean => alive(run.pid) && spawnSync('ps', ['-p', String(run.pid), '-o', 'command='], { encoding: 'utf8' }).stdout.includes('pi-discord')
  if (run.pid !== process.pid && ours()) {
    process.kill(run.pid, 'SIGTERM')
    for (let i = 0; i < 100 && ours(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    if (ours()) { process.kill(run.pid, 'SIGKILL'); log('the door did not stop when asked, so it was killed') }
  }
  // Whether or not the door cleaned up after itself, the cell is removed by name.
  const left = cellDown(run.project)
  if (existsSync(runFile(stateDir))) rmSync(runFile(stateDir), { force: true })
  rmSync(path.join(stateDir, 'compose.json'), { force: true })
  log(left.length === 0 ? `stopped: the door (pid ${run.pid}) is gone and the cell (${run.project}) is removed` : `these containers are still there: ${left.join(', ')}`)
  return left.length === 0
}
