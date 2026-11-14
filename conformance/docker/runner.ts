// The Docker runner: it starts one rig per check on this machine's Docker,
// reads the result from outside, and takes the rig down again.
//
// It only ever touches what it made. Every object carries the rig's project
// name (<prefix>-<nonce>) and the id of the run that made it, every stop and
// removal names that project, and nothing here prunes. It refuses a Docker
// that is not a local socket, an image that was not built from the code under
// test, and a rig whose environment holds anything shaped like a real
// credential, before a rig exists.
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { assertLocalDocker, assertNoCredentials, assertOurProject, assertSafeWorkDir, DEFAULT_PREFIX, labPrefix, projectPattern, RefusingToRun } from '../guards/preflight.ts'
import type { CheckResult } from '../suites/checks.ts'
import {
  assertSealed, labImages, probeArgs, readSource, renderRig, RUN_LABEL, SOURCE_LABEL, sourceProblems, SWARM_ROOT,
  type LabImages, type ProbeTargets, type RigOptions, type RigVariant, type Source,
} from './compose.ts'
import { hostConfigProblems, mountProblems, netProblems, parseReport, secretProblems, writeProblems, type HostConfig, type ProbeReport } from './report.ts'

const REPO = path.resolve(import.meta.dirname, '..', '..')

/** This process's run. Everything it makes is labelled with it, and it removes nothing that is not. */
export const RUN_ID = randomBytes(8).toString('hex')

// What this worktree has made, written down as it is made: one
// `run <prefix> <id>` line for each run that started a container, one
// `image <name>` line for each image built here. `clean` is another process,
// started after a run was killed. This file is how it knows what was that
// run's and what was not.
const LEDGER = path.join(REPO, 'conformance', 'out', 'docker-ledger')
const LAB_IMAGE = /^[a-z][a-z0-9]{1,15}-(cell:pi-[0-9.]+-|rig:)[0-9a-f]{12}$/

export interface LabRun { prefix: string; id: string }
export interface Ledger { runs: LabRun[]; images: string[] }

/** The ledger's runs and images. A line that is not exactly a run or a per-source lab image is dropped. */
export function parseLedger(text: string): Ledger {
  const runs = new Map<string, LabRun>()
  const images = new Set<string>()
  for (const line of text.split('\n')) {
    const run = /^run ([a-z][a-z0-9]{1,15}) ([0-9a-f]{16})$/.exec(line)
    if (run) runs.set(`${run[1]} ${run[2]}`, { prefix: run[1], id: run[2] })
    const image = /^image (\S+)$/.exec(line)
    if (image && LAB_IMAGE.test(image[1])) images.add(image[1])
  }
  return { runs: [...runs.values()], images: [...images] }
}
function readLedger(): Ledger {
  try { return parseLedger(readFileSync(LEDGER, 'utf8')) } catch { return { runs: [], images: [] } }
}
function note(line: string): void {
  mkdirSync(path.dirname(LEDGER), { recursive: true })
  appendFileSync(LEDGER, `${line}\n`)
}
let noted = false
/** Called before this process starts its first container. */
function noteRun(): void {
  if (noted) return
  note(`run ${labPrefix()} ${RUN_ID}`)
  noted = true
}

// The images preflight() checked against the code under test. No rig starts from any other.
let checked: LabImages | undefined
function checkedImages(): LabImages {
  if (!checked) throw new RefusingToRun('S0', 'the images were not compared with the code under test: preflight() comes first')
  return checked
}

/** A one-off container of this run, outside any rig. It removes itself when it stops. */
function oneOff(kind: 'version' | 'lookup' | 'refuse' | 'source', flags: string[], image: string, command: string[], timeoutMs?: number): { ok: boolean; out: string; code: number | null } {
  noteRun()
  const name = `${labPrefix()}-${randomBytes(4).toString('hex')}-${kind}`
  return tryDocker(['run', '--rm', '--name', name, '--label', `${RUN_LABEL}=${RUN_ID}`, '--pull', 'never', ...flags, image, ...command], { timeoutMs })
}

