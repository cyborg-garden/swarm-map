// Fake-proof guards, checked before any scenario runs. Each one refuses with
// `REFUSING TO RUN: <guard> ...` rather than warn. They take their inputs as
// arguments so the negative controls can feed them known-bad values.
//
// Why these exist: a test harness once ran against a real host because the
// fake it expected was not on PATH. "The tests use fakes" has to be proven.
import path from 'node:path'

export class RefusingToRun extends Error {
  constructor(guard: string, detail: string) {
    super(`REFUSING TO RUN: ${guard} ${detail}`)
    this.name = 'RefusingToRun'
  }
}

// Refusing too much is the safe side, so any name ending in KEY counts.
const CREDENTIAL_NAME = /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$|SECRET/i

// Shapes of real credentials. Sources are split so this file never contains
// a string the repo's own secret scanner would stop on.
const CREDENTIAL_SHAPES: RegExp[] = [
  new RegExp('\\bsk-' + '[A-Za-z0-9_-]{20,}'),
  new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{30,}'),
  new RegExp('\\bgithub_pat_' + '[A-Za-z0-9_]{20,}'),
  new RegExp('\\bxox[baprs]-' + '[A-Za-z0-9-]{10,}'),
  new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b'),
  new RegExp('\\bntn_' + '[A-Za-z0-9]{20,}'),
  new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'),
]

/** The only secret-shaped values a run may carry: fakes stamped with its own nonce. */
function isRunFake(name: string, value: string, nonce: string | undefined): boolean {
  if (!nonce || !name.startsWith('SWARMLAB_')) return false
  return value === nonce || value === `FAKECHAT-${nonce}` || value === `UPSTREAM-${nonce}` || value === `PLACEHOLDER-${nonce}`
}

/** F2. Refuses if the env names or holds anything shaped like a real credential. Never prints a value. */
export function assertNoCredentials(env: Record<string, string | undefined>, opts: { nonce?: string } = {}): void {
  const bad: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (name.startsWith('SWARMLAB_')) {
      if (!isRunFake(name, value, opts.nonce)) bad.push(name)
      continue
    }
    if (CREDENTIAL_NAME.test(name) || CREDENTIAL_SHAPES.some((re) => re.test(value))) bad.push(name)
  }
  if (bad.length > 0) {
    throw new RefusingToRun('F2', `credential-shaped env present: ${bad.sort().join(', ')} (values not shown)`)
  }
}

/** F5. Refuses unless Docker is reached over a local unix socket. */
export function assertLocalDocker(docker: { dockerHost?: string; contextEndpoint?: string }): void {
  const local = (endpoint: string): boolean => endpoint.startsWith('unix://')
  if (docker.dockerHost !== undefined && docker.dockerHost !== '' && !local(docker.dockerHost)) {
    throw new RefusingToRun('F5', `DOCKER_HOST is not a local unix socket: ${docker.dockerHost}`)
  }
  const endpoint = docker.contextEndpoint ?? docker.dockerHost
  if (!endpoint || !local(endpoint)) {
    throw new RefusingToRun('F5', `the Docker endpoint is not a local unix socket: ${endpoint || '(unknown)'}`)
  }
}

export const PROJECT_NAME = /^swarmlab-[0-9a-f]{8}$/

/** F5. Refuses a compose project or container that is not the lab's own. */
export function assertOurProject(project: string, containerNames: string[]): void {
  if (!PROJECT_NAME.test(project)) throw new RefusingToRun('F5', `compose project is not a lab project: ${project}`)
  const foreign = containerNames.filter((name) => !name.startsWith(`${project}-`))
  if (foreign.length > 0) throw new RefusingToRun('F5', `container outside the lab project: ${foreign.join(', ')}`)
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** F5. Refuses a work dir outside the temp dir, or anywhere near an agent's home. */
export function assertSafeWorkDir(dir: string, where: { home: string; tmp: string }): void {
  const resolved = path.resolve(dir)
  const agentHome = resolved.split(path.sep).some((seg) => seg.startsWith('.hermes') || seg === 'hermes-swarm')
  if (agentHome) throw new RefusingToRun('F5', `work dir is inside an agent home: ${resolved}`)
  if (!inside(resolved, where.tmp) || resolved === path.resolve(where.tmp)) {
    throw new RefusingToRun('F5', `work dir is not under the temp dir: ${resolved}`)
  }
}
