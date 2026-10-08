/**
 * Fleet wiring for the Discord bot-sender gate (lib/services/discord-allowed-bot-roles):
 * reads the `discordAllowedBotRoles` setting and syncs it once per server start.
 * Kept apart from the pure module so its tests need no services mock.
 */

import { services } from '@/lib/services'
import { fleetThreadGateTargets } from './discord-thread-gate-fleet'
import { isAllowedBotRoleList, syncDiscordAllowedBotRoles, type BotRoleSyncResult } from './discord-allowed-bot-roles'

/**
 * The configured bot role IDs, or null when swarm-map does not manage them.
 * settings.json is read back without the PUT validation, so a hand-edited
 * value that is not a list of role IDs is treated as unmanaged (nothing is
 * written) and logged, rather than written into every agent's .env.
 */
export function desiredAllowedBotRoles(): string[] | null {
  const v = services.config.getSettings()?.discordAllowedBotRoles
  if (v === undefined || v === null) return null
  if (!isAllowedBotRoleList(v)) {
    console.error('[discord-allowed-bot-roles] discordAllowedBotRoles in settings is not a list of role IDs — ignoring it')
    return null
  }
  return [...new Set(v)]
}

/** Same agents the thread gate looks at: every Hermes agent HSM manages. */
export const fleetAllowedBotRoleTargets = fleetThreadGateTargets

/**
 * Write the setting into every Discord agent's .env. Called once per server
 * start from instrumentation.ts and by POST /api/fleet/discord-allowed-bot-roles.
 * Never throws. Returns null when the setting is unmanaged. Agents pick the
 * value up on their next recreate.
 */
export function syncFleetDiscordAllowedBotRoles(): BotRoleSyncResult | null {
  try {
    const roles = desiredAllowedBotRoles()
    if (roles === null) return null
    const result = syncDiscordAllowedBotRoles(fleetAllowedBotRoleTargets(), roles)
    if (result.updated.length) {
      console.log(
        `[discord-allowed-bot-roles] set DISCORD_ALLOWED_BOT_ROLES on ${result.updated.join(', ')} ` +
        '— takes effect on each agent\'s next recreate',
      )
    }
    return result
  } catch (err) {
    console.error('[discord-allowed-bot-roles] sync failed:', err)
    return null
  }
}

export const syncFleetDiscordAllowedBotRolesAtStartup = syncFleetDiscordAllowedBotRoles
