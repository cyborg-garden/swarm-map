// The Docker runner: it starts one rig per check on this machine's Docker,
// reads the result from outside, and takes the rig down again.
//
// It only ever touches what it made. Every object carries the rig's project
// name (smlab-<nonce>), every stop and removal names that project, and
// nothing here prunes. It refuses a Docker that is not a local socket, an
// image that is not built, and a rig whose environment holds anything shaped
// like a real credential, before a container exists.
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { assertLocalDocker, assertNoCredentials, assertOurProject, assertSafeWorkDir, PROJECT_NAME, RefusingToRun } from '../guards/preflight.ts'
import type { CheckResult } from '../suites/checks.ts'
import { assertSealed, CELL_IMAGE, renderRig, RIG_IMAGE, SWARM_ROOT, type RigOptions, type RigVariant } from './compose.ts'
import { mountProblems, netProblems, parseReport, secretProblems, writeProblems, type ProbeReport } from './report.ts'

const REPO = path.resolve(import.meta.dirname, '..', '..')

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

export interface DockerFacts { endpoint: string; server: string; os: string; arch: string; /** Where a container on an ordinary network reaches this machine. Empty if Docker gives no such name. */ hostIp: string }

/** S0, the part that needs no rig: Docker is local, both images are built, and the cell holds the pinned harness. */
export function preflight(): DockerFacts {
  const endpoint = tryDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
  const info = tryDocker(['info', '--format', '{{.ServerVersion}}|{{.OperatingSystem}}|{{.Architecture}}'])
  if (!info.ok) throw new RefusingToRun('S0', 'the Docker daemon is not answering')
  for (const image of [CELL_IMAGE, RIG_IMAGE]) {
    if (!tryDocker(['image', 'inspect', '--format', '{{.Id}}', image]).ok) {
      throw new RefusingToRun('S0', `image ${image} is not built: run npm run conformance:docker:build`)
    }
  }
  const name = `smlab-${randomBytes(4).toString('hex')}-version`
  const version = tryDocker(['run', '--rm', '--name', name, '--network', 'none', '--pull', 'never', '-e', 'PI_OFFLINE=1', '-e', 'PI_TELEMETRY=0', '-e', 'PI_SKIP_VERSION_CHECK=1', CELL_IMAGE, 'pi', '--version'])
  if (version.out.trim() !== PI_VERSION) throw new RefusingToRun('S0', `the cell image does not hold the pinned harness version (${version.out.trim().slice(0, 40) || 'no answer'})`)
  // Asked from a container on Docker's default network, which is the one place the name resolves.
  // The container runs one lookup and is gone; no harness is in it.
  const lookup = tryDocker(['run', '--rm', '--name', `smlab-${randomBytes(4).toString('hex')}-lookup`, '--pull', 'never', RIG_IMAGE, 'node', '-e',
    'require("node:dns").lookup("host.docker.internal",{family:4},(e,a)=>console.log(e?"":a))'])
  const hostIp = /^\d+\.\d+\.\d+\.\d+$/.test(lookup.out.trim()) ? lookup.out.trim() : ''
  const [server, system, arch] = info.out.trim().split('|')
  return { endpoint, server, os: system, arch, hostIp }
}

/** Build both images. The only step that uses the network, and never part of a test run. */
export function buildImages(): void {
  for (const [target, tag] of [['cell', CELL_IMAGE], ['rig', RIG_IMAGE]] as const) {
    execFileSync('docker', ['build', '--target', target, '--tag', tag, '--file', path.join(REPO, 'conformance', 'docker', 'Dockerfile'), REPO],
      { env: dockerEnv(), stdio: 'inherit', timeout: 900_000 })
  }
}

/** Names of the lab's own containers, networks and volumes: anything that belongs to a compose project named like a rig. */
export function labObjects(): { containers: string[]; networks: string[]; volumes: string[] } {
  const list = (args: string[]): string[] => docker(args).split('\n').map((l) => l.trim()).filter(Boolean)
  const ours = (line: string): boolean => PROJECT_NAME.test(line.split(' ')[1] ?? '')
  const label = '{{.Name}} {{.Label "com.docker.compose.project"}}'
  return {
    containers: list(['ps', '-a', '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}']).filter(ours).map((l) => l.split(' ')[0]),
    networks: list(['network', 'ls', '--format', label]).filter(ours).map((l) => l.split(' ')[0]),
    volumes: list(['volume', 'ls', '--format', label]).filter(ours).map((l) => l.split(' ')[0]),
  }
}

/** Remove what a run left behind. By name, one at a time, and only what labObjects() lists. */
export function cleanLab(): { containers: string[]; networks: string[]; volumes: string[] } {
  const left = labObjects()
  for (const name of left.containers) tryDocker(['rm', '--force', name])
  for (const name of left.networks) tryDocker(['network', 'rm', name])
  for (const name of left.volumes) tryDocker(['volume', 'rm', name])
  return left
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
  inspect(service: string): { env: Record<string, string>; mounts: { Type: string; Name?: string; Source: string; Destination: string }[]; networks: string[]; readOnly: boolean; privileged: boolean }
  networkInternal(network: string): boolean
  sinkHits(): string[]
  /** Wait for a line starting with `marker` in the door's output. Undefined if the door stopped or time ran out. */
  doorLine(marker: string, timeoutMs: number): Promise<string | undefined>
}