/** The environment the docker CLI gets: listed by hand, nothing else passed down. */
function dockerEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env as NodeJS.ProcessEnv
}

function docker(args: string[], opts: { timeoutMs?: number } = {}): string {
  return execFileSync('docker', args, { env: dockerEnv(), encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
}
/** Like docker(), but a failure is an answer, not an exception, and what went to the error stream is kept. */
function tryDocker(args: string[], opts: { timeoutMs?: number } = {}): { ok: boolean; out: string; code: number | null } {
  const r = spawnSync('docker', args, { env: dockerEnv(), encoding: 'utf8', timeout: opts.timeoutMs ?? 120_000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status }
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface DockerFacts { endpoint: string; server: string; os: string; arch: string; targets: ProbeTargets; images: LabImages }

/** What an image says it was built from, and the hash of every file it really holds under the lab's folder. */
export function seeImage(image: string): { label: string; listing: string } {
  const label = tryDocker(['image', 'inspect', '--format', `{{index .Config.Labels "${SOURCE_LABEL}"}}`, image])
  const listing = oneOff('source', ['--network', 'none', '--read-only', '--entrypoint', 'sh'], image,
    ['-c', `cd ${SWARM_ROOT} && find . -type f -print0 | xargs -0 sha256sum`], 60_000)
  return { label: label.ok ? label.out.trim() : '', listing: listing.ok ? listing.out : '' }
}

/** Why these two images are not the code in `expected`. Empty when they are. */
export function imageProblems(images: LabImages, expected: Source): string[] {
  return [
    ...sourceProblems('cell', images.cell, seeImage(images.cell), expected),
    ...sourceProblems('rig', images.rig, seeImage(images.rig), expected),
  ]
}

/**
 * S0, the part that needs no rig: Docker is local, both images were built
 * from the code under test, and the cell holds the pinned harness.
 */
export function preflight(): DockerFacts {
  const endpoint = tryDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
  const info = tryDocker(['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}|{{.Architecture}}'])
  if (!info.ok) throw new RefusingToRun('S0', 'the Docker daemon is not answering')
  // Read once, here. Every rig of this run is started from these two names.
  const source = readSource()
  const images = labImages()
  if (images.source !== source.hash) throw new RefusingToRun('S0', 'the code under test changed while it was being read')
  for (const image of [images.cell, images.rig]) {
    if (!tryDocker(['image', 'inspect', '--format', '{{.Id}}', image]).ok) {
      throw new RefusingToRun('S0', `image ${image} is not built for this code: run npm run conformance:docker:build`)
    }
  }
  // Before anything is run from them: they hold this code, and say so.
  const problems = imageProblems(images, source)
  if (problems.length > 0) throw new RefusingToRun('S0', problems.join('; '))
  const version = oneOff('version', ['--network', 'none', '-e', 'PI_OFFLINE=1', '-e', 'PI_TELEMETRY=0', '-e', 'PI_SKIP_VERSION_CHECK=1'], images.cell, ['pi', '--version'])
  if (version.out.trim() !== PI_VERSION) throw new RefusingToRun('S0', `the cell image does not hold the pinned harness version (${version.out.trim().slice(0, 40) || 'no answer'})`)
  const [server, system, arch] = info.out.trim().split('|')
  checked = images
  return { endpoint, server, os: system, arch, targets: findTargets(), images }
}

/**
 * The addresses the probe will try, asked from a container on Docker's default
 * network: the one place this machine's Docker name resolves, and a place with
 * DNS. The container runs lookup.ts and is gone; no harness is in it. No
 * address is written in this repo. One that cannot be found stays empty, and
 * the checks that need it then fail rather than pass untried.
 */
export function findTargets(): ProbeTargets {
  const lookup = oneOff('lookup', [], checkedImages().rig, ['node', `${SWARM_ROOT}/conformance/docker/lookup.ts`])
  let found: Partial<ProbeTargets> = {}
  try { found = JSON.parse(lookup.out.trim().split('\n').pop() ?? '{}') as Partial<ProbeTargets> } catch { /* nothing found */ }
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { hostIp: text(found.hostIp), publicIp: text(found.publicIp), resolverIp: text(found.resolverIp), resolverIp6: text(found.resolverIp6) }
}

/**
 * Build both images, named for the code they are built from and labelled with
 * its hash. The only step that uses the network, and never part of a test run.
 */
export function buildImages(opts: { noCache?: boolean } = {}): LabImages {
  const images = labImages()
  for (const [target, tag] of [['cell', images.cell], ['rig', images.rig]] as const) {
    note(`image ${tag}`)
    execFileSync('docker', ['build', ...(opts.noCache ? ['--no-cache'] : []), '--target', target, '--tag', tag, '--label', `${SOURCE_LABEL}=${images.source}`,
      '--file', path.join(REPO, 'conformance', 'docker', 'Dockerfile'), REPO],
    { env: dockerEnv(), stdio: 'inherit', timeout: 900_000 })
  }
  // The source is read again: a file saved during the build would leave images that are not what their name says.
  if (labImages().source !== images.source) throw new RefusingToRun('S0', 'the code changed during the build: build again')
  return images
}

/**
 * From lines of `<name> <compose project>`, the names that are the lab's own.
 * Two things must both hold: the project is named like a rig, and the name
 * starts with that project. A label alone is a claim anyone can make, so
 * nothing is ever removed whose own name does not begin with the lab's prefix.
 */
export function ownedNames(lines: string[], prefix: string = DEFAULT_PREFIX): string[] {
  const rig = projectPattern(prefix)
  return lines.map((line) => line.trim().split(' ')).filter(([name, project, ...rest]) =>
    rest.length === 0 && rig.test(project ?? '') && (name.startsWith(`${project}-`) || name.startsWith(`${project}_`)),
  ).map(([name]) => name)
}

/**
 * The one-off containers a run starts outside any rig (`<prefix>-<nonce>-version`, `-lookup`, `-refuse`, `-source`).
 * Each removes itself when it stops; one is only left behind if the run was killed while it was up.
 */
export function strayRunNames(names: string[], prefix: string = DEFAULT_PREFIX): string[] {
  const stray = new RegExp(`^${prefix}-[0-9a-f]{8}-(version|lookup|refuse|source)$`)
  return names.map((name) => name.trim()).filter((name) => stray.test(name))
}

export interface LabObjects { containers: string[]; networks: string[]; volumes: string[] }

/**
 * Names of the containers, networks and volumes made by the given runs: by
 * default, this process's own. Three things must all hold: the object carries
 * that run's label, it belongs to a compose project named like a rig of this
 * prefix (or is a one-off container named like one), and it is named for it.
 * Another run's objects are never listed, whatever they are called.
 */
export function labObjects(runs: LabRun[] = [{ prefix: labPrefix(), id: RUN_ID }]): LabObjects {
  const found: LabObjects = { containers: [], networks: [], volumes: [] }
  const lines = (args: string[]): string[] => docker(args).split('\n').filter((l) => l.trim() !== '')
  for (const { prefix, id } of runs) {
    if (!/^[0-9a-f]{16}$/.test(id) || !/^[a-z][a-z0-9]{1,15}$/.test(prefix)) continue
    const mine = ['--filter', `label=${RUN_LABEL}=${id}`]
    const label = '{{.Name}} {{.Label "com.docker.compose.project"}}'
    found.containers.push(...ownedNames(lines(['ps', '-a', ...mine, '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}']), prefix))
    found.containers.push(...strayRunNames(lines(['ps', '-a', ...mine, '--format', '{{.Names}}']), prefix))
    found.networks.push(...ownedNames(lines(['network', 'ls', ...mine, '--format', label]), prefix))
    found.volumes.push(...ownedNames(lines(['volume', 'ls', ...mine, '--format', label]), prefix))
  }
  return found
}

/**
 * Remove what this worktree's runs left behind: by name, one at a time, and
 * only what labObjects() lists for the runs in the ledger. With `images`, also
 * the images this worktree built, by their exact names and without force, so
 * one that a container still uses stays. Images built anywhere else, and the
 * runs of any other worktree, are not touched.
 */
export function cleanLab(opts: { images?: boolean } = {}): LabObjects & { images: string[] } {
  const ledger = readLedger()
  const left = labObjects(ledger.runs)
  for (const name of left.containers) tryDocker(['rm', '--force', name])
  for (const name of left.networks) tryDocker(['network', 'rm', name])
  for (const name of left.volumes) tryDocker(['volume', 'rm', name])
  const removed: string[] = []
  const kept: string[] = []
  for (const image of ledger.images) {
    if (!opts.images) { kept.push(image); continue }
    if (!tryDocker(['image', 'inspect', '--format', '{{.Id}}', image]).ok) continue
    if (tryDocker(['image', 'rm', image]).ok) removed.push(image)
    else kept.push(image)
  }
  // The runs are dealt with. What is still written down is the images that are still there.
  try { writeFileSync(LEDGER, kept.map((image) => `image ${image}\n`).join('')) } catch { /* nothing was ever written down */ }
  return { ...left, images: removed }
}

/** A listener on this machine's loopback. A sealed cell must not be able to reach it. */
export interface HostListener { port: number; hits: string[]; close(): Promise<void> }
export function startHostListener(): Promise<HostListener> {
  const hits: string[] = []
  const server = http.createServer((req, res) => { hits.push(req.url ?? '?'); res.end('host') })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port, hits,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) }),
  })))
}

