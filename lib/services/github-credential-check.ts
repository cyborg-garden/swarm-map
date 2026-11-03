/**
 * Tripwire for the GitHub token broker: agents moved onto it must hold no GitHub
 * credential. HSM can't see every way one could come back (a hand edit, a restored
 * backup, gh auth login), so this reads the .env files and the git and gh login files
 * themselves. It reports variable and file names only, and also says when the App key
 * is due for a change.
 *
 * An agent counts as moved once it has the .hsm-github-broker marker or its broker
 * secret. On a host running the broker, any other agent holding a credential is
 * pending. That is loud too, because a new deploy or a removed marker looks the same
 * as an agent not yet moved. A host with no broker has nothing to report.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { GITHUB_BROKER_CONFIG, githubBrokered } from './keys'

export const GITHUB_CREDENTIAL_VARS = [
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID',
] as const

export const KEY_MAX_AGE_DAYS = 90
const DAY_MS = 86_400_000
const LINE_RE = /^[ \t#]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/
// Same rules as scripts/token-broker/rollout.mjs, because the advice below is to run
// the rollout. A GitHub token is recognisable under any name. A private key isn't, so
// it counts only under a name that says GitHub. "LS0tLS1CRUdJTi" is a base64 PEM header.
const TOKEN_RE = /^["']?(?:gh[pousr]_|github_pat_)/
const PEM_RE = /^["']?(?:-----BEGIN|LS0tLS1CRUdJTi)/
const GITHUB_NAME_RE = /GITHUB|(?:^|_)GH(?:_|$)/i

// Git and gh keep their logins outside .env. Same rules as rollout.mjs, which removes
// what these flag. A short-lived ghs_ token is what the broker itself hands out.
const LOGIN_FILES = ['.git-credentials', path.join('.config', 'gh', 'hosts.yml')]
const GIT_LOGIN_RE = /^\s*https?:\/\/([^\s/]*)@(?:[^\s/@]*\.)?github\.com(?::\d+)?(?:\/\S*)?\s*$/i
const GH_BLOCK_RE = /^["']?github\.com["']?\s*:/
const GH_TOKEN_RE = /^\s+oauth_token:\s*["']?([^\s"']+)/

export function gitCredentialsHoldToken(text: string): boolean {
  return text.split('\n').some((line) => {
    const m = GIT_LOGIN_RE.exec(line)
    if (!m) return false
    const secret = m[1].slice(m[1].indexOf(':') + 1)
    return !!secret && !secret.startsWith('ghs_')
  })
}

export function ghHostsHoldToken(text: string): boolean {
  let inside = false
  return text.split('\n').some((line) => {
    if (/^[^\s#]/.test(line)) inside = GH_BLOCK_RE.test(line)
    const m = inside ? GH_TOKEN_RE.exec(line) : null
    return !!m && !m[1].startsWith('ghs_')
  })
}

export type GithubCredentialFinding = { agent: string; file: string; vars: string[] }
export type GithubCredentialReport = {
  status: 'ok' | 'pending' | 'key-old' | 'fail'
  message: string
  failing: GithubCredentialFinding[]
  pending: GithubCredentialFinding[]
  unreadable: { agent: string; file: string }[]
  key: { present: boolean; ageDays: number | null; over90: boolean }
  registryBroken: boolean
}

export function defaultKeyPath(): string {
  return path.join(os.homedir(), '.config', 'hermes', 'github-app', 'private-key.pem')
}

function credentialNames(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.replace(/\r$/, ''))
    if (!m || !m[2].trim()) continue
    const value = m[2].trim()
    if ((GITHUB_CREDENTIAL_VARS as readonly string[]).includes(m[1]) || TOKEN_RE.test(value) || (PEM_RE.test(value) && GITHUB_NAME_RE.test(m[1]))) names.add(m[1])
  }
  return [...names]
}

// Same names as scripts/token-broker/rollout.mjs. A file that exists and can't be read
// is reported rather than skipped. A subdirectory or a file that just vanished isn't.
function envFilesIn(dataDir: string): string[] {
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }
  const envs = (rel: string) => list(path.join(dataDir, rel))
    .filter((n) => n.startsWith('.env') && n !== '.env.example')
    .map((n) => path.join(rel, n))
  return [...envs(''), ...list(path.join(dataDir, 'profiles')).flatMap((p) => envs(path.join('profiles', p)))]
}

// The tool HOME (home/) and the gateway HOME (the agent home itself), per profile.
function loginFilesIn(dataDir: string): string[] {
  let profiles: string[] = []
  try {
    profiles = fs.readdirSync(path.join(dataDir, 'profiles')).map((p) => path.join('profiles', p))
  } catch {
    // no profiles
  }
  return ['', ...profiles].flatMap((d) => [d, path.join(d, 'home')]).flatMap((base) => LOGIN_FILES.map((f) => path.join(base, f)))
}

// A typo here leaves the broker on its last good copy, so her edit silently isn't
// applied. Same shape rule as scripts/token-broker/lib.mjs. The parse error stays out
// of the report because it quotes the file.
function registryBroken(file: string): boolean {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!r || typeof r !== 'object' || Array.isArray(r)) return true
    if (r.agents === undefined) return false
    if (!r.agents || typeof r.agents !== 'object' || Array.isArray(r.agents)) return true
    return !Object.values(r.agents).every((e) => e && typeof e === 'object' && !Array.isArray(e))
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

export function checkGithubCredentials(opts: {
  agents: { name: string; dataDir: string }[]
  keyPath?: string
  now?: number
}): GithubCredentialReport {
  const now = opts.now ?? Date.now()
  const failing: GithubCredentialFinding[] = []
  const pending: GithubCredentialFinding[] = []
  const unreadable: GithubCredentialReport['unreadable'] = []
  let anyBrokered = false

  for (const { name, dataDir } of opts.agents) {
    const brokered = githubBrokered(dataDir) || fs.existsSync(path.join(dataDir, GITHUB_BROKER_CONFIG))
    anyBrokered ||= brokered
    for (const file of envFilesIn(dataDir)) {
      let text: string
      try {
        text = fs.readFileSync(path.join(dataDir, file), 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') unreadable.push({ agent: name, file })
        continue
      }
      const vars = credentialNames(text)
      if (vars.length) (brokered ? failing : pending).push({ agent: name, file, vars })
    }
    for (const file of loginFilesIn(dataDir)) {
      let text: string
      try {
        text = fs.readFileSync(path.join(dataDir, file), 'utf-8')
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'EISDIR' && code !== 'ENOTDIR') unreadable.push({ agent: name, file })
        continue
      }
      const holds = path.basename(file) === '.git-credentials' ? gitCredentialsHoldToken(text) : ghHostsHoldToken(text)
      if (holds) (brokered ? failing : pending).push({ agent: name, file, vars: ['GitHub token'] })
    }
  }

  const keyPath = opts.keyPath ?? defaultKeyPath()
  const badRegistry = registryBroken(path.join(path.dirname(keyPath), 'registry.json'))
  let ageDays: number | null = null
  try {
    ageDays = Math.floor((now - fs.statSync(keyPath).mtimeMs) / DAY_MS)
  } catch {
    // no key on this host yet
  }
  const key = { present: ageDays !== null, ageDays, over90: ageDays !== null && ageDays > KEY_MAX_AGE_DAYS }

  const brokerInUse = anyBrokered || key.present
  const cantCheck = brokerInUse ? unreadable : []
  const holding = brokerInUse ? pending : []

  const parts: string[] = []
  if (failing.length) {
    parts.push(`GitHub credential back in: ${failing.map((f) => `${f.agent} ${f.file} (${f.vars.join(', ')})`).join('; ')}. Remove it: ghkey roll <agent> --apply`)
  }
  if (cantCheck.length) parts.push(`Could not read ${cantCheck.map((u) => `${u.agent} ${u.file}`).join('; ')}, so it can't be checked`)
  if (badRegistry) parts.push("The GitHub broker's registry.json has a typo, so edits to it aren't applied and a broker restart stops all tokens. Fix the file")
  if (anyBrokered && !key.present) parts.push('The GitHub App key is missing from this host, so agents get no tokens. Run ghkey')
  if (key.over90) parts.push(`The GitHub App key is ${ageDays} days old. Change it with ghkey`)
  if (holding.length) parts.push(`Not on the broker and holding GitHub credentials: ${[...new Set(holding.map((p) => p.agent))].join(', ')}. Move them: ghkey roll <agent> --apply`)

  const status: GithubCredentialReport['status'] =
    failing.length || cantCheck.length || badRegistry || (anyBrokered && !key.present) ? 'fail' : key.over90 ? 'key-old' : holding.length ? 'pending' : 'ok'
  const quiet = brokerInUse ? 'No GitHub credentials in agent .env files.' : 'The GitHub token broker is not set up on this host.'
  return { status, message: parts.join('. ') || quiet, failing, pending, unreadable, key, registryBroken: badRegistry }
}