export type RigRequest = Pick<RigOptions, 'check' | 'variant' | 'gate' | 'hostPort' | 'hostIp' | 'verdictTimeoutMs' | 'vetoTimeoutMs' | 'extraCellEnv'>

/** Start one rig, hand it to `body`, and take it down whatever happens. */
export async function withRig<T>(request: RigRequest, body: (rig: LiveRig) => Promise<T>): Promise<T> {
  const nonce = randomBytes(4).toString('hex')
  const options: RigOptions = { ...request, nonce, brainToken: `BRAIN-${nonce}-${randomBytes(8).toString('hex')}` }
  // F2 and F5 happen in here, before Docker is asked for anything.
  const project = renderRig(options).project
  const dir = mkdtempSync(path.join(os.tmpdir(), `${project}-`))
  assertSafeWorkDir(dir, { home: os.homedir(), tmp: os.tmpdir() })
  // The one folder of this machine a broken rig may mount: this rig's own, which holds its compose file and nothing else.
  options.hostDir = realpathSync(dir)
  const first = renderRig(options)
  if (request.variant === 'good') assertSealed(first)
  const file = path.join(dir, 'compose.json')
  const compose = (args: string[], timeoutMs = 120_000): string => docker(['compose', '--project-name', project, '--file', file, ...args], { timeoutMs })
  const container = (service: string): string => `${project}-${service}-1`
  try {
    // The sink first, so its address is known before the door is told what to have the cell try.
    writeFileSync(file, JSON.stringify(first.file, null, 2))
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
    assertOurProject(project, names)
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
          NetworkSettings: { Networks: Record<string, unknown> }; HostConfig: { ReadonlyRootfs: boolean; Privileged: boolean }
        }]
        return {
          env: Object.fromEntries(c.Config.Env.map((e) => { const i = e.indexOf('='); return [e.slice(0, i), e.slice(i + 1)] })),
          mounts: c.Mounts, networks: Object.keys(c.NetworkSettings.Networks).sort(),
          readOnly: c.HostConfig.ReadonlyRootfs, privileged: c.HostConfig.Privileged,
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
export async function runSealChecks(variant: RigVariant, host: HostListener, hostIp: string, hostCanary: { name: string; value: string }): Promise<CheckResult[]> {
  const seen = host.hits.length
  return withRig({ check: 'hold', variant, hostPort: host.port, hostIp }, async (rig) => {
    const s: Record<string, string[]> = { S0: [], S1: [], S2: [], S3: [] }
    const ready = await rig.doorLine('SMLAB-READY', 60_000)
    const probe = async (service: string): Promise<ProbeReport | undefined> =>
      parseReport(await rig.exec(service, ['node', `${SWARM_ROOT}/conformance/docker/probe.ts`, `nonce=${rig.nonce}`, `sink=${rig.sinkIp}`, `hostip=${hostIp}`, `hostport=${host.port}`]))
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

    // S2: nothing the cell runs can be changed from inside it.
    if (cell) s.S2.push(...writeProblems(cell))
    if (!seen2.readOnly) s.S2.push('the cell\'s disk is not read-only')
    if (seen2.privileged) s.S2.push('the cell is privileged')

    // S3: the environment Docker really gave the cell, the mounts it really has, and what can be read in there.
    try { assertNoCredentials(seen2.env, { nonce: rig.nonce }) } catch (err) { s.S3.push((err as Error).message) }
    if (Object.values(seen2.env).some((v) => v.includes(`UPSTREAM-${rig.nonce}`) || v.includes(`FAKECHAT-${rig.nonce}`))) s.S3.push('a secret of this run is in the cell\'s environment')
    const foreign = seen2.mounts.filter((m) => m.Type !== 'volume' || m.Name !== `${rig.project}_lab`)
    for (const m of foreign) s.S3.push(`mounted in the cell: ${m.Type} ${m.Source} at ${m.Destination}`)
    if (seen2.mounts.length !== 1) s.S3.push(`the cell has ${seen2.mounts.length} mounts, not the one shared folder`)
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
  const name = `smlab-${randomBytes(4).toString('hex')}-refuse`
  const flags = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`])
  const r = tryDocker(['run', '--rm', '--name', name, '--network', 'none', '--pull', 'never', '--read-only', '--tmpfs', '/tmp', ...flags, CELL_IMAGE, 'node', `${SWARM_ROOT}/conformance/docker/cell-main.ts`], { timeoutMs: 60_000 })
  return { code: r.code, out: r.out }
}

// `node conformance/docker/runner.ts build|clean`
if (path.resolve(process.argv[1] ?? '') === import.meta.filename) {
  const command = process.argv[2]
  if (command === 'build') { preflightDockerOnly(); buildImages() }
  else if (command === 'clean') { preflightDockerOnly(); console.log(JSON.stringify(cleanLab())) }
  else { console.error('usage: runner.ts build|clean'); process.exit(2) }
}

function preflightDockerOnly(): void {
  const endpoint = tryDocker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
}


