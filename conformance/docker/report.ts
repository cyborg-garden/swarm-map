// What the probe reports, and how it is judged. Shared by the rig outside
// (which runs the probe in a container itself) and by the checks inside the
// sidecar's container (which have the harness run it as a tool).
import { lstatSync, readFileSync } from 'node:fs'
import { LAB_DIR, TMP_MB } from './compose.ts'
import { inSubnet } from './subnets.ts'

export interface ProbeReport {
  who: string
  uid: number
  /** Must be open, or the probe had no network at all and its other answers mean nothing. */
  door: string
  doorRoute: string
  /** Everything here must be closed. `open` means a connection was made or a name was resolved; `not-tried` means the probe had no address to try. */
  net: Record<string, string>
  /** A second shim with a wrong token. Must be `refused`. */
  wrongToken: string
  /** Places where this run's model key or chat token was found. Must be empty. */
  secrets: string[]
  /** How many files and process records were searched. Too few means nothing was checked. */
  searched: { files: number; procs: number }
  /** What happened when the probe tried to write each place. Every one must fail. */
  writes: Record<string, string>
  dockerSocket: boolean
  /** Mounts that are not the image, a tmpfs or the kernel's own. */
  mounts: string[]
  /** /tmp as the kernel has it mounted, as `<type> <options>`: the mount's own options, then the file system's. */
  tmp: string
  noNewPrivs: string
  capEff: string
  ipv6: string[]
  /** Every route the kernel has that leads anywhere at all, as `via <gateway> on <interface>`. Must be empty: the cell's only network has no way out. */
  defaultRoutes: string[]
}

export function parseReport(text: string): ProbeReport | undefined {
  try {
    const report = JSON.parse(text.trim().split('\n').pop() ?? '') as ProbeReport
    return report && typeof report.net === 'object' && typeof report.door === 'string' ? report : undefined
  } catch { return undefined }
}

/**
 * A report the probe wrote to a file in the shared folder. The cell wrote that
 * file, so it is read only if it is a plain file: a link left in its place is
 * not followed, and a pipe is not waited on.
 */
export function readReport(file: string): ProbeReport | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined
    return parseReport(readFileSync(file, 'utf8'))
  } catch { return undefined }
}

/** Nothing leaves: only the door answers. */
export function netProblems(r: ProbeReport): string[] {
  const p: string[] = []
  if (r.door !== 'open' || r.doorRoute !== 'open') p.push(`the probe could not reach the door (${r.door}, ${r.doorRoute}), so its other answers mean nothing`)
  if (Object.keys(r.net).length < 14) p.push('the probe tried fewer ways out than it should')
  for (const [what, answer] of Object.entries(r.net)) {
    if (answer === 'open') p.push(`reached ${what}`)
    if (answer === 'not-tried') p.push(`did not try ${what}: the rig was given no address for it`)
  }
  if (r.wrongToken !== 'refused') p.push(`the door did not hang up on a wrong cell token (${r.wrongToken})`)
  if (r.ipv6.length > 0) p.push('the container has an IPv6 address')
  if (!Array.isArray(r.defaultRoutes)) p.push('the probe did not read the container\'s routes')
  else for (const route of r.defaultRoutes) p.push(`the container has a route off its own network (${route})`)
  if (r.dockerSocket) p.push('a Docker socket is in the container')
  return p
}

/** No real secret can be read: not from the disk, not from another process. */
export function secretProblems(r: ProbeReport): string[] {
  const p: string[] = []
  if (r.searched.files < 1000 || r.searched.procs < 2) p.push(`the search covered ${r.searched.files} files and ${r.searched.procs} process records, so nothing was checked`)
  for (const where of r.secrets) p.push(`a secret of this run is readable at ${where}`)
  return p
}

/** The shim, the gate and the harness cannot be changed from inside. */
export function writeProblems(r: ProbeReport): string[] {
  const p: string[] = []
  if (Object.keys(r.writes).length < 6) p.push('the probe tried fewer places than it should')
  for (const [what, answer] of Object.entries(r.writes)) if (answer === 'written') p.push(`${what} could be written from inside`)
  if (r.uid === 0) p.push('the container runs as root')
  if (r.noNewPrivs !== '1') p.push('no-new-privileges is off')
  if (!/^0+$/.test(r.capEff)) p.push(`the container holds capabilities (${r.capEff})`)
  return p
}

/** Nothing from this machine is mounted: only the shared folder. */
/**
 * The mounts a probe reports, from the lines of /proc/self/mountinfo, as `<where> <type>`: every one but
 * those in memory and Docker's own, and the shared folder whatever it is. The launcher's cell keeps that
 * folder in memory with a size, and it is still the one folder of its own a cell has.
 */
