// The Docker rig for one check, as a compose file.
//
//   cell     (internal)   door <-> cell          the only way out of the cell is the door
//   outside  (internal)   sink, control          the sink stands in for "the internet"
//
// The door container is the sidecar's side: the door, the model route, the
// scripted model and the fake connector, in one process. The cell container
// holds the shim and the harness. The sink logs every connection it gets, and
// the control hits it once, to prove the sink and its log work. Nothing has a
// route off this machine: every network is internal, the test runner included.
//
// The file is rendered from a hand-listed set of values and nothing is
// inherited from the shell. No host folder is mounted and no port is
// published. The one thing two containers share is a named volume, where the
// cell writes what a tool touched and the door reads it.
//
// A variant other than `good` breaks the rig in one named way. Those exist so
// the checks can be shown to go red.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { assertNoCredentials, labPrefix, projectPattern, RefusingToRun } from '../guards/preflight.ts'

export const RIG_VARIANTS = ['good', 'route-out', 'open', 'leaks-env', 'leaks-file', 'writable', 'host-mount', 'socket', 'blind-sink', 'door-out'] as const
export type RigVariant = typeof RIG_VARIANTS[number]

const REPO = path.resolve(import.meta.dirname, '..', '..')

// The images are named for the code they were built from. A fixed name is
// shared by every checkout on a machine: whoever built last decides what every
// other run then tests, and nothing says so. With the hash of the source in
// the name, a run can only find an image built from the code it is testing.
/** Put on both images by the build: the hash of the source they were built from. */
export const SOURCE_LABEL = 'swarmlab.source'
/** Put on everything a run makes: the id of that run. Cleaning up goes by it. */
export const RUN_LABEL = 'swarmlab.run'

// What the builder is sent. This says again what Dockerfile.dockerignore says;
// if the two part, the rig image no longer holds exactly these files and the
// Docker run refuses to start.
const CONTEXT_ROOTS = ['lib/core', 'lib/door', 'lib/runtimes', 'conformance']
const sent = (rel: string): boolean =>
  !/(^|\/)(__tests__|node_modules)(\/|$)/.test(rel) && !/^conformance\/(matrix|out)(\/|$)/.test(rel)

