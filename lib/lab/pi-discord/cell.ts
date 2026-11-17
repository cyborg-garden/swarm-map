// The sealed cell for a real run, and the checks that it is sealed.
//
//   this machine      the door: Discord in and out, the model route, both secrets
//   relay container   a pipe under the door's name: two ports through to the door
//   cell container    the shim and the harness. Its only network has no way out
//
// The cell is the lab's own cell image, started the way the conformance rig
// starts it: read-only disk, non-root, every capability dropped, no host
// folder, no published port. It is handed a run nonce, a cell token, two
// timeouts, two limits for its tools, the model's name and what the harness
// is told it is. Not a key, not a token.
//
// The folder the harness is started in is the scratch folder for its tools: a
// mount that lives in memory, of a fixed size, and is gone when the cell is.
//
// The relay is the one container with a route out, because it has to reach
// the door on this machine. It carries bytes and holds nothing.
//
// Each network names a small block of addresses of its own, picked from what
// is free on this Docker when the cell is started, so a start does not depend
// on what Docker's own pools have left (conformance/docker/subnets.ts).
import { execFile, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { CELL_KINDS } from '../../../conformance/docker/cells.ts'
import { LAB_DIR, BRAIN_PORT, ROUTE_PORT, SOURCE_LABEL, SWARM_ROOT, labImages, probeArgs, readSource, sourceProblems, type CellKind, type LabImages, type ProbeTargets, type Service } from '../../../conformance/docker/compose.ts'
import { hostConfigProblems, mountProblems, netProblems, networkProblems, parseReport, secretProblems, writeProblems, type DockerNetwork, type HostConfig } from '../../../conformance/docker/report.ts'
import { inSubnet, labNetwork, writtenNetworkProblems, type LabNetwork } from '../../../conformance/docker/subnets.ts'
import { assertLocalDocker, assertNoCredentials, PROJECT_NAME, RefusingToRun } from '../../../conformance/guards/preflight.ts'
import { DEFAULT_TOOL_LIMITS, type ToolLimits } from '../../core/tools/call.ts'
import { DEFAULT_HARNESS, harnessFacts, isLauncherHarness, type LauncherHarness } from './harnesses.ts'

// The same two images the conformance rig uses, built from the same Dockerfile and named the
// same way: for the code they were built from. So a run can only start from an image of the
// code it is run from, and an image left by an older checkout is never picked up by its name.
// They carry a prefix of their own, so cleaning up after a test run cannot remove them.
export const IMAGE_PREFIX = 'smlabpd'
/** The lab's own description of a harness's cell: its image, its entry script. The same one the conformance rig starts. */
export function cellKind(harness: LauncherHarness = DEFAULT_HARNESS): CellKind {
  const kind = isLauncherHarness(harness) ? CELL_KINDS[harness] : undefined
  if (!kind) throw new RefusingToRun('F5', `not a harness the launcher has a cell for: ${String(harness)}`)
  return kind
}
/** The two images for the code on disk now: the cell that holds this harness, and the rig, which is the same for every harness. */
export const launcherImages = (harness: LauncherHarness = DEFAULT_HARNESS): LabImages => labImages({ SWARMLAB_DOCKER_PREFIX: IMAGE_PREFIX }, undefined, cellKind(harness))
/** The command that builds the images a harness needs. Pi's is the one it always was. */
export const buildHint = (harness: LauncherHarness = DEFAULT_HARNESS): string =>
  `Run: node lib/lab/pi-discord/cli.ts build${harness === DEFAULT_HARNESS ? '' : ` --harness ${harness}`}`

export interface CellOptions {
  /** Which harness the cell holds. Left out, it is Pi. */
  harness?: LauncherHarness
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
  /** The block of addresses each network is made on. `outside` is the dry run's, for its sink. */
  subnets: { cell: string; egress: string; outside: string }
  /** The images to start. Left out, they are the ones named for the code on disk. */
  images?: LabImages
  /** Dry run only: add the sink and its control, so "nothing got out" can be read from outside. */
  withSink?: boolean
  /** The limits on the cell's tools. Left out, the defaults. */
  limits?: ToolLimits
  /** How long the door waits for an admin to answer a request, when a class of tool asks. The cell is told to wait a little longer. */
  approvalMs?: number
  /** Tests only: break the seal in one named way, to show the checks go red. */
  broken?: 'cell-on-egress' | 'cell-writable' | 'cell-other-subnet' | 'cell-scratch-uncapped' | 'cell-folder-uncapped'
}

/** The scratch folder: where the harness is started, and the one place its file tools reach. */
export const SCRATCH_DIR = `${LAB_DIR}/work`
/** The scratch folder as a mount: in memory, capped, owned by the user the cell runs as (`node`, 1000). */
export const scratchMount = (mb: number): string => `${SCRATCH_DIR}:size=${mb}m,mode=0700,uid=1000,gid=1000`

export interface LiveFile {
  name: string
  services: Record<string, Service>
  networks: Record<string, LabNetwork>
  volumes: { lab: { driver: 'local'; driver_opts: { type: 'tmpfs'; device: 'tmpfs'; o: string } } }
}

/**
 * The cell's own folder (its harness's settings, sessions and home, with the scratch folder mounted inside):
 * in memory, with a size. On Docker's disk it had none, and a shell in the cell could fill the disk every
 * container on this machine shares. It is gone when the cell stops, as the scratch folder is.
 */
export const CELL_FOLDER_MB = 256
export const cellFolder = (): LiveFile['volumes']['lab'] =>
  ({ driver: 'local', driver_opts: { type: 'tmpfs', device: 'tmpfs', o: `size=${CELL_FOLDER_MB}m,uid=1000,gid=1000,mode=0700,noexec,nosuid,nodev` } })

/** What each network of a file is written down as: whether it has a way out, and its block. */
export const networksWritten = (file: Pick<LiveFile, 'networks'>): Record<string, { internal: boolean; subnet: string }> =>
  Object.fromEntries(Object.entries(file.networks).map(([name, n]) => [name, { internal: n.internal, subnet: n.ipam.config[0].subnet }]))

/** Every name the cell's environment may hold. Listed by hand; nothing is inherited. */
export const CELL_ENV = ['SMLAB_GATE', 'SMLAB_MODEL', 'SMLAB_SYSTEM_PROMPT', 'SMLAB_TOOL_OUTPUT_BYTES', 'SMLAB_TOOL_SECONDS', 'SMLAB_VERDICT_MS', 'SMLAB_VETO_MS', 'SWARMLAB_BRAIN', 'SWARMLAB_NONCE']
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
  if (o.systemPrompt === '' || o.systemPrompt.length > 16_000) throw new RefusingToRun('F5', 'not a system prompt')
  const kind = cellKind(o.harness)
  const { cell: CELL_IMAGE, rig: RIG_IMAGE } = o.images ?? launcherImages(o.harness)
  const port = (n: number): number => { if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new RefusingToRun('F5', 'not a port'); return n }
  const limits = o.limits ?? DEFAULT_TOOL_LIMITS
  const whole = (n: number, max: number): number => { if (!Number.isInteger(n) || n < 1 || n > max) throw new RefusingToRun('F5', 'not a limit'); return n }
  // The shim waits this long for the door's answer on a tool, and the gate a little longer than the shim. A real model
  // is slower than a scripted one, and where a tool waits for an admin the door has to be the first to give up.
  const wait = Math.max(30_000, whole(o.approvalMs ?? 1, 3_600_000) + 10_000)
  const cell: Service = {
    ...service(CELL_IMAGE, `conformance/docker/${kind.entry}`, ['cell'], {
      SWARMLAB_NONCE: o.cellNonce, SWARMLAB_BRAIN: o.brainToken, SMLAB_GATE: 'real',
      SMLAB_VERDICT_MS: String(wait), SMLAB_VETO_MS: String(wait + 5000), SMLAB_MODEL: o.model, SMLAB_SYSTEM_PROMPT: o.systemPrompt,
      SMLAB_TOOL_SECONDS: String(whole(limits.callSeconds, 3600)), SMLAB_TOOL_OUTPUT_BYTES: String(whole(limits.outputBytes, 1_000_000)),
    }),
    volumes: [`lab:${LAB_DIR}`], depends_on: ['door'],
  }
  cell.tmpfs = ['/tmp', scratchMount(whole(limits.workspaceMb, 1024))]
  const relay = service(RIG_IMAGE, 'lib/door/relay.ts', ['cell', 'egress'], {
    SMLAB_RELAY: `${BRAIN_PORT}=host.docker.internal:${port(o.brainPort)},${ROUTE_PORT}=host.docker.internal:${port(o.routePort)}`,
  })
  const file: LiveFile = {
    name,
    // The relay takes the name the cell dials: `door`.
    services: { door: relay, cell },
    networks: { cell: labNetwork(true, o.subnets?.cell), egress: labNetwork(false, o.subnets?.egress) },
    volumes: { lab: cellFolder() },
  }
  if (o.withSink) {
    file.networks.outside = labNetwork(true, o.subnets?.outside)
    file.services.sink = service(RIG_IMAGE, 'conformance/docker/sink.ts', ['outside'], {})
    file.services.control = { ...service(RIG_IMAGE, 'conformance/docker/control.ts', ['outside'], { SWARMLAB_NONCE: o.nonce }), depends_on: ['sink'] }
  }
  if (o.broken === 'cell-on-egress') cell.networks = ['cell', 'egress']
  if (o.broken === 'cell-writable') cell.read_only = false
  // The scratch folder is left as a plain folder of the cell's volume: writable, and with no size of its own.
  if (o.broken === 'cell-scratch-uncapped') cell.tmpfs = ['/tmp']
  // The cell's own folder is a plain Docker volume: on Docker's disk, with no size.
  if (o.broken === 'cell-folder-uncapped') file.volumes.lab = {} as never
  // The two networks are made on each other's blocks. As written this is still a sealed cell: only Docker can show the difference.
  if (o.broken === 'cell-other-subnet') {
    file.networks.cell = labNetwork(true, o.subnets.egress)
    file.networks.egress = labNetwork(false, o.subnets.cell)
  }
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
  // Each network names one block of the lab's own and nothing else: no gateway, no driver, no option.
  p.push(...writtenNetworkProblems(file.networks))
  if (cell.networks.join(',') !== 'cell') p.push(`the cell is on ${cell.networks.join(' and ')}`)
  if (cell.read_only !== true) p.push('the cell can write its own disk')
  if (cell.user !== 'node') p.push(`the cell runs as ${cell.user}`)
  if (cell.volumes?.join(',') !== `lab:${LAB_DIR}`) p.push('the cell mounts something other than its own folder')
  // Two places in memory and no more: /tmp, and the scratch folder with a size written on it.
  if (cell.tmpfs.length !== 2 || cell.tmpfs[0] !== '/tmp' || !/^\/tmp\/smlab\/work:size=([1-9]\d{0,3})m,mode=0700,uid=1000,gid=1000$/.test(cell.tmpfs[1])) p.push('the cell\'s scratch folder is not a capped mount of its own')
  if (JSON.stringify(file.volumes?.lab) !== JSON.stringify(cellFolder())) p.push('the cell\'s own folder is not in memory with a size')
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

/** Build the two images a harness needs, named for the code they are built from. The only step that uses the network to fetch anything, and never part of a start. */
export function buildImages(harness: LauncherHarness = DEFAULT_HARNESS): boolean {
  const repo = path.resolve(import.meta.dirname, '..', '..', '..')
  const images = launcherImages(harness)
  const built = ([[cellKind(harness).target, images.cell], ['rig', images.rig]] as const).every(([target, tag]) =>
    spawnSync('docker', ['build', '--target', target, '--tag', tag, '--label', `${SOURCE_LABEL}=${images.source}`, '--file', path.join(repo, 'conformance', 'docker', 'Dockerfile'), repo],
      { env: dockerEnv(), stdio: 'inherit', timeout: 900_000 }).status === 0)
  // A file saved during the build would leave images that are not what their name says.
  return built && launcherImages(harness).source === images.source
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
export function dockerProblems(images: LabImages = launcherImages(), harness: LauncherHarness = DEFAULT_HARNESS): string[] {
  const endpoint = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']).out.trim()
  try {
    assertLocalDocker({ dockerHost: process.env.DOCKER_HOST, contextEndpoint: process.env.DOCKER_HOST ? process.env.DOCKER_HOST : endpoint })
  } catch (err) { return [(err as Error).message] }
  if (!docker(['info', '--format', '{{.ServerVersion}}']).ok) return ['the Docker daemon is not answering']
  const build = buildHint(harness)
  const expected = readSource()
  if (expected.hash !== images.source) return [`the code changed since the images were named. ${build}`]
  const p: string[] = []
  for (const [kind, image] of [['cell', images.cell], ['rig', images.rig]] as const) {
    if (!docker(['image', 'inspect', '--format', '{{.Id}}', image]).ok) { p.push(`image ${image} is not built for this code. ${build}`); continue }
    p.push(...sourceProblems(kind, image, seeImage(image), expected, cellKind(harness).entry).map((problem) => `${problem}. ${build}`))
  }
  return p
}

const compose = (project: string, args: string[], timeoutMs = 120_000): { ok: boolean; out: string } => {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab project: ${project}`)
  return docker(['compose', '--project-name', project, ...args], timeoutMs)
}

export function cellUp(file: LiveFile, composePath: string, services: string[] = []): void {
  const r = compose(file.name, ['--file', composePath, 'up', '--detach', '--no-build', '--pull', 'never', ...services])
  // All of what Docker said goes along, so a caller can tell a block that was taken from any other failure.
  if (!r.ok) throw Object.assign(new Error(`the cell did not start: ${r.out.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`), { stderr: r.out })
}

/** Stop one run's cell container, or start it again, by name. The same container, so what Docker gave it is unchanged. */
export function cellStopStart(project: string, what: 'stop' | 'start'): boolean {
  return docker(cellStopStartArgs(project, what)).ok
}
/** What Docker is asked for that. `-t`, not `--time`: Docker no longer lists the long spelling. */
export function cellStopStartArgs(project: string, what: 'stop' | 'start'): string[] {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab project: ${project}`)
  return what === 'stop' ? ['stop', '-t', '1', `${project}-cell-1`] : ['start', `${project}-cell-1`]
}

/** Stop and remove one run's containers, networks and volume. By project name, and nothing else. */
export function cellDown(project: string): string[] {
  compose(project, ['down', '--volumes', '--remove-orphans', '--timeout', '2'])
  return docker(['ps', '-a', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean)
}

/** What Docker really gave the cell, read from outside it, against the networks that were written down for it. */
export function runningCellProblems(project: string, written: Record<string, { internal: boolean; subnet: string }>): string[] {
  const p: string[] = []
  const name = `${project}-cell-1`
  const r = docker(['inspect', name])
  if (!r.ok) return ['the cell container is not there']
  const [c] = JSON.parse(r.out) as [{
    State: { Running: boolean }
    Config: { Env: string[]; User: string }
    Mounts: { Type: string; Name?: string; Destination: string }[]
    NetworkSettings: { Networks: Record<string, { IPAddress?: string }>; Ports?: Record<string, unknown> }
    HostConfig: HostConfig & { ReadonlyRootfs: boolean; Tmpfs?: Record<string, string> | null }
  }]
  if (!c.State.Running) p.push('the cell is not running')
  const networks = Object.keys(c.NetworkSettings.Networks).sort()
  if (networks.join(',') !== `${project}_cell`) p.push(`the cell is on ${networks.join(' and ') || 'no network'}`)
  for (const network of networks) {
    if (docker(['network', 'inspect', '--format', '{{.Internal}}', network]).out.trim() !== 'true') p.push(`network ${network} is not internal`)
  }
  // Every network Docker made is the one written down for it: the same block, and a way out only where one was written.
  if (written.cell?.internal !== true) p.push('no network with no way out was written down for the cell')
  for (const [name, w] of Object.entries(written)) {
    const seen = docker(['network', 'inspect', `${project}_${name}`])
    let given: DockerNetwork | undefined
    try { given = seen.ok ? (JSON.parse(seen.out) as DockerNetwork[])[0] : undefined } catch { /* not there */ }
    p.push(...networkProblems(`${project}_${name}`, w, given))
  }
  const address = c.NetworkSettings.Networks[`${project}_cell`]?.IPAddress ?? ''
  // A cell that has stopped has no address, and that is said above.
  if (c.State.Running && !inSubnet(address, written.cell?.subnet ?? '')) p.push(`the cell has the address ${address || 'none'}, which is not in the block written for its network`)
  if (!c.HostConfig.ReadonlyRootfs) p.push('the cell\'s disk is not read-only')
  // The lab's own reading of what Docker says it gave a container: ports, namespaces, capabilities, host paths.
  const given = hostConfigProblems(c.HostConfig, `${project}_cell`)
  p.push(...given.net, ...given.privilege, ...given.mounts)
  if (c.Config.User !== 'node') p.push(`the cell runs as ${c.Config.User || 'root'}`)
  if (c.Mounts.length !== 1 || c.Mounts[0].Type !== 'volume' || c.Mounts[0].Name !== `${project}_lab`) p.push('the cell mounts something other than its own folder')
  // What Docker made of the cell's own folder: in memory, with the size written for it.
  const folder = docker(['volume', 'inspect', '--format', '{{json .Options}}', `${project}_lab`])
  let made: Record<string, string> = {}
  try { made = JSON.parse(folder.out) ?? {} } catch { /* not there */ }
  if (made.type !== 'tmpfs' || made.o !== cellFolder().driver_opts.o) p.push('the cell\'s own folder is not in memory with a size')
  // What Docker says it mounted in memory: /tmp, and the scratch folder with a size.
  const inMemory = c.HostConfig.Tmpfs ?? {}
  if (Object.keys(inMemory).sort().join(',') !== `/tmp,${SCRATCH_DIR}` || !/(^|,)size=[1-9]\d*m(,|$)/.test(inMemory[SCRATCH_DIR] ?? '')) p.push('the cell\'s scratch folder is not a capped mount of its own')
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
export async function probeCell(project: string, cellNonce: string, sinkIp: string, hostPort: number, targets: ProbeTargets, harness: LauncherHarness = DEFAULT_HARNESS): Promise<{ id: string; title: string; problems: string[] }[]> {
  const out = await dockerAsync(['exec', `${project}-cell-1`, 'node', `${SWARM_ROOT}/conformance/docker/probe.ts`, ...probeArgs(cellNonce, sinkIp, hostPort, targets)], 90_000)
  const report = parseReport(out)
  const none = ['the probe did not run in the cell, so nothing was checked']
  return [
    { id: 'S1', title: 'the cell reaches the door and nothing else: not the internet, not this machine', problems: report ? netProblems(report) : none },
    { id: 'S2', title: `the shim, the gate and ${harnessFacts(harness).label} cannot be changed from inside the cell`, problems: report ? writeProblems(report) : none },
    { id: 'S3', title: 'no folder of this machine is in the cell', problems: report ? [...mountProblems(report), ...secretProblems(report).filter((x) => x.startsWith('the search'))] : none },
  ]
}

/**
 * The scratch folder, tried from inside the running cell: it can be written,
 * and it takes no more than its size. A little more than the size is written
 * to it, and what landed is counted.
 */
export function scratchProblems(project: string, mb: number = DEFAULT_TOOL_LIMITS.workspaceMb): string[] {
  const p: string[] = []
  // The scratch folder, then the cell's own folder outside it: each takes no more than its size.
  for (const [where, what, size] of [[SCRATCH_DIR, 'the scratch folder', mb], [`${LAB_DIR}/home`, 'the cell\'s own folder', CELL_FOLDER_MB]] as const) {
    const file = `${where}/.fill`
    const r = docker(['exec', `${project}-cell-1`, 'sh', '-c',
      `touch ${where}/.ok && echo WROTE; rm -f ${where}/.ok; head -c ${(size + 8) * 1024 * 1024} /dev/zero > ${file} 2>/dev/null; echo "LANDED $(wc -c < ${file})"; rm -f ${file}`], 60_000)
    const landed = Number(/LANDED\s+(\d+)/.exec(r.out)?.[1] ?? Number.NaN)
    if (!r.out.includes('WROTE')) p.push(`${what} cannot be written`)
    if (!Number.isFinite(landed)) p.push(`${what} could not be tried, so nothing was checked`)
    else if (landed > size * 1024 * 1024) p.push(`${what} took ${landed} bytes, which is more than its ${size} MB`)
  }
  return p
}

/**
 * A kept scratch folder (`tools.keepScratch`). When the agent stops, the folder is read out of the
 * cell as one tar stream and stored as it is, in the agent's state folder. When it starts, that same
 * stream is unpacked again INSIDE the new cell, by the cell's own user, into the capped folder.
 * This machine never unpacks it, so nothing the agent put there can land anywhere on this machine,
 * and the folder's own size cap still holds what comes back. Docs: docs/lab/persona-memory.md.
 */
export const KEPT_SCRATCH_FILE = 'scratch.tar'
/** The most a kept folder may take: the folder's own size, and a little for the tar's headers. */
export const keptScratchMaxBytes = (mb: number = DEFAULT_TOOL_LIMITS.workspaceMb): number => (mb + 1) * 1024 * 1024

export function scratchSaveArgs(project: string): string[] {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab project: ${project}`)
  return ['exec', '-u', 'node', `${project}-cell-1`, 'tar', '-c', '-C', SCRATCH_DIR, '.']
}
export function scratchRestoreArgs(project: string): string[] {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `not a lab project: ${project}`)
  return ['exec', '-i', '-u', 'node', `${project}-cell-1`, 'tar', '-x', '--no-same-owner', '--no-same-permissions', '-C', SCRATCH_DIR]
}

/** Read the scratch folder out of a running cell. Undefined, with the reason, when it cannot be kept. */
export function readScratch(project: string, maxBytes: number = keptScratchMaxBytes()): { tar?: Buffer; why?: string } {
  const r = spawnSync('docker', scratchSaveArgs(project), { env: dockerEnv(), timeout: 60_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: maxBytes })
  if (r.error && /ENOBUFS|maxBuffer/i.test(String((r.error as NodeJS.ErrnoException).code ?? r.error.message))) return { why: `the folder is bigger than ${maxBytes} bytes` }
  if (r.status !== 0 || !Buffer.isBuffer(r.stdout)) return { why: 'the cell did not hand the folder over' }
  return { tar: r.stdout }
}

/**
 * Put a kept folder back, unpacked inside the cell. False when the cell refused it. Right after a cell
 * starts, Docker can refuse an exec now and then ("exec failed ... broken pipe"), so it is tried three times.
 */
export function writeScratch(project: string, tar: Buffer, tries = 3): boolean {
  for (let i = 0; i < tries; i++) {
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    const r = spawnSync('docker', scratchRestoreArgs(project), { env: dockerEnv(), timeout: 60_000, input: tar, stdio: ['pipe', 'ignore', 'ignore'] })
    if (r.status === 0) return true
  }
  return false
}
