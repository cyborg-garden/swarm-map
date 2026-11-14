// What the probe reports, and how it is judged. Shared by the rig outside
// (which runs the probe in a container itself) and by the checks inside the
// sidecar's container (which have the harness run it as a tool).
import { lstatSync, readFileSync } from 'node:fs'
import { LAB_DIR } from './compose.ts'

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
  noNewPrivs: string
  capEff: string
  ipv6: string[]
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
export function mountProblems(r: ProbeReport): string[] {
  const places = r.mounts.map((m) => m.split(' ')[0])
  return places.length === 1 && places[0] === LAB_DIR ? [] : [`mounted in the container: ${places.join(', ') || 'nothing, not even the shared folder'}`]
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
