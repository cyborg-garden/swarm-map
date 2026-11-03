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
// Same shapes as scripts/token-broker/rollout.mjs. "LS0tLS1CRUdJTi" is a base64 PEM header.
const VALUE_RE = /^["']?(?:gh[pousr]_|github_pat_|-----BEGIN|LS0tLS1CRUdJTi)/

export type GithubCredentialFinding = { agent: string; file: string; vars: string[] }
export type GithubCredentialReport = {
  status: 'ok' | 'pending' | 'key-old' | 'fail'
  message: string
  failing: GithubCredentialFinding[]
  pending: GithubCredentialFinding[]
  key: { present: boolean; ageDays: number | null; over90: boolean }
}

export function defaultKeyPath(): string {
  return path.join(os.homedir(), '.config', 'hermes', 'github-app', 'private-key.pem')
}

function credentialNames(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line)
    if (!m || !m[2].trim()) continue
    if ((GITHUB_CREDENTIAL_VARS as readonly string[]).includes(m[1]) || VALUE_RE.test(m[2].trim())) names.add(m[1])
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

  let ageDays: number | null = null
  try {
    ageDays = Math.floor((now - fs.statSync(opts.keyPath ?? defaultKeyPath()).mtimeMs) / DAY_MS)
  } catch {
    // no key on this host yet
  }
  const key = { present: ageDays !== null, ageDays, over90: ageDays !== null && ageDays > KEY_MAX_AGE_DAYS }

  const parts: string[] = []
  if (failing.length) {
    parts.push(`GitHub credential back in: ${failing.map((f) => `${f.agent} ${f.file} (${f.vars.join(', ')})`).join('; ')}. Remove it: ghkey roll <agent> --apply`)
  }
  if (anyBrokered && !key.present) parts.push('The GitHub App key is missing from this host, so agents get no tokens. Run ghkey')
  if (key.over90) parts.push(`The GitHub App key is ${ageDays} days old. Change it with ghkey`)
  if (pending.length) parts.push(`Not yet on the broker: ${[...new Set(pending.map((p) => p.agent))].join(', ')}`)

  const status: GithubCredentialReport['status'] =
    failing.length || (anyBrokered && !key.present) ? 'fail' : key.over90 ? 'key-old' : pending.length ? 'pending' : 'ok'
  return { status, message: parts.join('. ') || 'No GitHub credentials in agent .env files.', failing, pending, key }
}

