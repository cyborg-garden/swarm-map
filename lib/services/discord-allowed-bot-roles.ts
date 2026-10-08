/**
 * Fleet-wide Discord bot-sender gate — DISCORD_ALLOWED_BOT_ROLES.
 *
 * The Hermes Discord adapter admits other bots by DISCORD_ALLOW_BOTS
 * (mentions/all) and, before hermes-agent-mt's bot role gate, skipped the
 * human allowlists for them entirely: any bot in an allowed channel could
 * drive an agent with one @mention. With DISCORD_ALLOWED_BOT_ROLES set, a bot
 * must ALSO hold one of the listed roles in the server the message came from.
 * The role is checked live per message, so granting or removing the Discord
 * role takes effect at once; only changing WHICH role needs this write.
 *
 * The `discordAllowedBotRoles` setting holds the role IDs;
 * `syncDiscordAllowedBotRoles` writes them into every Discord agent's .env
 * (the only place the adapter reads them). `discordAllowedBotRolesPosture`
 * reports, never writes.
 *
 * null / unset setting = swarm-map leaves the var alone. There is no "empty"
 * value: an empty var turns the gate OFF in the adapter, so `[]` is refused
 * rather than written fleet-wide by accident.
 *
 * The @everyone role's id is the guild id; it never grants in the adapter, and
 * the setting refuses the garden guild's id so a copy-paste of it cannot read
 * as "configured" while gating nothing useful.
 */

import fs from 'fs'
import path from 'path'
import { SURFACES } from '@/lib/surfaces/registry'
import { hasDiscordSurface, readEnvValue } from './discord-thread-gate'

export const DISCORD_ALLOWED_BOT_ROLES_VAR = SURFACES.discord.behavior.allowedBotRoles!

/** A Discord snowflake. Each role lands verbatim on a .env line. */
export const ROLE_ID_RE = /^[0-9]{15,21}$/

/** The garden guild — its id is also its @everyone role id. */
export const GARDEN_GUILD_ID = '1531068097719570432'

/** True when `v` is a non-empty list of role IDs safe to write. */
export function isAllowedBotRoleList(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((r) => typeof r === 'string' && ROLE_ID_RE.test(r) && r !== GARDEN_GUILD_ID)
  )
}

/** Role IDs in a .env value, in order. */
export function parseRoleList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * Set DISCORD_ALLOWED_BOT_ROLES to exactly `roles` in a .env. Replaces every
 * existing line for the key (compose's last-wins would otherwise keep a stale
 * one), or appends. Every other line is left as is.
 */
export function setAllowedBotRolesEnv(env: string, roles: readonly string[]): { status: 'updated' | 'unchanged'; env: string } {
  // settings.json is read back unvalidated; a hand edit must not inject lines.
  if (!isAllowedBotRoleList(roles)) throw new Error('allowed bot roles must be Discord role IDs')
  const want = roles.join(',')
  const current = readEnvValue(env, DISCORD_ALLOWED_BOT_ROLES_VAR)
  const lines = env.split('\n')
  const keyLines = lines.filter((l) => l.replace(/\r$/, '').startsWith(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=`))
  if (current === want && keyLines.length === 1) return { status: 'unchanged', env }
  const line = `${DISCORD_ALLOWED_BOT_ROLES_VAR}=${want}`
  if (keyLines.length === 0) return { status: 'updated', env: env.trimEnd() + `\n${line}\n` }
  const out: string[] = []
  let placed = false
  for (const raw of lines) {
    if (raw.replace(/\r$/, '').startsWith(`${DISCORD_ALLOWED_BOT_ROLES_VAR}=`)) {
      if (!placed) {
        out.push(raw.endsWith('\r') ? line + '\r' : line)
        placed = true
      }
      continue
    }
    out.push(raw)
  }
  return { status: 'updated', env: out.join('\n') }
}

/**
 * Apply the `discordAllowedBotRoles` setting to one agent's .env text, for
 * the paths that bring a Discord agent into the fleet between server starts
 * (import, connecting Discord). Unmanaged or invalid settings and agents with
 * no Discord token leave the text unchanged. Never throws.
 */
export function applyAllowedBotRolesSetting(env: string, setting: unknown): string {
  if (!isAllowedBotRoleList(setting) || !hasDiscordSurface(env)) return env
  return setAllowedBotRolesEnv(env, [...new Set(setting)]).env
}

// ── fleet sync (the writer) + posture (report only) ──────────────────────────

export type BotRoleTarget = { name: string; dataDir: string }
export type BotRoleSkipReason = 'no-env' | 'no-discord'

export type BotRoleSyncResult = {
  updated: string[]
  unchanged: string[]
  skipped: { name: string; reason: BotRoleSkipReason }[]
  failed: string[]
}

function discordEnv(t: BotRoleTarget): { env: string; envPath: string } | BotRoleSkipReason {
  const envPath = path.join(t.dataDir, '.env')
  let env: string
  try {
    env = fs.readFileSync(envPath, 'utf-8')
  } catch {
    return 'no-env'
  }
  if (!hasDiscordSurface(env)) return 'no-discord'
  return { env, envPath }
}

/**
 * Write `roles` into every Discord agent's .env. Never throws. Running agents
 * keep their old value until their container is recreated.
 */
export function syncDiscordAllowedBotRoles(targets: BotRoleTarget[], roles: readonly string[]): BotRoleSyncResult {
  const result: BotRoleSyncResult = { updated: [], unchanged: [], skipped: [], failed: [] }
  for (const t of targets) {
    try {
      const cfg = discordEnv(t)
      if (typeof cfg === 'string') {
        result.skipped.push({ name: t.name, reason: cfg })
        continue
      }
      const next = setAllowedBotRolesEnv(cfg.env, roles)
      if (next.status === 'unchanged') result.unchanged.push(t.name)
      else {
        // writeFileSync on an existing path keeps its mode (.env is 0600).
        fs.writeFileSync(cfg.envPath, next.env)
        result.updated.push(t.name)
      }
    } catch (err) {
      result.failed.push(t.name)
      console.error(`[discord-allowed-bot-roles] failed for ${t.name}:`, err)
    }
  }
  return result
}

export type BotRolePostureRow = {
  name: string
  status: 'ok' | 'drift' | 'unmanaged'
  roles: string[]
  /** DISCORD_ALLOW_BOTS as the .env sets it (default none). */
  allowBots: string
}

export type BotRolePosture = {
  desired: string[] | null
  drift: string[]
  agents: BotRolePostureRow[]
}

/** REPORT ONLY — each Discord agent's bot-role gate against the setting. */
export function discordAllowedBotRolesPosture(targets: BotRoleTarget[], desired: readonly string[] | null): BotRolePosture {
  const agents: BotRolePostureRow[] = []
  for (const t of targets) {
    const cfg = discordEnv(t)
    if (typeof cfg === 'string') continue
    const roles = parseRoleList(readEnvValue(cfg.env, DISCORD_ALLOWED_BOT_ROLES_VAR))
    const allowBots = (readEnvValue(cfg.env, 'DISCORD_ALLOW_BOTS') || 'none').toLowerCase()
    let status: BotRolePostureRow['status']
    if (desired === null) status = 'unmanaged'
    else status = setAllowedBotRolesEnv(cfg.env, desired).status === 'unchanged' ? 'ok' : 'drift'
    agents.push({ name: t.name, status, roles, allowBots })
  }
  return {
    desired: desired === null ? null : [...desired],
    drift: agents.filter((a) => a.status === 'drift').map((a) => a.name),
    agents,
  }
}
