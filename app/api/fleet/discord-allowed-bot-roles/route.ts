import { NextResponse } from 'next/server'
import { discordAllowedBotRolesPosture } from '@/lib/services/discord-allowed-bot-roles'
import {
  desiredAllowedBotRoles,
  fleetAllowedBotRoleTargets,
  syncFleetDiscordAllowedBotRoles,
} from '@/lib/services/discord-allowed-bot-roles-fleet'

// /api/fleet/discord-allowed-bot-roles — which Discord role a BOT must hold for
// any Discord agent to accept it. The role IDs live in the
// `discordAllowedBotRoles` setting (PUT /api/settings); see
// lib/services/discord-allowed-bot-roles.ts.
//
// GET  — report each Discord agent's DISCORD_ALLOWED_BOT_ROLES against the setting. Writes nothing.
// POST — write the setting into every Discord agent's .env now (the same sync
//        that runs at server start). Agents need a recreate to read it.

export async function GET() {
  try {
    return NextResponse.json(discordAllowedBotRolesPosture(fleetAllowedBotRoleTargets(), desiredAllowedBotRoles()))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'bot role posture check failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST() {
  if (desiredAllowedBotRoles() === null) {
    return NextResponse.json(
      { error: 'discordAllowedBotRoles is not set — PUT /api/settings with a list of role IDs first' },
      { status: 409 },
    )
  }
  const result = syncFleetDiscordAllowedBotRoles()
  if (!result) return NextResponse.json({ error: 'bot role sync failed — see server log' }, { status: 500 })
  return NextResponse.json({ ...result, restartNeeded: result.updated })
}
