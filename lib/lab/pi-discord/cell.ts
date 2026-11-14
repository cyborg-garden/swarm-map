// The sealed cell for a real run, and the checks that it is sealed.
//
//   this machine      the door: Discord in and out, the model route, both secrets
//   relay container   a pipe under the door's name: two ports through to the door
//   cell container    the shim and Pi. Its only network has no way out
//
// The cell is the lab's own cell image, started the way the conformance rig
// starts it: read-only disk, non-root, every capability dropped, no host
// folder, no published port. It is handed a run nonce, a cell token, two
// timeouts, the model's name and what the harness is told it is. Not a key,
// not a token.
//
// The relay is the one container with a route out, because it has to reach
// the door on this machine. It carries bytes and holds nothing.
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { LAB_DIR, BRAIN_PORT, ROUTE_PORT, SOURCE_LABEL, SWARM_ROOT, labImages, probeArgs, readSource, sourceProblems, type LabImages, type ProbeTargets, type Service } from '../../../conformance/docker/compose.ts'
import { hostConfigProblems, mountProblems, netProblems, parseReport, secretProblems, writeProblems, type HostConfig } from '../../../conformance/docker/report.ts'
import { assertLocalDocker, assertNoCredentials, PROJECT_NAME, RefusingToRun } from '../../../conformance/guards/preflight.ts'

// The same two images the conformance rig uses, built from the same Dockerfile and named the
// same way: for the code they were built from. So a run can only start from an image of the
// code it is run from, and an image left by an older checkout is never picked up by its name.
// They carry a prefix of their own, so cleaning up after a test run cannot remove them.
export const IMAGE_PREFIX = 'smlabpd'
/** The two images for the code on disk now. */
export const launcherImages = (): LabImages => labImages({ SWARMLAB_DOCKER_PREFIX: IMAGE_PREFIX })

export interface CellOptions {
  /** Eight hex digits. Names the compose project, and anyone on this machine can read it. */
  nonce: string
  /**
   * The cell's own nonce: long, random, and not the project's. The cell's
   * placeholder for a model key is made from it, so the placeholder cannot be
   * worked out from a container name.
   */
  cellNonce: string
  brainToken: string
  /** Where the door listens on this machine. */
  brainPort: number
  routePort: number
  model: string
  /** What the harness is told it is. Text the launcher wrote; not a secret. */
  systemPrompt: string
  /** The images to start. Left out, they are the ones named for the code on disk. */
  images?: LabImages
  /** Dry run only: add the sink and its control, so "nothing got out" can be read from outside. */
  withSink?: boolean
  /** Tests only: break the seal in one named way, to show the checks go red. */
  broken?: 'cell-on-egress' | 'cell-writable'
}

export interface LiveFile {
  name: string
  services: Record<string, Service>
  networks: Record<string, { internal: boolean; enable_ipv6: false }>
  volumes: { lab: Record<string, never> }
}

/** Every name the cell's environment may hold. Listed by hand; nothing is inherited. */
export const CELL_ENV = ['SMLAB_GATE', 'SMLAB_MODEL', 'SMLAB_SYSTEM_PROMPT', 'SMLAB_VERDICT_MS', 'SMLAB_VETO_MS', 'SWARMLAB_BRAIN', 'SWARMLAB_NONCE']
const FORBIDDEN_KEYS = ['ports', 'privileged', 'network_mode', 'extra_hosts', 'env_file', 'cap_add', 'pid', 'devices', 'dns']

function service(image: string, script: string, networks: string[], environment: Record<string, string>): Service {
  return {
    image, command: ['node', `${SWARM_ROOT}/${script}`], networks, environment,
    pull_policy: 'never', restart: 'no', init: true, stop_grace_period: '1s',
    read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], user: 'node',
    tmpfs: ['/tmp'], sysctls: { 'net.ipv6.conf.all.disable_ipv6': '1' }, pids_limit: 256, mem_limit: '1g', cpus: 1,
  }
}

