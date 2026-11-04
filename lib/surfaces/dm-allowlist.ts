// lib/surfaces/dm-allowlist.ts
//
// Who may DM an agent, on the two surfaces that can limit DMs on their own.
//
// Discord: DISCORD_DM_ALLOWED_USERS (hermes-agent-mt#200). Unset or empty means
// nobody; '*' turns the gate off. A listed user must still pass the normal
// allowlist. Swarm Map keeps it equal to the agent's Discord surface admins, and
// never derives '*'.
//
// Signal: SIGNAL_ALLOWED_USERS gates DMs and SIGNAL_GROUP_ALLOWED_USERS gates
// groups, so there is no extra var. This list is NOT kept in step with the
// admins: it can hold ordinary DM users too, and rewriting it on an admin change
// would evict them. Only its starting value is admins-or-closed.

import { SURFACES, surfaceSpec } from './registry'

export const DISCORD_DM_USERS_VAR = SURFACES.discord.admission.dmUsers!

// Written to SIGNAL_ALLOWED_USERS to mean "nobody". Empty cannot say that: the
// adapter reads an unset list as '*' and an empty one as open mode, where a
// stranger's group invite is accepted, and the gateway answers strangers' DMs
// with pairing codes. No Signal sender id can be '0'. Same idea as the Discord
// channel sentinel in the settings route.
export const SIGNAL_DENY_ALL_USERS = '0'

function parseList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((x) => right.has(x))
}

/**
 * The entries that are real ids on this surface, trimmed and deduped. Drops '*',
 * unresolved usernames and the deny value, none of which belong in a DM list.
 */
export function validIdentities(platform: string, ids: readonly string[]): string[] {
  const pattern = surfaceSpec(platform)?.identity.nativePattern
  if (!pattern) return []
  return [...new Set(ids.map((s) => s.trim()).filter((s) => pattern.test(s)))]
}

/**
 * Set a key in .env text. Replaces every existing line for it (compose's
 * last-wins would otherwise keep a stale one) or appends. Other lines are kept.
 */
export function setEnvLine(env: string, key: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${key} must not contain newline characters`)
  const lines = env.split('\n')
  const isKey = (l: string) => l.startsWith(`${key}=`)
  if (!lines.some(isKey)) return env.trimEnd() + (env.trim() ? '\n' : '') + `${key}=${value}\n`
  const out: string[] = []
  let placed = false
  for (const raw of lines) {
    if (!isKey(raw)) {
      out.push(raw)
    } else if (!placed) {
      out.push(`${key}=${value}${raw.endsWith('\r') ? '\r' : ''}`)
      placed = true
    }
  }
  return out.join('\n')
}

/**
 * New DISCORD_DM_ALLOWED_USERS after an explicit admin change, or null for no
 * write. A '*' is an operator's deliberate choice, so it stays.
 */
export function discordDmAfterAdminSet(current: string | undefined, admins: readonly string[]): string | null {
  const now = parseList(current)
  if (now.includes('*')) return null
  const next = validIdentities('discord', admins)
  return sameSet(now, next) ? null : next.join(',')
}

/**
 * New DISCORD_DM_ALLOWED_USERS after a settings save, for an agent with no
 * explicit admin list (its allowlist doubles as its admins), or null for no write.
 *
 * Both clients PUT the whole document back, so only a real allowlist change
 * counts. Even then the DM list follows only if it matched the allowlist before:
 * a list that differs was set by hand, and an allowlist edit must not widen it,
 * and must not open an agent whose DMs are closed while it already has users.
 */
export function discordDmAfterAllowlistEdit(
  current: string | undefined,
  allowlistBefore: string | undefined,
  allowlistAfter: string,
): string | null {
  if (parseList(allowlistAfter).includes('*')) return null
  const before = validIdentities('discord', parseList(allowlistBefore))
  const after = validIdentities('discord', parseList(allowlistAfter))
  if (sameSet(before, after)) return null
  if (!sameSet(parseList(current), before)) return null
  return after.join(',')
}
