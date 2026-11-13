// What the probe reports, and how it is judged. Shared by the rig outside
// (which runs the probe in a container itself) and by the checks inside the
// sidecar's container (which have the harness run it as a tool).
import { LAB_DIR } from './compose.ts'

export interface ProbeReport {
  who: string
  uid: number
  /** Must be open, or the probe had no network at all and its other answers mean nothing. */
  door: string
  doorRoute: string
  /** Everything here must be closed. `open` means a connection was made or a name was resolved. */
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

/** Nothing leaves: only the door answers. */
export function netProblems(r: ProbeReport): string[] {
  const p: string[] = []
  if (r.door !== 'open' || r.doorRoute !== 'open') p.push(`the probe could not reach the door (${r.door}, ${r.doorRoute}), so its other answers mean nothing`)
  if (Object.keys(r.net).length < 8) p.push('the probe tried fewer ways out than it should')
  for (const [what, answer] of Object.entries(r.net)) if (answer === 'open') p.push(`reached ${what}`)
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
