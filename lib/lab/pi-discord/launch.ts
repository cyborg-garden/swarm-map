// Start, check and stop one agent in one Discord channel. The harness in the
// cell is Pi unless the config names another.
//
// The door runs in this process, on this machine: it holds the bot token and
// the model key, talks to Discord and to the model, and writes a receipt for
// every decision. The harness runs in the sealed cell and reaches the door through
// the relay. Nothing here puts a secret in a container, a log or an error.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { sinkProblems, startHostListener } from '../../../conformance/docker/runner.ts'
import { PROJECT_NAME } from '../../../conformance/guards/preflight.ts'
import type { SurfaceConnector } from '../../door/connector.ts'
import { createDiscordConnector } from '../../door/connectors/discord.ts'
import { createDoor, type Door } from '../../door/door.ts'
import { startModelRoute, type ModelRoute } from '../../door/model-route.ts'
import { OPENAI_CHAT } from '../../door/model-shapes.ts'
import { createMemoryStore } from '../../door/memory.ts'
import { createReceiptLog } from '../../door/receipts.ts'
import { createSanitizer } from '../../door/sanitizer.ts'
import { createFileLedger, createMemoryLedger } from '../../door/spend-ledger.ts'
import { onFreeSubnets, pickSubnets, usedSubnets } from '../../../conformance/docker/subnets.ts'
import { DEFAULT_TOOL_LIMITS } from '../../core/tools/call.ts'
import { cellDown, cellStopStart, cellUp, type CellRole, KEPT_SCRATCH_FILE, KEPT_SCRATCH_RULES_FILE, keptScratchPlan, readScratch, writeScratch, docker, dockerProblems, findTargets, launcherImages, networksWritten, probeCell, renderCell, runningCellProblems, scratchProblems, sealProblems, type CellOptions } from './cell.ts'
import { approvalSecondsOf, channelIdsOf, harnessOf, reducedRoomsOf, turnSecondsOf, policyFor, statusOf, systemPromptFor, toolModes, type LabConfig } from './config.ts'
import { DEFAULT_HARNESS, harnessFacts, type LauncherHarness } from './harnesses.ts'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

/**
 * What is running. `reducedProject` is the second cell, for the channels with fewer tools, and is written
 * only when there is one: a record for one cell is as it always was.
 */
