// lib/resolvers/discord.ts

import fs from 'fs'
import path from 'path'
import os from 'os'
import { SURFACES } from '@/lib/surfaces/registry'
import type { ResolvedIdentity } from './signal'

function getDiscordBotToken(harnessId: string): string | null {
  const name = harnessId.replace(/^h_/, '').replace(/_/g, '-')
  const dataDir = name === 'personal'
    ? path.join(os.homedir(), '.hermes')
    : path.join(os.homedir(), `.hermes-${name}`)
  const envPath = path.join(dataDir, '.env')

  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    const token = content.match(/^DISCORD_BOT_TOKEN=(.+)$/m)?.[1]?.trim()
    if (token) return token
  } catch {}
  return null
}

const DISCORD_API = 'https://discord.com/api/v10'
// Per-request timeout + an overall deadline for the guild scan: this runs
// inline in the settings PUT, so a hung Discord connection must not hold the
// operator's save hostage (undici's default lets a dead socket sit ~300s).
const FETCH_TIMEOUT_MS = 5_000
const SCAN_DEADLINE_MS = 15_000

// The settings PUT resolves each username twice by construction (allowlist
// expansion, then the resolved-identities rebuild). A short-lived memo keeps
// that from doubling the API traffic without letting stale answers persist
// across saves.
const memo = new Map<string, { at: number; value: ResolvedIdentity | null }>()
const MEMO_TTL_MS = 60_000

/**
 * Resolve a Discord username to the numeric snowflake, by searching the
 * members of every guild the bot is in.
 *
 * AUTHORIZATION-GRADE matching, deliberately narrower than the runtime's
 * display resolution: only `user.username` is compared. Usernames are
 * globally unique on Discord; `global_name` and `nick` are freely
 * self-settable, so matching them would let anyone in a shared guild
 * name-squat an operator's intended entry and get their own snowflake
 * persisted into DISCORD_ALLOWED_USERS (which also feeds the surface-admins
 * bootstrap). For the same reason, if different snowflakes match the same
 * name across guilds (possible mid-migration or via API drift), resolution
 * REFUSES rather than picking one — the raw entry is kept unchanged.
 *
 * Every failure path — no token, 429, timeout, deadline, ambiguity — returns
 * null: the caller stores the raw entry, no worse than before this resolver
 * existed.
 */
export async function resolveDiscordUsername(
  harnessId: string,
  username: string
): Promise<ResolvedIdentity | null> {
  const token = getDiscordBotToken(harnessId)
  if (!token) return null

  const query = (username.startsWith('@') ? username.slice(1) : username).trim()
  if (!query) return null

  const memoKey = `${harnessId}:${query.toLowerCase()}`
  const hit = memo.get(memoKey)
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.value

  const value = await scanGuildsForUsername(token, query)
  memo.set(memoKey, { at: Date.now(), value })
  return value
}

async function scanGuildsForUsername(
  token: string,
  query: string
): Promise<ResolvedIdentity | null> {
  const wanted = query.toLowerCase()
  const headers = { Authorization: `Bot ${token}` }
  const deadline = Date.now() + SCAN_DEADLINE_MS
  const get = (url: string) =>
    fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })

  try {
    // Single page: caps at 200 guilds. Guilds beyond that are not scanned —
    // acceptable for a resolver that fails toward "keep the raw entry".
    const guildsRes = await get(`${DISCORD_API}/users/@me/guilds`)
    if (!guildsRes.ok) return null
    const guilds = (await guildsRes.json()) as Array<{ id: string }>
    if (!Array.isArray(guilds)) return null

    const matches = new Map<string, ResolvedIdentity>()
    for (const guild of guilds) {
      if (Date.now() > deadline) return null
      const searchRes = await get(
        `${DISCORD_API}/guilds/${guild.id}/members/search?query=${encodeURIComponent(query)}&limit=25`,
      )
      if (searchRes.status === 429) {
        // Rate-limited: abort the whole scan. Treating 429 as "not in this
        // guild" and continuing could skip the true guild and let a match
        // from a later guild win — feeding exactly the squatting scenario
        // the username-only rule exists to prevent.
        return null
      }
      if (!searchRes.ok) continue
      const members = (await searchRes.json()) as Array<{
        user?: { id: string; username: string }
      }>
      if (!Array.isArray(members)) continue

      for (const member of members) {
        const user = member.user
        if (!user?.id) continue
        if (user.username.toLowerCase() === wanted) {
          matches.set(user.id, {
            display: query,
            nativeId: user.id,
            profileName: user.username,
          })
        }
      }
    }

    if (matches.size === 1) return matches.values().next().value ?? null
    // Zero matches, or conflicting snowflakes for one name: refuse.
    return null
  } catch {
    return null
  }
}

// The canonical snowflake shape from the surface registry (15–21 digits: real
// snowflakes are 17–20, 64-bit with the 2015 epoch; the wider bound tolerates
// clock drift at both ends without swallowing short numeric usernames). The
// discord case in resolvers/index.ts sources the same pattern.
const DISCORD_SNOWFLAKE_RE = SURFACES.discord.identity.nativePattern

/**
 * Expand a Discord allowlist so every username entry is stored alongside its
 * resolved snowflake.
 *
 * The runtime matches inbound author ids against DISCORD_ALLOWED_USERS
 * verbatim, and the HSM policy plane (surface-admins bootstrap →
 * is_platform_admin) reads the same env var raw — a username-only entry
 * therefore authorizes at the agent (which resolves usernames itself at
 * on_ready) while staying permanently invisible to the policy plane. Storing
 * BOTH forms keeps the two planes agreeing on who the operator meant.
 *
 * - '*' and entries already in snowflake form pass through untouched.
 * - Usernames that resolve unambiguously gain their snowflake alongside.
 * - Usernames that fail to resolve (or resolve ambiguously) pass through
 *   unchanged — no worse than before; resolution retries on the next write.
 *
 * Order is preserved and duplicates are removed — mirrors
 * expandSignalAllowlist.
 */
export async function expandDiscordAllowlist(
  harnessId: string,
  identifiers: string[]
): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }

  for (const raw of identifiers) {
    const id = raw.trim()
    if (!id) continue
    push(id)
    if (id === '*' || DISCORD_SNOWFLAKE_RE.test(id)) continue
    const resolved = await resolveDiscordUsername(harnessId, id)
    if (resolved?.nativeId) push(resolved.nativeId)
  }

  return out
}

/** Test hook: the memo would otherwise leak resolutions across test cases. */
export function _clearDiscordResolverMemo(): void {
  memo.clear()
}
