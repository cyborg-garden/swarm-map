/**
 * Fleet wiring for the Discord approver role (lib/services/discord-approver-roles):
 * reads the `discordApproverRoles` setting and syncs it once per server start.
 * Kept apart from the pure module so its tests need no services mock.
 */

import { services } from '@/lib/services'
import { fleetThreadGateTargets } from './discord-thread-gate-fleet'
import { syncDiscordApproverRoles, type ApproverSyncResult } from './discord-approver-roles'

/** The configured approver role IDs, or null when swarm-map does not manage them. */
export function desiredApproverRoles(): string[] | null {
  const v = services.config.getSettings()?.discordApproverRoles
  return Array.isArray(v) ? v : null
}

/** Same agents the thread gate looks at: every Hermes agent HSM manages. */
export const fleetApproverTargets = fleetThreadGateTargets

/**
 * Write the setting into every Discord agent's config.yaml. Called once per
 * server start from instrumentation.ts and by POST
 * /api/fleet/discord-approver-roles. Never throws. Returns null when the
 * setting is unmanaged. Agents pick the value up on their next restart.
 */
export function syncFleetDiscordApproverRoles(): ApproverSyncResult | null {
  try {
    const roles = desiredApproverRoles()
    if (roles === null) return null
    const result = syncDiscordApproverRoles(fleetApproverTargets(), roles)
    if (result.updated.length) {
      console.log(
        `[discord-approver-roles] set approver_roles on ${result.updated.join(', ')} ` +
        '— takes effect on each agent\'s next restart',
      )
    }
    return result
  } catch (err) {
    console.error('[discord-approver-roles] sync failed:', err)
    return null
  }
}

export const syncFleetDiscordApproverRolesAtStartup = syncFleetDiscordApproverRoles
