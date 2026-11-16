// Start, check and stop one agent in one Discord channel. The harness in the
// cell is Pi unless the config names another.
//
// The door runs in this process, on this machine: it holds the bot token and
// the model key, talks to Discord and to the model, and writes a receipt for
// every decision. The harness runs in the sealed cell and reaches the door through
// the relay. Nothing here puts a secret in a container, a log or an error.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { sinkProblems, startHostListener } from '../../../conformance/docker/runner.ts'
import { PROJECT_NAME } from '../../../conformance/guards/preflight.ts'
import type { SurfaceConnector } from '../../door/connector.ts'
import { createDiscordConnector } from '../../door/connectors/discord.ts'
import { createDoor, type Door } from '../../door/door.ts'
import { startModelRoute, type ModelRoute } from '../../door/model-route.ts'
import { OPENAI_CHAT } from '../../door/model-shapes.ts'
import { createReceiptLog } from '../../door/receipts.ts'
import { createSanitizer } from '../../door/sanitizer.ts'
import { createFileLedger, createMemoryLedger } from '../../door/spend-ledger.ts'
import { onFreeSubnets, pickSubnets, usedSubnets } from '../../../conformance/docker/subnets.ts'
import { cellDown, cellStopStart, cellUp, docker, dockerProblems, findTargets, launcherImages, networksWritten, probeCell, renderCell, runningCellProblems, sealProblems, type CellOptions } from './cell.ts'
import { harnessOf, policyFor, systemPromptFor, type LabConfig } from './config.ts'
import { DEFAULT_HARNESS, harnessFacts, type LauncherHarness } from './harnesses.ts'

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

const cellSubnets = ([cell, egress, outside]: string[]): CellOptions['subnets'] => ({ cell, egress, outside })
/** Every block in use on this Docker and this machine, asked each time a cell is about to be started. */
const blocksInUse = (): string[] => usedSubnets(docker)

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
  /** How long the cell has to reach the door before it is started again, once. */
  cellRedialMs?: number
  /** Tests only: start the cell again even though it reached the door, to show the door takes the cell that comes back. The command line never sets this. */
  redialCell?: boolean
}

/** What the last step of a start asks of the door, of Docker and of the clock. A test hands in all three. */
export interface JoinDeps {
  /** Whether a shim is connected to the door, now or within `ms`. */
  ready(ms: number): Promise<boolean>
  /** Stop the run's cell container, or start that same container again. False when Docker refused. */
  stopStart(what: 'stop' | 'start'): boolean
  /** What is wrong with the running cell, looked at from outside. Empty when it is the sealed cell that was written. */
  sealProblems(): string[]
  pause(ms: number): Promise<void>
  now(): number
  log(line: string): void
}

/**
 * The cell joins the door. The cell was started before the door was listening, so that it could be
 * looked at first. The relay takes the cell's dial whether or not the door is there yet, and a cell
 * that said hello to nobody does not dial again. If it is not heard from `redialMs` after the door is
 * up, it is started again, by name, once, and looked at again before it is waited for. It returns
 * with a cell connected, or throws: it never calls a start live on the strength of a cell that is gone.
 */
export async function joinCell(d: JoinDeps, o: { redialMs: number; readyMs: number; force?: boolean }): Promise<void> {
  const reached = await d.ready(o.redialMs)
  if (reached && o.force !== true) return
  if (!d.stopStart('stop')) throw new Error('the cell did not reach the door, and could not be stopped to be started again')
  // The door takes one shim at a time. If the cell got through just as it was stopped, the door is given
  // time to read what it sent and to see its link close, so the cell that starts next is not turned away.
  await d.pause(300)
  let held = await d.ready(0)
  for (const until = d.now() + 5_000; held && d.now() < until;) { await d.pause(50); held = await d.ready(0) }
  // A link that is still held would be taken for the cell that comes back, which the door would have turned away.
  if (held) throw new Error('the door still holds the link of the cell that was stopped, so the cell was not started again')
  if (!d.stopStart('start')) throw new Error('the cell did not reach the door, and could not be started again')
  const again = d.sealProblems()
  if (again.length > 0) throw new Error(`the cell is not sealed: ${again.join('; ')}`)
  d.log(reached ? 'the cell was started again' : 'the cell had not reached the door, so it was started again')
  if (!(await d.ready(o.readyMs))) throw new Error('the cell did not reach the door in time')
}