export interface LiveRig {
  project: string
  nonce: string
  sinkIp: string
  container(service: string): string
  logs(service: string): string
  /** Run a command in a container. Not blocking: this process must keep answering while the command runs. */
  exec(service: string, command: string[]): Promise<string>
  inspect(service: string): { env: Record<string, string>; mounts: { Type: string; Name?: string; Source: string; Destination: string }[]; networks: string[]; readOnly: boolean; privileged: boolean; host: HostConfig }
  networkInternal(network: string): boolean
  sinkHits(): string[]
  /** Wait for a line starting with `marker` in the door's output. Undefined if the door stopped or time ran out. */
  doorLine(marker: string, timeoutMs: number): Promise<string | undefined>
}

export type RigRequest = Pick<RigOptions, 'check' | 'variant' | 'gate' | 'hostPort' | 'targets' | 'verdictTimeoutMs' | 'vetoTimeoutMs' | 'extraCellEnv'>

/** Start one rig, hand it to `body`, and take it down whatever happens. */
export async function withRig<T>(request: RigRequest, body: (rig: LiveRig) => Promise<T>): Promise<T> {
  const nonce = randomBytes(4).toString('hex')
  const prefix = labPrefix()
  const options: RigOptions = { ...request, nonce, brainToken: `BRAIN-${nonce}-${randomBytes(8).toString('hex')}`, prefix, runId: RUN_ID, images: checkedImages() }
  // F2 and F5 happen in here, before Docker is asked for anything.
  const project = renderRig(options).project
  const dir = mkdtempSync(path.join(os.tmpdir(), `${project}-`))
  assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })
  // The one folder of this machine a broken rig may mount: this rig's own, which holds its compose file and nothing else.
  options.hostDir = realpathSync(dir)
  // `socket` only: an empty file of the rig's own, to be mounted where a Docker socket would be.
  if (request.variant === 'socket') writeFileSync(path.join(dir, 'docker.sock'), '')
  const first = renderRig(options)
  if (request.variant === 'good') assertSealed(first)
  const file = path.join(dir, 'compose.json')
  const compose = (args: string[], timeoutMs = 120_000): string => docker(['compose', '--project-name', project, '--file', file, ...args], { timeoutMs })
  const container = (service: string): string => `${project}-${service}-1`
  try {
    // The sink first, so its address is known before the door is told what to have the cell try.
    writeFileSync(file, JSON.stringify(first.file, null, 2))
    noteRun()
    compose(['up', '--detach', '--no-build', '--pull', 'never', 'sink', 'control'])
    const sinkIp = docker(['inspect', '--format', `{{(index .NetworkSettings.Networks "${project}_outside").IPAddress}}`, container('sink')]).trim()
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(sinkIp)) throw new Error(`the sink has no address (${sinkIp})`)
    const rig = renderRig({ ...options, sinkIp })
    if (request.variant === 'good') assertSealed(rig)
    writeFileSync(file, JSON.stringify(rig.file, null, 2))
    // Only the two that are not up yet: naming the control again would send it to the sink a second time.
    compose(['up', '--detach', '--no-build', '--pull', 'never', 'door', 'cell'])
    // F5: everything that came up is this rig's, by name.
    const names = docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).split('\n').filter(Boolean)
    assertOurProject(project, names, prefix)
    if (names.length !== 4) throw new Error(`expected 4 containers in ${project}, found ${names.length}`)

    const live: LiveRig = {
      project, nonce, sinkIp, container,
      logs: (service) => { const r = tryDocker(['logs', container(service)]); return r.out },
      exec: (service, command) => new Promise((resolve) => {
        execFile('docker', ['exec', container(service), ...command], { env: dockerEnv(), encoding: 'utf8', timeout: 90_000, maxBuffer: 64 * 1024 * 1024 },
          (_err, stdout, stderr) => resolve(`${stdout}${stderr}`))
      }),
      inspect: (service) => {
        const [c] = JSON.parse(docker(['inspect', container(service)])) as [{
          Config: { Env: string[] }; Mounts: { Type: string; Name?: string; Source: string; Destination: string }[]
          NetworkSettings: { Networks: Record<string, unknown> }; HostConfig: HostConfig & { ReadonlyRootfs: boolean }
        }]
        return {
          env: Object.fromEntries(c.Config.Env.map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)] })),
          mounts: c.Mounts, networks: Object.keys(c.NetworkSettings.Networks).sort(),
          readOnly: c.HostConfig.ReadonlyRootfs, privileged: c.HostConfig.Privileged, host: c.HostConfig,
        }
      },
      networkInternal: (network) => docker(['network', 'inspect', '--format', '{{.Internal}}', network]).trim() === 'true',
      sinkHits: () => live.logs('sink').split('\n').filter((line) => line.startsWith('SINK-HIT ')),
      doorLine: async (marker, timeoutMs) => {
        const deadline = Date.now() + timeoutMs
        for (;;) {
          const line = live.logs('door').split('\n').find((l) => l.startsWith(marker))
          if (line !== undefined) return line
          const running = tryDocker(['inspect', '--format', '{{.State.Running}}', container('door')]).out.trim()
          if (running !== 'true' || Date.now() > deadline) return live.logs('door').split('\n').find((l) => l.startsWith(marker))
          await sleep(250)
        }
      },
    }
    return await body(live)
  } finally {
    tryDocker(['compose', '--project-name', project, '--file', file, 'down', '--volumes', '--remove-orphans', '--timeout', '1'], { timeoutMs: 120_000 })
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What the sink's own log says. Exactly one line, from the control, or the run proves nothing or something got out. */
export function sinkProblems(hits: string[], nonce: string): string[] {
  const fromControl = hits.filter((line) => line.includes(`/control-${nonce}`))
  const others = hits.filter((line) => !line.includes(`/control-${nonce}`))
  const p: string[] = []
  if (fromControl.length !== 1) p.push(`the control reached the sink ${fromControl.length} times, not once, so the sink's log proves nothing`)
  for (const line of others) p.push(`the sink was reached from inside the rig: ${line.slice('SINK-HIT '.length)}`)
  return p
}

const hostProblems = (host: HostListener, before: number): string[] =>
  host.hits.slice(before).map((url) => `a listener on this machine was reached from inside the rig (${url})`)

/** Run one check in a rig of its own. What was seen from outside the rig is added to what the check found inside. */
export async function runInRig(id: string, title: string, request: Omit<RigRequest, 'check' | 'hostPort'>, host: HostListener, timeoutMs = 120_000): Promise<CheckResult> {
  const seen = host.hits.length
  return withRig({ ...request, check: id, hostPort: host.port }, async (rig) => {
    const line = await rig.doorLine('SMLAB-RESULT ', timeoutMs)
    const problems: string[] = []
    let inside: CheckResult | undefined
    try { inside = line ? JSON.parse(line.slice('SMLAB-RESULT '.length)) as CheckResult : undefined } catch { /* not a result */ }
    if (!inside) problems.push(`the rig gave no result: ${rig.logs('door').trim().split('\n').slice(-3).join(' | ').slice(0, 400) || 'the door said nothing'}`)
    else if (!inside.pass) problems.push(inside.detail)
    await sleep(300) // let this process hear anything that reached its listener
    problems.push(...sinkProblems(rig.sinkHits(), rig.nonce), ...hostProblems(host, seen))
    return { id, title, pass: problems.length === 0, detail: problems.join('; ') || 'ok' }
  })
}

export const SEAL_CHECKS = [
  { id: 'S0', title: 'the rig is this machine\'s, is the lab\'s own, holds no real credential, and its sink can be hit' },
  { id: 'S1', title: 'the cell cannot reach the internet, this machine or the sink, only the sidecar; nor can the sidecar' },
  { id: 'S2', title: 'the shim, the gate and the harness are not writable from inside the cell' },
  { id: 'S3', title: 'no host credential, host folder or secret of the run is in the cell\'s environment, mounts or disk' },
] as const

/** S0 to S3: start a rig that stays up, and look at its containers from outside. */
export async function runSealChecks(variant: RigVariant, host: HostListener, targets: ProbeTargets, hostCanary: { name: string; value: string }): Promise<CheckResult[]> {
  const seen = host.hits.length
  return withRig({ check: 'hold', variant, hostPort: host.port, targets }, async (rig) => {
    const s: Record<string, string[]> = { S0: [], S1: [], S2: [], S3: [] }
    const ready = await rig.doorLine('SMLAB-READY', 60_000)
    const probe = async (service: string): Promise<ProbeReport | undefined> =>
      parseReport(await rig.exec(service, ['node', `${SWARM_ROOT}/conformance/docker/probe.ts`, ...probeArgs(rig.nonce, rig.sinkIp, host.port, targets)]))
    const cell = ready ? await probe('cell') : undefined
    const door = ready ? await probe('door') : undefined
    await sleep(300) // let this process hear anything that reached its listener
    const seen2 = rig.inspect('cell')

    if (!ready) for (const id of Object.keys(s)) s[id].push('the cell never reached the door, so nothing was checked')
    if (ready && !cell) for (const id of ['S1', 'S2', 'S3']) s[id].push('the probe did not run in the cell, so nothing was checked')

    // S0: the sink works and only the control reached it; nothing was inherited from this shell.
    if (process.env[hostCanary.name] !== hostCanary.value) s.S0.push('the host canary is not set in this process, so inheritance was not tested')
    for (const service of ['cell', 'door', 'sink', 'control']) {
      const env = rig.inspect(service).env
      if (Object.keys(env).includes(hostCanary.name) || Object.values(env).includes(hostCanary.value)) s.S0.push(`${service} inherited this shell's environment`)
    }

    // S1: nothing but the door answers, from the cell or from the door's own container.
    if (cell) s.S1.push(...netProblems(cell))
    if (ready && !door) s.S1.push('the probe did not run in the sidecar container')
    if (door) s.S1.push(...netProblems(door).map((problem) => `from the sidecar container: ${problem}`))
    if (seen2.networks.join(',') !== `${rig.project}_cell`) s.S1.push(`the cell is on ${seen2.networks.join(' and ')}`)
    for (const network of seen2.networks) if (!rig.networkInternal(network)) s.S1.push(`network ${network} is not internal`)
    // What Docker says it gave each side, whatever the compose file asked for.
    const given = hostConfigProblems(seen2.host, `${rig.project}_cell`)
    const sidecar = rig.inspect('door')
    s.S1.push(...given.net, ...hostConfigProblems(sidecar.host, `${rig.project}_cell`).net.map((problem) => `the sidecar container: ${problem}`))
    if (sidecar.networks.join(',') !== `${rig.project}_cell`) s.S1.push(`the sidecar container is on ${sidecar.networks.join(' and ')}`)

    // S2: nothing the cell runs can be changed from inside it.
    if (cell) s.S2.push(...writeProblems(cell))
    if (!seen2.readOnly) s.S2.push('the cell\'s disk is not read-only')
    s.S2.push(...given.privilege.map((problem) => `the cell: ${problem}`))

    // S3: the environment Docker really gave the cell, the mounts it really has, and what can be read in there.
    try { assertNoCredentials(seen2.env, { nonce: rig.nonce }) } catch (err) { s.S3.push((err as Error).message) }
    if (Object.values(seen2.env).some((v) => v.includes(`UPSTREAM-${rig.nonce}`) || v.includes(`FAKECHAT-${rig.nonce}`))) s.S3.push('a secret of this run is in the cell\'s environment')
    const foreign = seen2.mounts.filter((m) => m.Type !== 'volume' || m.Name !== `${rig.project}_lab`)
    for (const m of foreign) s.S3.push(`mounted in the cell: ${m.Type} ${m.Source} at ${m.Destination}`)
    if (seen2.mounts.length !== 1) s.S3.push(`the cell has ${seen2.mounts.length} mounts, not the one shared folder`)
    s.S3.push(...given.mounts.map((problem) => `the cell: ${problem}`))
    if (cell) s.S3.push(...mountProblems(cell), ...secretProblems(cell))
    if (cell?.dockerSocket) s.S3.push('a Docker socket is in the cell')

    // Seen from outside, last, so it covers everything the probes just tried.
    const outside = [...sinkProblems(rig.sinkHits(), rig.nonce), ...hostProblems(host, seen)]
    s.S0.push(...sinkProblems(rig.sinkHits(), rig.nonce).filter((problem) => problem.startsWith('the control')))
    s.S1.push(...outside.filter((problem) => !problem.startsWith('the control')))
    return SEAL_CHECKS.map(({ id, title }) => ({ id, title, pass: s[id].length === 0, detail: s[id].join('; ') || 'ok' }))
  })
}

/** In a cell that starts on its own, the entry refuses an environment with anything shaped like a real credential. */
export function cellRefuses(env: Record<string, string>): { code: number | null; out: string } {
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const r = oneOff('refuse', ['--network', 'none', '--read-only', '--tmpfs', '/tmp', ...flags], checkedImages().cell, ['node', `${SWARM_ROOT}/conformance/docker/cell-main.ts`], 60_000)
  return { code: r.code, out: r.out }
}

// `node conformance/docker/runner.ts build [--no-cache] | clean [--images]`
if (path.resolve(process.argv[1] ?? '') === import.meta.filename) {
  const [command, flag, ...rest] = process.argv.slice(2)
  if (command === 'build' && rest.length === 0 && (flag === undefined || flag === '--no-cache')) { preflightDockerOnly(); console.log(JSON.stringify(buildImages({ noCache: flag === '--no-cache' }))) }
  else if (command === 'clean' && rest.length === 0 && (flag === undefined || flag === '--images')) { preflightDockerOnly(); console.log(JSON.stringify(cleanLab({ images: flag === '--images' }))) }
  else { console.error('usage: runner.ts build [--no-cache] | clean [--images]'); process.exit(2) }
}

function preflightDockerOnly(): void {
  const endpoint = tryDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
}


