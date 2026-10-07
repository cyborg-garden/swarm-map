import { NextResponse } from 'next/server'
import { discordApproverPosture } from '@/lib/services/discord-approver-roles'
import {
  desiredApproverRoles,
  fleetApproverTargets,
  syncFleetDiscordApproverRoles,
} from '@/lib/services/discord-approver-roles-fleet'

// /api/fleet/discord-approver-roles — who can approve dangerous commands by
// Discord role, fleet-wide. The role IDs live in the `discordApproverRoles`
// setting (PUT /api/settings); see lib/services/discord-approver-roles.ts.
//
// GET  — report each Discord agent's approver_roles against the setting. Writes nothing.
// POST — write the setting into every Discord agent's config.yaml now (the
//        same sync that runs at server start). Agents need a restart to read it.

export async function GET() {
  try {
    return NextResponse.json(discordApproverPosture(fleetApproverTargets(), desiredApproverRoles()))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'approver posture check failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST() {
  if (desiredApproverRoles() === null) {
    return NextResponse.json(
      { error: 'discordApproverRoles is not set — PUT /api/settings with a list of role IDs first' },
      { status: 409 },
    )
  }
  const result = syncFleetDiscordApproverRoles()
  if (!result) return NextResponse.json({ error: 'approver role sync failed — see server log' }, { status: 500 })
  return NextResponse.json({ ...result, restartNeeded: result.updated })
}
