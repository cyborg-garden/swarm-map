/**
 * Tripwire for the GitHub token broker: agents moved onto it must hold no GitHub
 * credential. HSM can't see every way one could come back (a hand edit, a restored
 * backup), so this reads the .env files themselves. It reports variable names only
 * and also says when the App key is due for a change.
 *
 * An agent counts as moved once it has the .hsm-github-broker marker. Others show as
 * pending, so the check stays honest during a gradual rollout without crying wolf.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { githubBrokered } from './keys'

export const GITHUB_CREDENTIAL_VARS = [
  'GITHUB_TOKEN', 'GITHUB_PAT', 'GH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_B64', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID',
] as const

export const KEY_MAX_AGE_DAYS = 90
const DAY_MS = 86_400_000
const LINE_RE = /^[ \t]*#?[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
// Same rules as scripts/token-broker/rollout.mjs, because the advice below is to run
// the rollout. A GitHub token is recognisable under any name. A private key isn't, so
// it counts only under a name that says GitHub. "LS0tLS1CRUdJTi" is a base64 PEM header.
const TOKEN_RE = /^["']?(?:gh[pousr]_|github_pat_)/
const PEM_RE = /^["']?(?:-----BEGIN|LS0tLS1CRUdJTi)/
const GITHUB_NAME_RE = /GITHUB|(?:^|_)GH(?:_|$)/i

export type GithubCredentialFinding = { agent: string; file: string; vars: string[] }
export type GithubCredentialReport = {
  status: 'ok' | 'pending' | 'key-old' | 'fail'
  message: string
  failing: GithubCredentialFinding[]
  pending: GithubCredentialFinding[]
  key: { present: boolean; ageDays: number | null; over90: boolean }
  registryBroken: boolean
}

export function defaultKeyPath(): string {
  return path.join(os.homedir(), '.config', 'hermes', 'github-app', 'private-key.pem')
}

function credentialNames(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line)
    if (!m || !m[2].trim()) continue
    const value = m[2].trim()
    if ((GITHUB_CREDENTIAL_VARS as readonly string[]).includes(m[1]) || TOKEN_RE.test(value) || (PEM_RE.test(value) && GITHUB_NAME_RE.test(m[1]))) names.add(m[1])
  }
  return [...names]
}

function envFilesIn(dataDir: string): string[] {
  const list = (dir: string) => {
    try {
      return fs.readdirSync(dir)
    } catch {
      return []
    }
  }
  const top = list(dataDir).filter((n) => n === '.env' || (n.startsWith('.env.') && n !== '.env.example'))
  const profiles = list(path.join(dataDir, 'profiles')).map((p) => path.join('profiles', p, '.env'))
  return [...top, ...profiles]
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
  let anyBrokered = false

  for (const { name, dataDir } of opts.agents) {
    const brokered = githubBrokered(dataDir)
    anyBrokered ||= brokered
    for (const file of envFilesIn(dataDir)) {
      let text: string
      try {
        text = fs.readFileSync(path.join(dataDir, file), 'utf-8')
      } catch {
        continue
      }
      const vars = credentialNames(text)
      if (vars.length) (brokered ? failing : pending).push({ agent: name, file, vars })
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

  const parts: string[] = []
  if (failing.length) {
    parts.push(`GitHub credential back in: ${failing.map((f) => `${f.agent} ${f.file} (${f.vars.join(', ')})`).join('; ')}. Remove it: ghkey roll <agent> --apply`)
  }
  if (badRegistry) parts.push("The GitHub broker's registry.json has a typo, so edits to it aren't applied and a broker restart stops all tokens. Fix the file")
  if (anyBrokered && !key.present) parts.push('The GitHub App key is missing from this host, so agents get no tokens. Run ghkey')
  if (key.over90) parts.push(`The GitHub App key is ${ageDays} days old. Change it with ghkey`)
  if (pending.length) parts.push(`Not yet on the broker: ${[...new Set(pending.map((p) => p.agent))].join(', ')}`)

  const status: GithubCredentialReport['status'] =
    failing.length || badRegistry || (anyBrokered && !key.present) ? 'fail' : key.over90 ? 'key-old' : pending.length ? 'pending' : 'ok'
  return { status, message: parts.join('. ') || 'No GitHub credentials in agent .env files.', failing, pending, key, registryBroken: badRegistry }
}