export interface RunRecord { pid: number; project: string; agentId: string; policyHash: string; startedAt: string; reducedProject?: string }
export interface Running { project: string; reducedProject?: string; door: Door; stop(): Promise<void> }
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
/** The second cell's compose file, beside the first's. */
const REDUCED_COMPOSE = 'compose-reduced.json'
/** Where the door keeps its notes for each room (lib/door/memory.ts): in the state folder, outside every cell. */
export const memoryDir = (stateDir: string): string => path.join(stateDir, 'memory')
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
  /** `searchKey` only when the config switches web search on. It is handed to the door and to nothing else. */
  secrets: { discordToken: string; modelKey: string; searchKey?: string }
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
  if (previous && typeof previous.reducedProject === 'string' && PROJECT_NAME.test(previous.reducedProject)) {
    const left = cellDown(previous.reducedProject)
    if (left.length > 0) throw new Error(`the last run's containers could not be removed: ${left.join(', ')}`)
    o.log(`removed the second cell the last run left behind (${previous.reducedProject})`)
  }

  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const policy = policyFor(o.config)
  const receipts = createReceiptLog({ file: path.join(stateDir, 'receipts.jsonl') })
  const [brainPort, routePort] = [await freePort(), await freePort()]
  if (o.config.tools?.web?.search === true && !o.secrets.searchKey) throw new Error('web search is on, but there is no search key')
  const secrets = [o.secrets.discordToken, o.secrets.modelKey, ...(o.secrets.searchKey ? [o.secrets.searchKey] : [])]
  // What the cell holds is no use off this machine, but none of it belongs in a channel either.
  const cellHeld = [brainToken, `PLACEHOLDER-${cellNonce}`, cellNonce]

  // Rendered here on three blocks of the lab's range, to be judged before anything is started. It is started on blocks that are free then.
  // Where a class of tool waits for an admin, the door waits this long, and the cell is told to wait a little longer.
  const approvalSeconds = approvalSecondsOf(o.config)
  const approvalMs = approvalSeconds === undefined ? undefined : approvalSeconds * 1000
  const cellOptions: CellOptions = { harness, nonce, cellNonce, brainToken, brainPort, routePort, model: o.config.model.id, systemPrompt: systemPromptFor(o.config), images, subnets: cellSubnets(pickSubnets(3, [])), limits: DEFAULT_TOOL_LIMITS, approvalMs }
  const problems = sealProblems(renderCell(cellOptions), secrets)
  if (problems.length > 0) throw new Error(`the cell is not sealed: ${problems.join('; ')}`)

  // The second cell, when a channel has fewer tools than the agent's own: a cell of its own, built with the
  // web, search and notes only, a token and a port of its own, and the same door, model route and budget.
  // The channels with fewer tools are sent to it and to no other. With none, there is one cell, as always.
  const reducedRooms = reducedRoomsOf(o.config)
  const second = reducedRooms.length === 0 ? undefined : await (async () => {
    const nonce2 = randomBytes(4).toString('hex')
    const options: CellOptions = { ...cellOptions, nonce: nonce2, brainToken: `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`, brainPort: await freePort(), tools: 'reduced', approvalMs }
    const unsealed = sealProblems(renderCell(options), secrets, 'reduced')
    if (unsealed.length > 0) throw new Error(`the second cell is not sealed: ${unsealed.join('; ')}`)
    return { project: `smlab-${nonce2}`, options }
  })()
  if (second) cellHeld.push(second.options.brainToken)

  // One check for everything the door posts, writes down or keeps as a note.
  const sanitizer = createSanitizer({ extraSecrets: [...secrets, ...cellHeld] })
  // mem.notes: the room notes live here, on this machine, in this agent's state folder. The cell never sees the folder.
  const memory = o.config.memory?.notes === true ? createMemoryStore({ dir: memoryDir(stateDir), sanitizer }) : undefined
  // tools.keepScratch: the scratch folder as the cell left it at the last stop, put back in the new cell.
  const keep = o.config.tools?.keepScratch === true
  const keptFile = path.join(stateDir, KEPT_SCRATCH_FILE)
  const keptRulesFile = path.join(stateDir, KEPT_SCRATCH_RULES_FILE)
  // The tool rules the folder is kept under. It comes back only under the same ones (keptScratchPlan).
  const rulesNow = JSON.stringify(toolModes(o.config))
  let cellIsUp = false
  const dropKept = (): void => { rmSync(keptFile, { force: true }); rmSync(keptRulesFile, { force: true }) }
  const restoreScratch = (): void => {
    let rules: string | undefined
    try { rules = (JSON.parse(readFileSync(keptRulesFile, 'utf8')) as { rules?: unknown }).rules as string | undefined } catch { rules = undefined }
    const kept = existsSync(keptFile) ? { size: statSync(keptFile).size, rules: typeof rules === 'string' ? rules : undefined } : undefined
    const plan = keptScratchPlan({ keep, rulesNow, kept })
    if (plan === 'none') return
    if (plan === 'drop') {
      dropKept()
      o.log(!keep ? 'keeping the scratch folder is off, so the kept copy was removed'
        : kept!.rules !== rulesNow ? 'the kept scratch folder was kept under other tool rules, so it was removed and the folder starts empty'
          : 'the kept scratch folder is bigger than the folder may be, so it was removed and the folder starts empty')
      return
    }
    o.log(writeScratch(project, readFileSync(keptFile)) ? 'the kept scratch folder was put back' : 'the kept scratch folder could not be put back whole, so some of it may be missing')
  }
  const saveScratch = (): void => {
    if (!keep || !cellIsUp) return
    const { tar, why } = readScratch(project)
    if (!tar) {
      // A copy from an earlier stop would come back looking current. It is removed rather than kept stale.
      dropKept()
      o.log(`the scratch folder was not kept: ${why}`)
      return
    }
    writeFileSync(`${keptFile}.tmp`, tar, { mode: 0o600 })
    writeFileSync(`${keptRulesFile}.tmp`, JSON.stringify({ rules: rulesNow }) + '\n', { mode: 0o600 })
    renameSync(`${keptFile}.tmp`, keptFile)
    renameSync(`${keptRulesFile}.tmp`, keptRulesFile)
    o.log(`the scratch folder was kept (${tar.length} bytes)`)
  }

  let door: Door | undefined
  let route: ModelRoute | undefined
  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    await door?.close().catch(() => {})
    await route?.close().catch(() => {})
    try { saveScratch() } catch { o.log('the scratch folder could not be kept') }
    const left = [...cellDown(project), ...(second ? cellDown(second.project) : [])]
    rmSync(runFile(stateDir), { force: true })
    rmSync(path.join(stateDir, 'compose.json'), { force: true })
    if (second) rmSync(path.join(stateDir, REDUCED_COMPOSE), { force: true })
    o.log(left.length === 0 ? `stopped: the door is closed and the ${second ? 'two cells are' : 'cell is'} gone` : `stopped the door, but these containers are still there: ${left.join(', ')}`)
  }

  try {
    // Written first, so `stop` can clean up whatever happens next.
    writeFileSync(runFile(stateDir), JSON.stringify({ pid: process.pid, project, agentId: policy.agentId, policyHash: policy.hash, startedAt: new Date().toISOString(), ...(second ? { reducedProject: second.project } : {}) } satisfies RunRecord) + '\n', { mode: 0o600 })
    route = await startModelRoute({
      upstream: o.config.model.baseUrl, upstreamKey: o.secrets.modelKey, placeholder: `PLACEHOLDER-${cellNonce}`, shape: OPENAI_CHAT,
      policy: () => door?.policy() ?? policy, receipts,
      prices: { [o.config.model.id]: { inPerMTok: o.config.model.usdPerMTokIn, outPerMTok: o.config.model.usdPerMTokOut } },
      ledger: createFileLedger(path.join(stateDir, 'spend.json')),
      host: '127.0.0.1', port: routePort,
      // A call that is refused or fails is told to the room by the door, so the agent is never just silent.
      onFailure: (failure) => door?.modelFailed(failure),
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
    cellIsUp = true
    // The second cell, started and looked at the same way, on blocks that are free now (the first cell's are taken).
    const secondFile = second && onFreeSubnets({ count: 3, used: blocksInUse }, (picked) => {
      const onThese = renderCell({ ...second.options, subnets: cellSubnets(picked) })
      const unsealed = sealProblems(onThese, secrets, 'reduced')
      if (unsealed.length > 0) throw new Error(`the second cell is not sealed: ${unsealed.join('; ')}`)
      const at = path.join(stateDir, REDUCED_COMPOSE)
      writeFileSync(at, JSON.stringify(onThese, null, 2), { mode: 0o600 })
      cellUp(onThese, at)
      return onThese
    }, () => { cellDown(second.project) })
    if (second && secondFile) {
      const wrong = runningCellProblems(second.project, networksWritten(secondFile), 'reduced')
      if (wrong.length > 0) throw new Error(`the second cell is not sealed: ${wrong.join('; ')}`)
      o.log(`second cell up and sealed (${second.project}), with no shell or file tools, for ${reducedRooms.length} channel(s) with fewer tools`)
    }

    const connector: SurfaceConnector = createDiscordConnector({
      ...(o.discord ?? {}),
      // The connector posts in these channels and their threads, and refuses any other before a request is made.
      sendScope: channelIdsOf(o.config), guildId: o.config.discord.guildId,
      messageContent: o.config.discord.readAllMessages, log: o.log, onFatal: o.onFatal,
      // An admin may answer a request with a reaction. Only asked of Discord when a class of tool asks.
      reactions: approvalMs !== undefined,
    })
    door = await createDoor({
      policy, connectors: [connector], creds: { discord: { token: o.secrets.discordToken } }, live: ['discord'],
      receipts, brainToken, brainPort, sanitizer, memory, keptScratch: keep, status: statusOf(o.config),
      ...(o.config.tools?.web?.search === true && o.secrets.searchKey ? { search: { key: o.secrets.searchKey } } : {}), turnDeadlineMs: turnSecondsOf(o.config) * 1000,
      approvalTimeoutMs: approvalMs, toolCallsPerHour: DEFAULT_TOOL_LIMITS.callsPerHour,
      ...(second ? {
        reducedCell: { brainToken: second.options.brainToken, brainPort: second.options.brainPort, rooms: reducedRooms },
        onCellRefused: (cell: string, why: string) => { o.log(`the door turned away ${cell === 'reduced' ? 'the second cell' : 'the cell'}: ${why}`) },
      } : {}),
    })
    await joinCell({
      ready: (ms) => withTimeout(door!.shimConnected().then(() => true), ms, '').catch(() => false),
      stopStart: (what) => cellStopStart(project, what),
      sealProblems: () => runningCellProblems(project, networksWritten(file)),
      pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now, log: o.log,
    }, { redialMs: o.cellRedialMs ?? 3_000, readyMs: o.cellReadyMs ?? 60_000, force: o.redialCell === true })
    if (second && secondFile) {
      await joinCell({
        ready: (ms) => withTimeout(door!.reducedConnected!().then(() => true), ms, '').catch(() => false),
        stopStart: (what) => cellStopStart(second.project, what),
        sealProblems: () => runningCellProblems(second.project, networksWritten(secondFile), 'reduced'),
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: Date.now, log: (line) => o.log(`second cell: ${line}`),
      }, { redialMs: o.cellRedialMs ?? 3_000, readyMs: o.cellReadyMs ?? 60_000 })
    }
    // Put back once the cell has joined the door and is the cell that stays: a cell that is started again
    // comes back with an empty folder (it is in memory), and one that has not joined yet may be about to be.
    restoreScratch()
    o.log(`live: agent ${policy.agentId}${harness === DEFAULT_HARNESS ? '' : ` on ${harnessFacts(harness).label} ${harnessFacts(harness).version}`}, policy ${policy.hash.slice(0, 12)}, ${channelIdsOf(o.config).length === 1 ? 'one channel' : `${channelIdsOf(o.config).length} channels`}${second ? `, two cells (${reducedRooms.length} channel(s) in the second)` : ''}`)
    return { project, ...(second ? { reducedProject: second.project } : {}), door, stop }
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
export async function sealChecks(o: { model: string; workDir: string; log: (line: string) => void; broken?: CellOptions['broken']; harness?: LauncherHarness; role?: CellRole }): Promise<Check[]> {
  const role = o.role ?? 'own'
  const harness = o.harness ?? DEFAULT_HARNESS
  const images = launcherImages(harness)
  const nonce = randomBytes(4).toString('hex')
  const project = `smlab-${nonce}`
  const cellNonce = randomBytes(16).toString('hex')
  const brainToken = `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`
  const [brainPort, routePort] = [await freePort(), await freePort()]
  // The second cell dials a door port of its own, with a token of its own. The door's first port is then left with no cell.
  const reducedBrain = role === 'reduced' ? { token: `BRAIN-${cellNonce}-${randomBytes(8).toString('hex')}`, port: await freePort() } : undefined
  const options: CellOptions = {
    harness, nonce, cellNonce, brainToken: reducedBrain?.token ?? brainToken, brainPort: reducedBrain?.port ?? brainPort, routePort, model: o.model,
    systemPrompt: systemPromptFor(DRY_POLICY_CONFIG(o.model)), images, withSink: true, broken: o.broken, subnets: cellSubnets(pickSubnets(3, [])),
    ...(role === 'reduced' ? { tools: 'reduced' as const } : {}),
  }
  const checks: Check[] = []
  const add = (id: string, title: string, problems: string[]): void => { checks.push({ id, title, pass: problems.length === 0, detail: problems.join('; ') || 'ok' }) }

  const targets = findTargets(images)
  const host = await startHostListener()
  const policy = policyFor(DRY_POLICY_CONFIG(o.model))
  const receipts = createReceiptLog()
  const refused: string[] = []
  const door = await createDoor({
    policy, connectors: [], creds: {}, receipts, brainToken, brainPort,
    ...(reducedBrain ? { reducedCell: { brainToken: reducedBrain.token, brainPort: reducedBrain.port, rooms: [] }, onCellRefused: (_cell: string, why: string) => { refused.push(why) } } : {}),
  })
  const connected = (): Promise<void> => (reducedBrain ? door.reducedConnected!() : door.shimConnected())
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
    add('S0', 'the cell as written is sealed: one network with no way out, read-only, no host folder, no secret', sealProblems(file, [], role))
    o.log(`cell up for the dry run (${project})`)
    const reached = await withTimeout(connected().then(() => true), 60_000, '').catch(() => false)
    add('S0r', 'the cell reaches the door through the relay, with its own cell token', reached ? [] : ['the cell never reached the door, so nothing else was checked'])
    if (role === 'reduced') {
      add('S0t', 'the second cell holds no shell or file tool: the door takes it only as holding the web, search and notes',
        [...new Set(refused)].map((why) => `the door turned the cell away: ${why}`).concat(reached || refused.length > 0 ? [] : ['the cell never said what it holds']))
    }
    add('S0d', 'what Docker really gave the cell matches what was written', runningCellProblems(project, written, role))
    if (reached) {
      const seen = host.hits.length
      const probed = await probeCell(project, cellNonce, sinkIp, host.port, targets, harness)
      await new Promise((resolve) => setTimeout(resolve, 300)) // let this process hear anything that reached its listener
      const sinkHits = docker(['logs', `${project}-sink-1`]).out.split('\n').filter((l) => l.startsWith('SINK-HIT '))
      const outside = [...sinkProblems(sinkHits, nonce), ...host.hits.slice(seen).map((url) => `a listener on this machine was reached from inside the cell (${url})`)]
      for (const c of probed) add(c.id, c.title, c.id === 'S1' ? [...c.problems, ...outside] : c.problems)
      add('S4', 'the scratch folder, the cell\'s own folder and its /tmp can be written, and each takes no more than its size', scratchProblems(project))
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
  // Whether or not the door cleaned up after itself, the cell is removed by name, and the second cell if there is one.
  const second = typeof run.reducedProject === 'string' && PROJECT_NAME.test(run.reducedProject) ? run.reducedProject : undefined
  const left = [...cellDown(run.project), ...(second ? cellDown(second) : [])]
  if (existsSync(runFile(stateDir))) rmSync(runFile(stateDir), { force: true })
  rmSync(path.join(stateDir, 'compose.json'), { force: true })
  rmSync(path.join(stateDir, REDUCED_COMPOSE), { force: true })
  log(left.length === 0 ? `stopped: the door (pid ${run.pid}) is gone and the cell (${run.project}${second ? ` and ${second}` : ''}) is removed` : `these containers are still there: ${left.join(', ')}`)
  return left.length === 0
}
