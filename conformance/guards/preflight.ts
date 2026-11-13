// Fake-proof guards, checked before any scenario runs. Each one refuses with
// `REFUSING TO RUN: <guard> ...` rather than warn. They take their inputs as
// arguments so the negative controls can feed them known-bad values.
//
// Why these exist: a test harness once ran against a real host because the
// fake it expected was not on PATH. "The tests use fakes" has to be proven.
import { realpathSync } from 'node:fs'
import path from 'node:path'

export class RefusingToRun extends Error {
  constructor(guard: string, detail: string) {
    super(`REFUSING TO RUN: ${guard} ${detail}`)
    this.name = 'RefusingToRun'
  }
}

// Refusing too much is the safe side, so a telling word anywhere in the name
// counts (API_KEY_PROD, MYSQL_PWD, SSH_AUTH_SOCK), and so does a name that
// says it holds a connection string. This is a list of known names and
// shapes. It cannot know every credential there is: what it has not been
// taught, it lets through. The lab's own environment is listed by hand for
// that reason, and this guard is the second check on it, not the first.
const CREDENTIAL_NAME = new RegExp([
  'TOKEN', 'KEY', 'SECRET', 'PASSW', 'PWD', 'PGPASS', 'CREDENTIAL', 'AUTH', 'COOKIE', 'KUBECONFIG',
  '(^|_)PAT($|_)', '(^|_)(URL|URI|DSN)$',
].join('|'), 'i')

// Shapes of real credentials. Sources are split so this file never contains
// a string the repo's own secret scanner would stop on.
const CREDENTIAL_SHAPES: RegExp[] = [
  new RegExp('\\bsk-' + '[A-Za-z0-9_-]{20,}'),
  new RegExp('\\b[sr]k_' + '(live|test)_[A-Za-z0-9]{16,}'),
  new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{30,}'),
  new RegExp('\\bgithub_pat_' + '[A-Za-z0-9_]{20,}'),
  new RegExp('\\bgl' + 'pat-[A-Za-z0-9_-]{20,}'),
  new RegExp('\\bx(ox[baprs]|app)-' + '[A-Za-z0-9-]{10,}'),
  new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b'),
  new RegExp('\\bAI' + 'za[0-9A-Za-z_-]{35}'),
  new RegExp('\\bntn_' + '[A-Za-z0-9]{20,}'),
  new RegExp('\\bhf_' + '[A-Za-z0-9]{30,}'),
  new RegExp('\\bnpm_' + '[A-Za-z0-9]{36}'),
  new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'),
  // A JSON web token: three dotted parts, the first two starting the way encoded JSON does.
  new RegExp('\\bey' + 'J[A-Za-z0-9_-]{8,}\\.ey' + 'J[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'),
  // Chat bot tokens: three dotted parts of fixed lengths, or a numeric id, a colon and a secret.
  /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
  // Any URL that carries a password.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
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
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Where a path really is: links followed as far as the path exists, the rest kept as written. */
function realPlace(p: string): string {
  const resolved = path.resolve(p)
  const rest: string[] = []
  let at = resolved
  for (;;) {
    try { return path.join(realpathSync(at), ...rest) } catch { /* does not exist yet: try its parent */ }
    const parent = path.dirname(at)
    if (parent === at) return resolved
    rest.unshift(path.basename(at))
    at = parent
  }
}

/**
 * F5. Refuses a work dir that is not under the temp dir, or is anywhere in the
 * home directory or an agent's home. Judged by where the path really is, so a
 * link under the temp dir that points somewhere else is refused too.
 */
export function assertSafeWorkDir(dir: string, where: { home: string; tmp: string }): void {
  const resolved = realPlace(dir)
  const tmp = realPlace(where.tmp)
  const agentHome = [path.resolve(dir), resolved].some((p) => p.split(path.sep).some((seg) => seg.startsWith('.hermes') || seg === 'hermes-swarm'))
  if (agentHome) throw new RefusingToRun('F5', `work dir is inside an agent home: ${resolved}`)
  if (!inside(resolved, tmp) || resolved === tmp) {
    throw new RefusingToRun('F5', `work dir is not under the temp dir: ${resolved}`)
  }
  if (inside(resolved, realPlace(where.home))) {
    throw new RefusingToRun('F5', `work dir is inside the home directory: ${resolved}`)
  }
}
