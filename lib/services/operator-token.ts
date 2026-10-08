import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * First-run operator-token bootstrap.
 *
 * The middleware is FAIL-CLOSED: with HSM_OPERATOR_TOKEN unset, every gated
 * request 503s ("auth not configured") and the app is unusable — a fresh clone
 * had no way to obtain a token, and the login route could not set a session for
 * a token that didn't exist. This generates one on first boot and persists it to
 * `.env.local` (gitignored, 0600) so Next loads it into every runtime.
 *
 * Auto-generating is what makes `git clone && npm run seed && npm run dev` work
 * without the operator hand-editing env files; the token is still required to
 * log in, so the fail-closed protection is preserved.
 */

export const OPERATOR_TOKEN_ENV = 'HSM_OPERATOR_TOKEN'
const ENV_FILE = '.env.local'

export type OperatorTokenResult =
  | { status: 'present'; source: 'env' }
  | { status: 'generated'; path: string }
  | { status: 'ephemeral'; token: string; reason: string }

/** Replace (or append) a `KEY=value` line without disturbing the rest of the file. */
export function upsertEnvLine(content: string, key: string, value: string): string {
  const line = `${key}=${value}`
  // [ \t]* not \s*: under the `m` flag \s also matches newlines, so a blank line
  // above the key would be swallowed into the match and deleted.
  const re = new RegExp(`^[ \\t]*${key}=.*$`, 'm')
  if (re.test(content)) return content.replace(re, line)
  const prefix = content === '' || content.endsWith('\n') ? content : `${content}\n`
  return `${prefix}${line}\n`
}

function readEnvToken(content: string, key: string): string | null {
  const line = content
    .split('\n')
    .find((l) => l.trimStart().startsWith(`${key}=`))
  if (!line) return null
  const value = line.slice(line.indexOf('=') + 1).trim()
  return value || null
}

/**
 * Ensure HSM_OPERATOR_TOKEN is set for this process, generating + persisting one
 * if the operator hasn't configured it. Never throws.
 */
export function ensureOperatorToken(envPath = path.join(process.cwd(), ENV_FILE)): OperatorTokenResult {
  if (process.env[OPERATOR_TOKEN_ENV]?.trim()) return { status: 'present', source: 'env' }

  const existingFile = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const existing = readEnvToken(existingFile, OPERATOR_TOKEN_ENV)
  if (existing) {
    // Only reachable if Next didn't load .env.local (e.g. cwd mismatch). Adopt it.
    process.env[OPERATOR_TOKEN_ENV] = existing
    return { status: 'present', source: 'env' }
  }

  const token = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(envPath, upsertEnvLine(existingFile, OPERATOR_TOKEN_ENV, token), { mode: 0o600 })
    // `mode` only applies when the file is created. A pre-existing .env.local
    // (e.g. 0644 from an editor) would otherwise keep its looser permissions
    // while now holding the operator secret.
    fs.chmodSync(envPath, 0o600)
  } catch (err) {
    // Can't persist (read-only checkout, no cwd write). The token still works for
    // this process, but the caller must print it — otherwise the operator can
    // never learn it and the app is bricked.
    process.env[OPERATOR_TOKEN_ENV] = token
    return { status: 'ephemeral', token, reason: err instanceof Error ? err.message : String(err) }
  }
  process.env[OPERATOR_TOKEN_ENV] = token
  return { status: 'generated', path: envPath }
}
