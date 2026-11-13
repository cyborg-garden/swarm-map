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
import { PI_VERSION } from '../../lib/runtimes/pi/caps.ts'
import { assertNoCredentials, PROJECT_NAME, RefusingToRun } from '../guards/preflight.ts'

export const RIG_VARIANTS = ['good', 'route-out', 'open', 'leaks-env', 'writable'] as const
export type RigVariant = typeof RIG_VARIANTS[number]

export const CELL_IMAGE = `smlab-cell:pi-${PI_VERSION}`
export const RIG_IMAGE = 'smlab-rig:local'
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
  verdictTimeoutMs?: number
  vetoTimeoutMs?: number
  /** Negative controls only: more environment for the cell. It goes through the same F2 guard. */
  extraCellEnv?: Record<string, string>
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
  pids_limit?: number
  mem_limit?: string
  cpus?: number
}

export interface ComposeFile {
  name: string
  services: Record<'door' | 'cell' | 'sink' | 'control', Service>
  networks: Record<string, { internal: boolean; enable_ipv6: false }>
  volumes: { lab: Record<string, never> }
}

export interface Rig { project: string; file: ComposeFile }

const NO_IPV6 = { 'net.ipv6.conf.all.disable_ipv6': '1' }

function service(image: string, script: string, networks: string[], environment: Record<string, string>): Service {
  return {
    image, command: ['node', `${SWARM_ROOT}/conformance/docker/${script}`], networks: [...networks], environment: { ...environment },
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
  const project = `smlab-${o.nonce}`
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab nonce: ${o.nonce}`)
  if (!RIG_VARIANTS.includes(o.variant)) throw new RefusingToRun('F5', `not a rig variant: ${o.variant}`)

  const run = { SWARMLAB_NONCE: o.nonce, SWARMLAB_BRAIN: o.brainToken }
  const cell: Service = {
    ...service(CELL_IMAGE, 'cell-main.ts', ['cell'], {
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
      ...run, SMLAB_CHECK: o.check, SMLAB_VARIANT: o.variant, SMLAB_GATE: o.gate ?? 'real', SMLAB_SINK_IP: o.sinkIp ?? '', SMLAB_HOST_PORT: String(o.hostPort ?? 0),
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
  if (o.variant === 'leaks-env') cell.environment.SWARMLAB_LEAK = `UPSTREAM-${o.nonce}`
  // Root alone is not enough to write another user's folder once every capability is dropped,
  // so this one also gets back root's usual power over files.
  if (o.variant === 'writable') { cell.user = '0'; cell.read_only = false; cell.cap_add = ['DAC_OVERRIDE'] }

  // F2, on exactly what each container is about to be handed. A run fake must carry this run's nonce.
  for (const [name, env] of Object.entries(rigEnv(file))) {
    try { assertNoCredentials(env, { nonce: o.nonce }) } catch (err) {
      throw new RefusingToRun('F2', `(service ${name}) ${(err as Error).message.replace(/^REFUSING TO RUN: F2 /, '')}`)
    }
  }
  return { project, file }
}

/**
 * Refuses a rig whose file does not describe a sealed cell. The Docker suite
 * calls this on every rig it expects to be sealed, so a change to this file
 * that opens the cell cannot pass as "good".
 */
export function assertSealed(rig: Rig): void {
  const problems: string[] = []
  const { file } = rig
  for (const [name, network] of Object.entries(file.networks)) {
    if (network.internal !== true) problems.push(`network ${name} is not internal`)
  }
  const cell = file.services.cell
  if (cell.networks.join(',') !== 'cell') problems.push(`the cell is on ${cell.networks.join(' and ')}`)
  if (cell.read_only !== true) problems.push('the cell can write its own disk')
  if (cell.user !== 'node') problems.push(`the cell runs as ${cell.user}`)
  if (cell.volumes?.join(',') !== `lab:${LAB_DIR}`) problems.push('the cell mounts something other than the shared folder')
  if (JSON.stringify(cell).includes(`UPSTREAM-${file.services.cell.environment.SWARMLAB_NONCE}`)) problems.push('the cell is handed the model key')
  if (JSON.stringify(file).includes('docker.sock')) problems.push('a Docker socket is named')
  for (const [name, s] of Object.entries(file.services)) {
    for (const key of ['ports', 'privileged', 'network_mode', 'extra_hosts', 'env_file', 'cap_add', 'pid', 'devices']) {
      if (key in s) problems.push(`service ${name} sets ${key}`)
    }
  }
  if (problems.length > 0) throw new RefusingToRun('S0', `the rig is not sealed: ${problems.join('; ')}`)
}
