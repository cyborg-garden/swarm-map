// lib/surfaces/dm-allowlist.ts
//
// Who may DM an agent, on the two surfaces that can limit DMs on their own.
//
// Discord: DISCORD_DM_ALLOWED_USERS (hermes-agent-mt#200). Unset or empty means
// nobody; '*' turns the gate off. A listed user must still pass the normal
// allowlist. It starts as the agent's explicit admins or the admins named at
// connect, and follows admin changes while it still matches them. Allowlist edits
// never move it: the allowlist also holds channel users. Swarm Map never derives '*'.
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

export type DmListChange = { action: 'write'; value: string } | { action: 'none' } | { action: 'left' }

/**
 * What an explicit admin change does to DISCORD_DM_ALLOWED_USERS. `previousAdmins`
 * is the explicit list before this change, empty if there was none. The list
 * follows only if it equalled that. A list that differs, or a '*', was set
 * deliberately, so it is 'left' and the caller tells the operator.
 *
 * Empty with no earlier explicit list counts as matching, so a first admin list
 * opens an agent that started closed: nothing else in Swarm Map can.
 */
export function discordDmAfterAdminSet(
  current: string | undefined,
  previousAdmins: readonly string[],
  admins: readonly string[],
): DmListChange {
  const now = parseList(current)
  if (now.includes('*')) return { action: 'left' }
  const next = validIdentities('discord', admins)
  if (sameSet(now, next)) return { action: 'none' }
  if (!sameSet(now, validIdentities('discord', previousAdmins))) return { action: 'left' }
  return { action: 'write', value: next.join(',') }
}

/**
 * Admins the DM list lets through who still cannot DM, because they are not on
 * DISCORD_ALLOWED_USERS. They only pass if they hold an allowed role.
 */
export function discordDmRefusedAdmins(env: string, admins: readonly string[]): string[] {
  const value = (key: string): string | undefined => {
    const line = env.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.startsWith(`${key}=`)).pop()
    return line?.slice(key.length + 1).trim()
  }
  const allowed = parseList(value(SURFACES.discord.admission.users))
  if (allowed.includes('*') || ['true', '1', 'yes'].includes((value('DISCORD_ALLOW_ALL_USERS') ?? '').toLowerCase())) return []
  const dm = parseList(value(DISCORD_DM_USERS_VAR))
  return admins.filter((a) => (dm.includes('*') || dm.includes(a)) && !allowed.includes(a))
}

/** Operator-facing warning for discordDmRefusedAdmins, or undefined if nobody is refused. */
export function discordDmRefusedWarning(env: string, admins: readonly string[]): string | undefined {
  const refused = discordDmRefusedAdmins(env, admins)
  if (refused.length === 0) return undefined
  return `Not on ${SURFACES.discord.admission.users}, so their DMs are refused unless they hold an allowed role: ${refused.join(', ')}.`
}