export function renderCell(o: CellOptions): LiveFile {
  const name = `smlab-${o.nonce}`
  if (!PROJECT_NAME.test(name)) throw new RefusingToRun('F5', `not a lab nonce: ${o.nonce}`)
  if (!/^[0-9a-f]{32}$/.test(o.cellNonce) || o.brainToken.slice(0, 39) !== `BRAIN-${o.cellNonce}-`) throw new RefusingToRun('F5', 'not a cell nonce and its token')
  if (o.systemPrompt === '' || o.systemPrompt.length > 4000) throw new RefusingToRun('F5', 'not a system prompt')
  const { cell: CELL_IMAGE, rig: RIG_IMAGE } = o.images ?? launcherImages()
  const port = (n: number): number => { if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new RefusingToRun('F5', 'not a port'); return n }
  const cell: Service = {
    ...service(CELL_IMAGE, 'conformance/docker/cell-main.ts', ['cell'], {
      SWARMLAB_NONCE: o.cellNonce, SWARMLAB_BRAIN: o.brainToken, SMLAB_GATE: 'real',
      // A real model is slower than a scripted one: the shim waits this long for the door's answer on a tool.
      SMLAB_VERDICT_MS: '30000', SMLAB_VETO_MS: '35000', SMLAB_MODEL: o.model, SMLAB_SYSTEM_PROMPT: o.systemPrompt,
    }),
    volumes: [`lab:${LAB_DIR}`], depends_on: ['door'],
  }
  const relay = service(RIG_IMAGE, 'lib/door/relay.ts', ['cell', 'egress'], {
    SMLAB_RELAY: `${BRAIN_PORT}=host.docker.internal:${port(o.brainPort)},${ROUTE_PORT}=host.docker.internal:${port(o.routePort)}`,
  })
  const file: LiveFile = {
    name,
    // The relay takes the name the cell dials: `door`.
    services: { door: relay, cell },
    networks: { cell: { internal: true, enable_ipv6: false }, egress: { internal: false, enable_ipv6: false } },
    volumes: { lab: {} },
  }
  if (o.withSink) {
    file.networks.outside = { internal: true, enable_ipv6: false }
    file.services.sink = service(RIG_IMAGE, 'conformance/docker/sink.ts', ['outside'], {})
    file.services.control = { ...service(RIG_IMAGE, 'conformance/docker/control.ts', ['outside'], { SWARMLAB_NONCE: o.nonce }), depends_on: ['sink'] }
  }
  if (o.broken === 'cell-on-egress') cell.networks = ['cell', 'egress']
  if (o.broken === 'cell-writable') cell.read_only = false
  return file
}

/** What is wrong with a rendered file as a sealed cell. `secrets` are strings that must appear nowhere in it. */
export function sealProblems(file: LiveFile, secrets: string[] = []): string[] {
  const p: string[] = []
  const { cell, door } = file.services
  const text = JSON.stringify(file)
  for (const [name, network] of Object.entries(file.networks)) {
    if (network.internal !== true && name !== 'egress') p.push(`network ${name} is not internal`)
  }
  if (file.networks.cell?.internal !== true) p.push('the cell network has a way out')
  if (cell.networks.join(',') !== 'cell') p.push(`the cell is on ${cell.networks.join(' and ')}`)
  if (cell.read_only !== true) p.push('the cell can write its own disk')
  if (cell.user !== 'node') p.push(`the cell runs as ${cell.user}`)
  if (cell.volumes?.join(',') !== `lab:${LAB_DIR}`) p.push('the cell mounts something other than its own folder')
  if (Object.keys(cell.environment).sort().join(',') !== CELL_ENV.join(',')) p.push('the cell is handed something that is not on its list')
  try { assertNoCredentials(cell.environment, { nonce: cell.environment.SWARMLAB_NONCE }) } catch (err) { p.push((err as Error).message) }
  if (door.volumes !== undefined) p.push('the relay mounts something')
  if (Object.keys(door.environment).join(',') !== 'SMLAB_RELAY') p.push('the relay is handed something other than its two ports')
  for (const [name, s] of Object.entries(file.services)) {
    if (name !== 'door' && s.networks.includes('egress')) p.push(`${name} has a way out`)
    if (s.cap_drop.join(',') !== 'ALL' || s.security_opt.join(',') !== 'no-new-privileges:true') p.push(`${name} keeps privileges`)
    for (const key of FORBIDDEN_KEYS) if (key in s) p.push(`service ${name} sets ${key}`)
  }
  if (text.includes('docker.sock')) p.push('a Docker socket is named')
  for (const secret of secrets) if (secret.length >= 8 && text.includes(secret)) p.push('a secret is in the file')
  return p
}