/** Every file the builder is sent, as paths from the repo root, sorted. */
export function contextFiles(repo: string = REPO): string[] {
  const found: string[] = []
  const walk = (rel: string): void => {
    let entries
    try { entries = readdirSync(path.join(repo, rel), { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`
      if (!sent(child)) continue
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  for (const root of CONTEXT_ROOTS) walk(root)
  return found.sort()
}

export interface Source {
  /** Twelve hex digits over every file's path and content. */
  hash: string
  /** The SHA-256 of each file, by path. */
  files: Record<string, string>
}

/** The source as it is on disk now. */
export function readSource(repo: string = REPO): Source {
  const files: Record<string, string> = {}
  const all = createHash('sha256')
  for (const rel of contextFiles(repo)) {
    files[rel] = createHash('sha256').update(readFileSync(path.join(repo, rel))).digest('hex')
    all.update(`${files[rel]}  ${rel}\n`)
  }
  return { hash: all.digest('hex').slice(0, 12), files }
}

export interface LabImages { cell: string; rig: string; source: string }

/**
 * Which harness a cell holds. The rig is the same for every harness; what
 * differs is the cell's image, the script it starts with, and how to ask the
 * image which version of the harness is in it.
 */
export interface CellKind {
  harness: string
  /** The harness and its pinned version, as they go into the cell image's name. */
  name: string
  /** The Dockerfile stage the cell image is built from. */
  target: string
  /** The cell's entry script, under conformance/docker/. */
  entry: string
  /** How to ask the image for the harness version, with what environment, and what it must say. */
  version: { command: string[]; env: Record<string, string>; says: string }
}
export const PI_CELL: CellKind = {
  harness: 'pi', name: `pi-${PI_VERSION}`, target: 'cell', entry: 'cell-main.ts',
  version: { command: ['pi', '--version'], env: { PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' }, says: PI_VERSION },
}

/** The two image names for the code in `repo`, under this run's prefix. */
export function labImages(env: Record<string, string | undefined> = process.env, repo: string = REPO, kind: CellKind = PI_CELL): LabImages {
  const prefix = labPrefix(env)
  const source = readSource(repo).hash
  return { cell: `${prefix}-cell:${kind.name}-${source}`, rig: `${prefix}-rig:${source}`, source }
}

/**
 * Why an image is not the code under test. `seen.label` is what the image
 * says it was built from. `seen.listing` is what is really in it: one
 * `<sha256>  ./<path>` line for each file under the lab's folder. The label is
 * a claim, so the files are compared as well. The rig image must hold exactly
 * the source. The cell holds a part of it, so it may lack files, but every
 * file it has must be this code's.
 */
export function sourceProblems(kind: 'cell' | 'rig', image: string, seen: { label: string; listing: string }, expected: Source, cellEntry = PI_CELL.entry): string[] {
  const problems: string[] = []
  if (seen.label !== expected.hash) {
    const says = /^[0-9a-f]{12}$/.test(seen.label) ? `source ${seen.label}` : 'no source'
    problems.push(`image ${image} was built from other code: it names ${says}, and the code under test is ${expected.hash}`)
  }
  const inside = new Map<string, string>()
  for (const line of seen.listing.split('\n')) {
    const m = /^([0-9a-f]{64}) [ *]\.\/(.+)$/.exec(line)
    if (m) inside.set(m[2], m[1])
  }
  if (inside.size === 0) return [...problems, `image ${image}: its files could not be read, so it was not compared with the code under test`]
  const wrong: string[] = []
  for (const [rel, sum] of inside) {
    if (!(rel in expected.files)) wrong.push(`${rel} is not in this code`)
    else if (expected.files[rel] !== sum) wrong.push(`${rel} differs`)
  }
  const needed = kind === 'rig' ? Object.keys(expected.files) : [`conformance/docker/${cellEntry}`]
  for (const rel of needed) if (!inside.has(rel)) wrong.push(`${rel} is missing`)
  if (wrong.length > 0) {
    problems.push(`image ${image} does not hold the code under test: ${wrong.slice(0, 6).join(', ')}${wrong.length > 6 ? `, and ${wrong.length - 6} more` : ''}`)
  }
  return problems
}

/** Where both containers mount the shared volume. Under the temp dir, so the lab's work-dir guard holds inside too. */
export const LAB_DIR = '/tmp/smlab'
export const BRAIN_PORT = 7801
export const ROUTE_PORT = 7802
export const SINK_PORT = 8080
/** Where the lab's files sit in both images. */
export const SWARM_ROOT = '/opt/swarm'

export interface RigOptions {
  /** Eight hex digits. Names the project and stamps every fake of this run. */
  nonce: string
  brainToken: string
  /** The check the door container runs, or `hold` to stay up for probes from outside. */
  check: string
  variant: RigVariant
  /**
   * `allows-all` swaps the tool gate in the cell for one that lets every tool
   * run without asking. That is the gate removed: what is left is the wall.
   */
  gate?: 'real' | 'allows-all'
  /** The sink's address on the outside network, known once the sink is up. */
  sinkIp?: string
  /** A listener on this machine's loopback, which a sealed cell must not be able to reach. */
  hostPort?: number
  /** Addresses for the probe to try, found by the runner before any rig starts. */
  targets?: ProbeTargets
  /** `host-mount` and `socket` only: a folder on this machine to mount from. The runner hands in the rig's own temp dir, which holds nothing but the rig's own files. */
  hostDir?: string
  verdictTimeoutMs?: number
  vetoTimeoutMs?: number
  /** Negative controls only: more environment for the cell. It goes through the same F2 guard. */
  extraCellEnv?: Record<string, string>
  /** The prefix of every name. Left out, it is this run's (SWARMLAB_DOCKER_PREFIX, or `smlab`). */
  prefix?: string
  /** The images to start. Left out, they are the ones named for the code on disk. */
  images?: LabImages
  /** Which harness the cell holds. Left out, it is Pi. */
  cell?: CellKind
  /** Sixteen hex digits. Put as a label on every container, network and volume of the rig. */
  runId?: string
}

/**
 * Addresses the probe tries that are not the rig's own. None is written in this
 * repo: the runner asks for them before a run, from a container on Docker's
 * default network. One it could not find is left empty, and the probe then
 * reports that way out as not tried, which fails the check.
 */
export interface ProbeTargets {
  /** Where a container on an ordinary Docker network reaches this machine. */
  hostIp: string
  /** A public address that answers on port 443: where `example.com` resolved to. */
  publicIp: string
  /** A public DNS resolver, and its IPv6 address. */
  resolverIp: string
  resolverIp6: string
}
const ADDRESS = /^[0-9a-fA-F.:]*$/

/** The probe's arguments, the same for a probe run from outside and one the harness runs. */
export function probeArgs(nonce: string, sinkIp: string, hostPort: number | string, t: Partial<ProbeTargets> = {}): string[] {
  const args = { nonce, sink: sinkIp, hostport: String(hostPort), hostip: t.hostIp ?? '', public: t.publicIp ?? '', resolver: t.resolverIp ?? '', resolver6: t.resolverIp6 ?? '' }
  for (const [name, value] of Object.entries(args)) {
    if (!ADDRESS.test(value)) throw new RefusingToRun('F5', `probe argument ${name} is not an address`)
  }
  return Object.entries(args).map(([name, value]) => `${name}=${value}`)
}

export interface Service {
  image: string
  command: string[]
  networks: string[]
  environment: Record<string, string>
  pull_policy: 'never'
  restart: 'no'
  init: true
  stop_grace_period: '1s'
  read_only: boolean
  cap_drop: ['ALL']
  cap_add?: string[]
  security_opt: ['no-new-privileges:true']
  user: string
  tmpfs: string[]
  volumes?: string[]
  depends_on?: string[]
  sysctls?: Record<string, string>
  labels?: Record<string, string>
  pids_limit?: number
  mem_limit?: string
  cpus?: number
}

export interface ComposeFile {
  name: string
  services: Record<'door' | 'cell' | 'sink' | 'control', Service>
  networks: Record<string, { internal: boolean; enable_ipv6: false; labels?: Record<string, string> }>
  volumes: { lab: { labels?: Record<string, string> } }
}

export interface Rig { project: string; file: ComposeFile }

const NO_IPV6 = { 'net.ipv6.conf.all.disable_ipv6': '1' }

const entry = (script: string): string[] => ['node', `${SWARM_ROOT}/conformance/docker/${script}`]

function service(image: string, script: string, networks: string[], environment: Record<string, string>): Service {
  return {
    image, command: entry(script), networks: [...networks], environment: { ...environment },
    pull_policy: 'never', restart: 'no', init: true, stop_grace_period: '1s',
    read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], user: 'node',
    tmpfs: ['/tmp'], sysctls: NO_IPV6,
  }
}

/** The environment of every service, by service: what the F2 guard reads. */
export function rigEnv(file: ComposeFile): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(file.services).map(([name, s]) => [name, s.environment]))
}

export function renderRig(o: RigOptions): Rig {
  const prefix = o.prefix ?? labPrefix()
  const project = `${prefix}-${o.nonce}`
  if (!projectPattern(prefix).test(project)) throw new RefusingToRun('F5', `not a lab nonce: ${o.nonce}`)
  if (!RIG_VARIANTS.includes(o.variant)) throw new RefusingToRun('F5', `not a rig variant: ${o.variant}`)
  if (o.runId !== undefined && !/^[0-9a-f]{16}$/.test(o.runId)) throw new RefusingToRun('F5', 'not a run id')
  const kind = o.cell ?? PI_CELL
  const { cell: CELL_IMAGE, rig: RIG_IMAGE } = o.images ?? labImages(undefined, undefined, kind)

  const run = { SWARMLAB_NONCE: o.nonce, SWARMLAB_BRAIN: o.brainToken }
  const cell: Service = {
    ...service(CELL_IMAGE, kind.entry, ['cell'], {
      ...run,
      SMLAB_GATE: o.gate ?? 'real',
      SMLAB_VERDICT_MS: String(o.verdictTimeoutMs ?? 400),
      SMLAB_VETO_MS: String(o.vetoTimeoutMs ?? 2000),
      ...o.extraCellEnv,
    }),
    volumes: [`lab:${LAB_DIR}`], depends_on: ['door'], pids_limit: 256, mem_limit: '1g', cpus: 1,
  }
  const door: Service = {
    ...service(RIG_IMAGE, 'rig-main.ts', ['cell'], {
      ...run, SMLAB_CHECK: o.check, SMLAB_VARIANT: o.variant, SMLAB_GATE: o.gate ?? 'real', SMLAB_HARNESS: kind.harness,
      // What the harness will be asked to hand the probe. Addresses and a port, checked above all else to be only that.
      SMLAB_PROBE_ARGS: probeArgs(o.nonce, o.sinkIp ?? '', o.hostPort ?? 0, o.targets).join(' '),
    }),
    volumes: [`lab:${LAB_DIR}:ro`],
  }
  const file: ComposeFile = {
    name: project,
    services: {
      door, cell,
      sink: service(RIG_IMAGE, 'sink.ts', ['outside'], {}),
      control: { ...service(RIG_IMAGE, 'control.ts', ['outside'], { SWARMLAB_NONCE: o.nonce }), depends_on: ['sink'] },
    },
    networks: {
      cell: { internal: true, enable_ipv6: false },
      outside: { internal: true, enable_ipv6: false },
    },
    volumes: { lab: {} },
  }

  // The ways of breaking it. Each one is undone by nothing else in this file.
  if (o.variant === 'route-out') cell.networks.push('outside')
  if (o.variant === 'open') {
    cell.networks.push('open')
    file.networks.open = { internal: false, enable_ipv6: false }
  }
  if (o.variant === 'host-mount') cell.volumes!.push(`${o.hostDir ?? '/nonexistent'}:/mnt/host:ro`)
  // The control is put where it cannot reach the sink, so the sink's log stays empty and proves nothing.
  if (o.variant === 'blind-sink') file.services.control.networks = ['cell']
  if (o.variant === 'leaks-env') cell.environment.SWARMLAB_LEAK = `UPSTREAM-${o.nonce}`
  // The key is put in a file and nowhere else. It is written in two halves, so no environment
  // and no command line holds it: only a search of the disk can find it.
  if (o.variant === 'leaks-file') cell.command = ['sh', '-c', `printf '%s-%s' UPSTREAM ${o.nonce} > /tmp/leak-${o.nonce} && exec ${entry(kind.entry).join(' ')}`]
  // Not a Docker socket: an empty file of the rig's own, put where one would be. It shows the probe looks there.
  if (o.variant === 'socket') cell.volumes!.push(`${o.hostDir ?? '/nonexistent'}/docker.sock:/var/run/docker.sock:ro`)
  // The sidecar's side is given a way to the sink. The cell is left as it was.
  if (o.variant === 'door-out') door.networks.push('outside')
  // Root alone is not enough to write another user's folder once every capability is dropped,
  // so this one also gets back root's usual power over files.
  if (o.variant === 'writable') { cell.user = '0'; cell.read_only = false; cell.cap_add = ['DAC_OVERRIDE'] }

  // Last, so a network added by a broken rig carries it too.
  if (o.runId !== undefined) {
    const labels = { [RUN_LABEL]: o.runId }
    for (const part of [...Object.values(file.services), ...Object.values(file.networks), file.volumes.lab]) part.labels = { ...labels }
  }

  // F2, on exactly what each container is about to be handed. A run fake must carry this run's nonce.
  for (const [name, env] of Object.entries(rigEnv(file))) {
    try { assertNoCredentials(env, { nonce: o.nonce }) } catch (err) {
      throw new RefusingToRun('F2', `(service ${name}) ${(err as Error).message.replace(/^REFUSING TO RUN: F2 /, '')}`)
    }
  }
  return { project, file }
}

// Compose settings that share something with the host or with another container. No service of a sealed rig sets one.
const SHARING_KEYS = [
  'ports', 'privileged', 'network_mode', 'pid', 'ipc', 'userns_mode', 'uts', 'cgroup', 'volumes_from', 'links', 'external_links',
  'extra_hosts', 'dns', 'devices', 'cap_add', 'group_add', 'env_file', 'runtime', 'secrets', 'configs',
]

/**
 * Refuses a rig whose file does not describe a sealed cell. The Docker suite
 * calls this on every rig it expects to be sealed, so a change to this file
 * that opens the cell cannot pass as "good".
 */
export function assertSealed(rig: Rig, kind: CellKind = PI_CELL): void {
  const problems: string[] = []
  const { file } = rig
  for (const [name, network] of Object.entries(file.networks)) {
    if (network.internal !== true) problems.push(`network ${name} is not internal`)
  }
  const cell = file.services.cell
  if (cell.networks.join(',') !== 'cell') problems.push(`the cell is on ${cell.networks.join(' and ')}`)
  const door = file.services.door
  if (door.networks.join(',') !== 'cell') problems.push(`the sidecar is on ${door.networks.join(' and ')}`)
  if (door.volumes?.join(',') !== `lab:${LAB_DIR}:ro`) problems.push('the sidecar can write the shared folder, or mounts something else')
  if (cell.command.join(' ') !== entry(kind.entry).join(' ')) problems.push('the cell runs another command than its entry')
  if (cell.cap_drop?.join(',') !== 'ALL') problems.push('the cell keeps capabilities')
  if (cell.security_opt?.join(',') !== 'no-new-privileges:true') problems.push('the cell does not have no-new-privileges alone as its security option')
  if (cell.sysctls?.['net.ipv6.conf.all.disable_ipv6'] !== '1') problems.push('the cell does not have IPv6 switched off')
  if (cell.read_only !== true) problems.push('the cell can write its own disk')
  if (cell.user !== 'node') problems.push(`the cell runs as ${cell.user}`)
  if (cell.volumes?.join(',') !== `lab:${LAB_DIR}`) problems.push('the cell mounts something other than the shared folder')
  if (JSON.stringify(cell).includes(`UPSTREAM-${file.services.cell.environment.SWARMLAB_NONCE}`)) problems.push('the cell is handed the model key')
  if (JSON.stringify(file).includes('docker.sock')) problems.push('a Docker socket is named')
  if (file.services.control.networks.join(',') !== 'outside' || file.services.sink.networks.join(',') !== 'outside') problems.push('the control cannot reach the sink')
  for (const [name, s] of Object.entries(file.services)) {
    for (const key of SHARING_KEYS) {
      if (key in s) problems.push(`service ${name} sets ${key}`)
    }
  }
  if (problems.length > 0) throw new RefusingToRun('S0', `the rig is not sealed: ${problems.join('; ')}`)
}