export function mountsSeen(mountinfo: string[]): string[] {
  return mountinfo.filter(Boolean)
    .map((line) => { const [left, right] = line.split(' - '); return `${left.split(' ')[4]} ${right.split(' ')[0]}` })
    .filter((m) => m.split(' ')[0] === LAB_DIR || !/ (overlay|proc|sysfs|tmpfs|devpts|mqueue|cgroup2?|shm|devtmpfs)$/.test(m))
    .filter((m) => !['/etc/resolv.conf', '/etc/hostname', '/etc/hosts'].includes(m.split(' ')[0]))
}

/** /tmp, from the lines of /proc/self/mountinfo, as `<type> <options>`. Empty when /tmp is not a mount of its own. */
export function tmpSeen(mountinfo: string[]): string {
  const line = mountinfo.find((l) => l.split(' - ')[0]?.split(' ')[4] === '/tmp')
  if (!line) return ''
  const [left, right] = line.split(' - ')
  const [type, , superOptions] = right.split(' ')
  return `${type} ${left.split(' ')[5]},${superOptions ?? ''}`
}

/**
 * /tmp is no bigger than its size, and nothing in it can be run, be setuid or be a device. `options`
 * is a mount's options as Docker or the kernel writes them, undefined when /tmp is not a mount of its
 * own; a size is in bytes, or with k, m or g. Docker writes the options it was asked for, and mounts a
 * tmpfs noexec, nosuid and nodev unless asked otherwise, so in what Docker says (`docker`) a flag is
 * wrong only when its opposite was asked for. The kernel writes every flag the mount has.
 */
export function tmpProblems(options: string | undefined, seenAs: string, reader: 'docker' | 'kernel'): string[] {
  if (options === undefined) return [`${seenAs}: /tmp is not a mount of its own`]
  const p: string[] = []
  const words = options.split(',')
  const size = /^size=(\d+)([kmg]?)$/i.exec(words.find((w) => w.toLowerCase().startsWith('size=')) ?? '')
  const bytes = size ? Number(size[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 } as Record<string, number>)[size[2].toLowerCase()] : Number.NaN
  if (!Number.isFinite(bytes)) p.push(`${seenAs}: /tmp has no size`)
  else if (bytes > TMP_MB * 1024 * 1024) p.push(`${seenAs}: /tmp is ${Math.round(bytes / 1024 / 1024)} MB, more than its ${TMP_MB} MB`)
  for (const flag of ['noexec', 'nosuid', 'nodev']) {
    const wrong = reader === 'kernel' ? !words.includes(flag) : words.includes(flag.slice(2))
    if (wrong) p.push(`${seenAs}: /tmp is not ${flag}`)
  }
  return p
}

/** /tmp as the probe saw it from inside: in memory, and as `tmpProblems` says. */
export function tmpSeenProblems(r: ProbeReport): string[] {
  const seenAs = 'inside the container'
  if (typeof r.tmp !== 'string') return [`${seenAs}: the probe did not report /tmp, so it was not checked`]
  if (r.tmp === '') return [`${seenAs}: /tmp is not a mount of its own`]
  const [type, options] = r.tmp.split(' ')
  return type === 'tmpfs' ? tmpProblems(options ?? '', seenAs, 'kernel') : [`${seenAs}: /tmp is not in memory (${type})`]
}

export function mountProblems(r: ProbeReport): string[] {
  const places = r.mounts.map((m) => m.split(' ')[0])
  return places.length === 1 && places[0] === LAB_DIR ? [] : [`mounted in the container: ${places.join(', ') || 'nothing, not even the shared folder'}`]
}

/** What `docker network inspect` says a network is. */
export interface DockerNetwork {
  Driver: string
  Internal: boolean
  EnableIPv6: boolean
  IPAM: { Config: { Subnet?: string; Gateway?: string; IPRange?: string; AuxiliaryAddresses?: Record<string, string> }[] | null } | null
  Options: Record<string, string> | null
}

// What Docker writes on a network it was given no option for.
const PLAIN_OPTIONS: Record<string, string> = { 'com.docker.network.enable_ipv4': 'true', 'com.docker.network.enable_ipv6': 'false' }

/**
 * Judges the network Docker really made against what was written down for
 * it: the same block and no other, a way out only if one was written, no
 * IPv6, and no driver or option that was not asked for. `given` is undefined
 * when Docker has no such network.
 */