// --- Docker, by name only -------------------------------------------------

/** The environment the docker CLI gets: listed by hand, nothing else passed down. */
function dockerEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {}
  for (const name of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env as NodeJS.ProcessEnv
}
export function docker(args: string[], timeoutMs = 120_000): { ok: boolean; out: string } {
  const r = spawnSync('docker', args, { env: dockerEnv(), encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const dockerAsync = (args: string[], timeoutMs = 120_000): Promise<string> => new Promise((resolve) => {
  execFile('docker', args, { env: dockerEnv(), encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (_err, stdout, stderr) => resolve(`${stdout}${stderr}`))
})

/** Build the two images, named for the code they are built from. The only step that uses the network to fetch anything, and never part of a start. */
export function buildImages(): boolean {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const images = launcherImages()
  const built = ([['cell', images.cell], ['rig', images.rig]] as const).every(([target, tag]) =>
    spawnSync('docker', ['build', '--target', target, '--tag', tag, '--label', `${SOURCE_LABEL}=${images.source}`, '--file', path.join(repo, 'conformance', 'docker', 'Dockerfile'), repo],
      { env: dockerEnv(), stdio: 'inherit', timeout: 900_000 }).status === 0)
  // A file saved during the build would leave images that are not what their name says.
  return built && launcherImages().source === images.source
}

/** What an image says it was built from, and the hash of every file it really holds under the lab's folder. */
function seeImage(image: string): { label: string; listing: string } {
  const label = docker(['image', 'inspect', '--format', `{{index .Config.Labels "${SOURCE_LABEL}"}}`, image])
  const listing = docker(['run', '--rm', '--network', 'none', '--read-only', '--pull', 'never', '--name', `smlab-${randomBytes(4).toString('hex')}-source`,
    '--entrypoint', 'sh', image, '-c', `cd ${SWARM_ROOT} && find . -type f -print0 | xargs -0 sha256sum`], 60_000)
  return { label: label.ok ? label.out.trim() : '', listing: listing.ok ? listing.out : '' }
}

/**
 * Docker is this machine's, and both images hold exactly the code this run is started from:
 * the label each carries and the hash of every file in it are compared with the code on disk.
 */
export function dockerProblems(images: LabImages = launcherImages()): string[] {
  const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  try {
    assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
  } catch (err) { return [(err as Error).message] }
  if (!docker(['info', '--format', '{{.ServerVersion}}']).ok) return ['the Docker daemon is not answering']
  const build = 'Run: node lib/lab/pi-discord/cli.ts build'
  const expected = readSource()
  if (expected.hash !== images.source) return [`the code changed since the images were named. ${build}`]
  const p: string[] = []
  for (const [kind, image] of [['cell', images.cell], ['rig', images.rig]] as const) {
    if (!docker(['image', 'inspect', '--format', '{{.Id}}', image]).ok) { p.push(`image ${image} is not built for this code. ${build}`); continue }
    p.push(...sourceProblems(kind, image, seeImage(image), expected).map((problem) => `${problem}. ${build}`))
  }
  return p
}

const compose = (project: string, args: string[], timeoutMs = 120_000): { ok: boolean; out: string } => {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab project: ${project}`)
  return docker(['compose', '--project-name', project, ...args], timeoutMs)
}

export function cellUp(file: LiveFile, composePath: string, services: string[] = []): void {
  const r = compose(file.name, ['--file', composePath, 'up', '--detach', '--no-build', '--pull', 'never', ...services])
  if (!r.ok) throw new Error(`the cell did not start: ${r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
}

/** Stop and remove one run's containers, networks and volume. By project name, and nothing else. */
export function cellDown(project: string): string[] {
  compose(project, ['down', '--volumes', '--remove-orphans', '--timeout', '2'])
  return docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean)
}

/** What Docker really gave the cell, read from outside it. */
export function runningCellProblems(project: string): string[] {
  const p: string[] = []
  const name = `${project}-cell-1`
  const r = docker(['inspect', name])
  if (!r.ok) return ['the cell container is not there']
  const [c] = JSON.parse(r.out) as [{
    State: { Running: boolean }
    Config: { Env: string[]; User: string }
    Mounts: { Type: string; Name?: string; Destination: string }[]
    NetworkSettings: { Networks: Record<string, unknown>; Ports?: Record<string, unknown> }
    HostConfig: HostConfig & { ReadonlyRootfs: boolean }
  }]
  if (!c.State.Running) p.push('the cell is not running')
  const networks = Object.keys(c.NetworkSettings.Networks).sort()
  if (networks.join(',') !== `${project}_cell`) p.push(`the cell is on ${networks.join(' and ') || 'no network'}`)
  for (const network of networks) {
    if (docker(['network', 'inspect', '--format', '{{.Internal}}', network]).out.trim() !== 'true') p.push(`network ${network} is not internal`)
  }
  if (!c.HostConfig.ReadonlyRootfs) p.push('the cell\'s disk is not read-only')
  // The lab's own reading of what Docker says it gave a container: ports, namespaces, capabilities, host paths.
  const given = hostConfigProblems(c.HostConfig, `${project}_cell`)
  p.push(...given.net, ...given.privilege, ...given.mounts)
  if (c.Config.User !== 'node') p.push(`the cell runs as ${c.Config.User || 'root'}`)
  if (c.Mounts.length !== 1 || c.Mounts[0].Type !== 'volume' || c.Mounts[0].Name !== `${project}_lab`) p.push('the cell mounts something other than its own folder')
  // Names only. What the image itself sets is not ours to list.
  const ours = c.Config.Env.map((e) => e.slice(0, e.indexOf('='))).filter((n) => /^(SMLAB_|SWARMLAB_)/.test(n) || /TOKEN|KEY|SECRET|PASS/i.test(n))
  if (ours.sort().join(',') !== CELL_ENV.join(',')) p.push('the cell\'s environment is not the list it was given')
  return p
}

/** The addresses the probe will try, found the way the conformance rig finds them, from the launcher's own image. */
export function findTargets(images: LabImages = launcherImages()): ProbeTargets {
  const lookup = docker(['run', '--rm', '--name', `smlab-${randomBytes(4).toString('hex')}-lookup`, '--pull', 'never', images.rig, 'node', `${SWARM_ROOT}/conformance/docker/lookup.ts`])
  let found: Partial<ProbeTargets> = {}
  try { found = JSON.parse(lookup.out.trim().split('\n').pop() ?? '{}') as Partial<ProbeTargets> } catch { /* nothing found: the probe reports those ways out as not tried, which fails */ }
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  return { hostIp: text(found.hostIp), publicIp: text(found.publicIp), resolverIp: text(found.resolverIp), resolverIp6: text(found.resolverIp6) }
}

/** Run the lab's probe inside the cell: it tries every way out it knows and reports what happened. */
export async function probeCell(project: string, cellNonce: string, sinkIp: string, hostPort: number, targets: ProbeTargets): Promise<{ id: string; title: string; problems: string[] }[]> {
  const out = await dockerAsync(['exec', `${project}-cell-1`, 'node', `${SWARM_ROOT}/conformance/docker/probe.ts`, ...probeArgs(cellNonce, sinkIp, hostPort, targets)], 90_000)
  const report = parseReport(out)
  const none = ['the probe did not run in the cell, so nothing was checked']
  return [
    { id: 'S1', title: 'the cell reaches the door and nothing else: not the internet, not this machine', problems: report ? netProblems(report) : none },
    { id: 'S2', title: 'the shim, the gate and Pi cannot be changed from inside the cell', problems: report ? writeProblems(report) : none },
    { id: 'S3', title: 'no folder of this machine is in the cell', problems: report ? [...mountProblems(report), ...secretProblems(report).filter((x) => x.startsWith('the search'))] : none },
  ]
}