/** Bring one agent up. Either everything is up when this returns, or nothing is left running. */
export async function start(o: StartOptions): Promise<Running> {
  const stateDir = prepareStateDir(o.stateDir)
  const previous = readRun(stateDir)
  if (previous && alive(previous.pid)) throw new Error(`this agent is already running (pid ${previous.pid}). Stop it first`)
  // Named once, checked against the code on disk, and the cell is started from exactly these.
  const harness = harnessOf(o.config)
  const images = launcherImages(harness)
  const dockerIssues = dockerProblems(images, harness)
  if (dockerIssues.length > 0) throw new Error(dockerIssues.join('; '))
  // A run on record whose door is gone was killed before it could clean up. Its cell is sealed and
  // silent, but it is still there, and once this start writes its own record nothing would name it.
  if (previous && typeof previous.project === 'string' && PROJECT_NAME.test(previous.project)) {
    const left = cellDown(previous.project)
    if (left.length > 0) throw new Error(`the last run's containers could not be removed: ${left.join(', ')}`)
    o.log(`removed what the last run left behind (${previous.project})`)
  }

  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const policy = policyFor(o.config)
  const receipts = createReceiptLog({ file: path.join(stateDir, 'receipts.jsonl') })
  const [brainPort, routePort] = [await freePort(), await freePort()]
  const secrets = [o.secrets.discordToken, o.secrets.modelKey]
  // What the cell holds is no use off this machine, but none of it belongs in a channel either.
  const cellHeld = [brainToken, `PLACEHOLDER-${cellNonce}`, cellNonce]

  // Rendered here on three blocks of the lab's range, to be judged before anything is started. It is started on blocks that are free then.
  const cellOptions: CellOptions = { harness, nonce, cellNonce, brainToken, brainPort, routePort, model: o.config.model.id, systemPrompt: systemPromptFor(o.config), images, subnets: cellSubnets(pickSubnets(3, [])) }
  const problems = sealProblems(renderCell(cellOptions), secrets)
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
    // Its networks are made on blocks that are free now. If another start takes one in between,
    // Docker says so: what was made is removed, and the cell is started on others.
    const file = onFreeSubnets({ count: 3, used: blocksInUse }, (picked) => {
      const onThese = renderCell({ ...cellOptions, subnets: cellSubnets(picked) })
      const unsealed = sealProblems(onThese, secrets)
      if (unsealed.length > 0) throw new Error(`the cell is not sealed: ${unsealed.join('; ')}`)
      writeFileSync(composePath, JSON.stringify(onThese, null, 2), { mode: 0o600 })
      cellUp(onThese, composePath)
      return onThese
    }, () => { cellDown(project) })
    const running = runningCellProblems(project, networksWritten(file))
    if (running.length > 0) throw new Error(`the cell is not sealed: ${running.join('; ')}`)
    o.log(`cell up and sealed (${project})`)

    const connector: SurfaceConnector = createDiscordConnector({
      ...(o.discord ?? {}),
      sendScope: [o.config.discord.channelId], guildId: o.config.discord.guildId,
      messageContent: o.config.discord.readAllMessages, log: o.log, onFatal: o.onFatal,
    })
    door = await createDoor({
      policy, connectors: [connector], creds: { discord: { token: o.secrets.discordToken } }, live: ['discord'],
      receipts, brainToken, brainPort, sanitizer: createSanitizer({ extraSecrets: [...secrets, ...cellHeld] }), turnDeadlineMs: 180_000,
    })
    await joinCell({
      ready: (ms) => withTimeout(door!.shimConnected().then(() => true), ms, '').catch(() => false),
      stopStart: (what) => cellStopStart(project, what),
      sealProblems: () => runningCellProblems(project, networksWritten(file)),
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now, log: o.log,
    }, { redialMs: o.cellRedialMs ?? 3_000, readyMs: o.cellReadyMs ?? 60_000, force: o.redialCell === true })
    o.log(`live: agent ${policy.agentId}${harness === DEFAULT_HARNESS ? '' : ` on ${harnessFacts(harness).label} ${harnessFacts(harness).version}`}, policy ${policy.hash.slice(0, 12)}, one channel`)
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
export async function sealChecks(o: { model: string; workDir: string; log: (line: string) => void; broken?: CellOptions['broken']; harness?: LauncherHarness }): Promise<Check[]> {
  const harness = o.harness ?? DEFAULT_HARNESS
  const images = launcherImages(harness)
  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const [brainPort, routePort] = [await freePort(), await freePort()]
  const options: CellOptions = { harness, nonce, cellNonce, brainToken, brainPort, routePort, model: o.model, systemPrompt: systemPromptFor(DRY_POLICY_CONFIG(o.model)), images, withSink: true, broken: o.broken, subnets: cellSubnets(pickSubnets(3, [])) }
  const checks: Check[] = []
  const add = (id: string, title: string, problems: string[]): void => { checks.push({ id, title, pass: problems.length === 0, detail: problems.join('; ') || 'ok' }) }

  const targets = findTargets(images)
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
    // Started the way a real run starts it: on blocks that are free on this Docker now, and on others if one is taken in between.
    const { file, written, sinkIp } = onFreeSubnets({ count: 3, used: blocksInUse }, (picked) => {
      const subnets = cellSubnets(picked)
      const file = renderCell({ ...options, subnets })
      writeFileSync(composePath, JSON.stringify(file, null, 2), { mode: 0o600 })
      cellUp(file, composePath, ['sink', 'control'])
      const sinkIp = docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${project}_outside").IPAddress}}`, `${project}-sink-1`]).out.trim()
      cellUp(file, composePath, ['door', 'cell'])
      // What the networks were meant to be. A cell broken on purpose may have been written otherwise.
      return { file, written: networksWritten(renderCell({ ...options, subnets, broken: undefined })), sinkIp }
    }, () => { cellDown(project) })
    add('S0', 'the cell as written is sealed: one network with no way out, read-only, no host folder, no secret', sealProblems(file))
    o.log(`cell up for the dry run (${project})`)
    const reached = await withTimeout(door.shimConnected().then(() => true), 60_000, '').catch(() => false)
    add('S0r', 'the cell reaches the door through the relay, with its own cell token', reached ? [] : ['the cell never reached the door, so nothing else was checked'])
    add('S0d', 'what Docker really gave the cell matches what was written', runningCellProblems(project, written))
    if (reached) {
      const seen = host.hits.length
      const probed = await probeCell(project, cellNonce, sinkIp, host.port, targets, harness)
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
  persona: { name: 'dry-run', description: '' },
  discord: {
    guildId: '100000000000000000', channelId: '100000000000000001', adminUserIds: ['100000000000000002'], allowedUserIds: [], allowedRoleIds: [],
    anyoneInChannel: false, mentionRequired: true, bots: 'none', allowedBotIds: [], botLoopLimit: 4, readAllMessages: false,
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