export function networkProblems(name: string, written: { internal: boolean; subnet: string }, given: DockerNetwork | undefined): string[] {
  if (!given) return [`network ${name} is not there, so it was not compared with what was written`]
  const p: string[] = []
  const blocks = given.IPAM?.Config ?? []
  const made = blocks.map((b) => b.Subnet ?? '?').join(' and ') || 'no block'
  if (blocks.length !== 1 || blocks[0].Subnet !== written.subnet) p.push(`network ${name} was made on ${made}, not on ${written.subnet} as written`)
  // Docker's own side of the network sits in the block. An address from anywhere else would be a way to somewhere else.
  for (const b of blocks) {
    if (b.Gateway !== undefined && b.Gateway !== '' && !inSubnet(b.Gateway, written.subnet)) p.push(`network ${name} has a gateway outside its block (${b.Gateway})`)
    if (b.IPRange !== undefined && b.IPRange !== '') p.push(`network ${name} hands out addresses from a range of its own (${b.IPRange})`)
    if (Object.keys(b.AuxiliaryAddresses ?? {}).length > 0) p.push(`network ${name} sets aside addresses`)
  }
  if (given.Internal !== written.internal) p.push(written.internal ? `network ${name} is not internal` : `network ${name} is internal, and was written with a way out`)
  if (given.EnableIPv6 !== false) p.push(`network ${name} has IPv6 switched on`)
  if (given.Driver !== 'bridge') p.push(`network ${name} is made by another driver (${given.Driver})`)
  for (const [key, value] of Object.entries(given.Options ?? {})) {
    if (PLAIN_OPTIONS[key] !== value) p.push(`network ${name} was given an option (${key}=${value})`)
  }
  return p
}

/** What `docker inspect` says a container was given: the settings that share something with the host or another container. */
export interface HostConfig {
  NetworkMode: string
  PidMode: string
  IpcMode: string
  UsernsMode: string
  UTSMode: string
  Privileged: boolean
  PublishAllPorts: boolean
  PortBindings: Record<string, unknown> | null
  ExtraHosts: string[] | null
  Dns: string[] | null
  Links: string[] | null
  VolumesFrom: string[] | null
  Devices: unknown[] | null
  CapAdd: string[] | null
  CapDrop: string[] | null
  SecurityOpt: string[] | null
  Binds: string[] | null
  /** The places Docker mounted in memory, each with the options it was given. */
  Tmpfs?: Record<string, string> | null
}

/**
 * Judges what Docker itself says it gave a container. The compose file is what
 * was asked for; this is what was given, so a setting that arrived some other
 * way is still seen. `network` is the one network the container may be on.
 */
export function hostConfigProblems(h: HostConfig, network: string): { net: string[]; privilege: string[]; mounts: string[] } {
  const net: string[] = []
  const privilege: string[] = []
  const mounts: string[] = []
  const list = (v: string[] | null | undefined): string[] => v ?? []
  // Its own namespace: Docker writes that as nothing at all, or as `private`.
  const own = (mode: string | undefined): boolean => mode === undefined || mode === '' || mode === 'private'

  if (h.NetworkMode !== network) net.push(`the network mode is ${h.NetworkMode}`)
  for (const port of Object.keys(h.PortBindings ?? {})) net.push(`a port is published (${port})`)
  if (h.PublishAllPorts) net.push('every exposed port is published')
  for (const host of list(h.ExtraHosts)) net.push(`a host name was added (${host})`)
  for (const dns of list(h.Dns)) net.push(`a resolver was set (${dns})`)
  for (const link of list(h.Links)) net.push(`another container is linked (${link})`)

  if (!own(h.PidMode)) privilege.push(`the process namespace is shared (${h.PidMode})`)
  if (!own(h.IpcMode) && h.IpcMode !== 'none') privilege.push(`the IPC namespace is shared (${h.IpcMode})`)
  if (!own(h.UsernsMode)) privilege.push(`the user namespace is shared (${h.UsernsMode})`)
  if (!own(h.UTSMode)) privilege.push(`the host name namespace is shared (${h.UTSMode})`)
  if (h.Privileged) privilege.push('the container is privileged')
  if (list(h.CapAdd).length > 0) privilege.push(`capabilities were added (${list(h.CapAdd).join(', ')})`)
  if (!list(h.CapDrop).some((c) => c.toUpperCase() === 'ALL')) privilege.push('not every capability was dropped')
  const options = list(h.SecurityOpt)
  const noNew = (o: string): boolean => /^no-new-privileges([:=]true)?$/.test(o)
  if (!options.some(noNew)) privilege.push('no-new-privileges is not set')
  for (const o of options.filter((o) => !noNew(o))) privilege.push(`a security option was changed (${o})`)
  if ((h.Devices ?? []).length > 0) privilege.push('a device of the host is in the container')

  // A named volume is written as `name:/path`; a host path starts with a slash.
  for (const bind of list(h.Binds).filter((b) => b.startsWith('/') || b.startsWith('.') || b.startsWith('~'))) mounts.push(`a host path is bound (${bind})`)
  for (const from of list(h.VolumesFrom)) mounts.push(`volumes are taken from another container (${from})`)
  return { net, privilege, mounts }
}
