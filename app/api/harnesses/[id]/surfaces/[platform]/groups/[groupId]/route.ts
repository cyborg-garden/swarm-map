import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

/**
 * GET /api/harnesses/:id/surfaces/:platform/groups/:groupId
 *
 * The is-group-allowed check the swarm_map_policy plugin calls
 * (is_group_allowed → resp.json().get("allowed", False)). Mirrors the existing
 * /policy?action=group-check logic at the REST path the plugin expects. Always
 * returns 200 with a boolean so the plugin fails closed cleanly.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; platform: string; groupId: string }> },
) {
  const { id, platform, groupId } = await params
  const allowed = services.surfaceAdmins.isGroupAllowed(id, platform, decodeURIComponent(groupId))
  return NextResponse.json({ allowed })
}

/**
 * POST /api/harnesses/:id/surfaces/:platform/groups/:groupId
 *
 * Group-invite approval for the swarm_map_policy agent plugin: the agent was
 * just added to a group and asks whether the invite is approved. Consumed by a
 * hermes-agent-mt change — this comment is the contract.
 *
 * Request body (JSON):
 *   { "addedByUserId": "<platform-native user id of whoever added the bot>" }
 *
 * Responses (always 200 unless the request itself is malformed):
 *   { "approved": true,  "restarted": boolean }        — group appended to the
 *     allowlist env var (e.g. TELEGRAM_GROUP_ALLOWED_CHATS); the container was
 *     recreated so the change takes effect (restarted:false = env written but
 *     recreate failed, e.g. no compose file yet).
 *   { "approved": true,  "already_allowed": true }     — allowlist is '*' or the
 *     group is already listed; nothing written, no restart.
 *   { "approved": false, "reason": "<why>" }           — invite policy is
 *     approved-only (or unset, the secure default) and addedByUserId is not an
 *     admin. The plugin should leave the group.
 *   400 { "error": "<what>" }                          — unsupported platform,
 *     structurally invalid groupId, missing addedByUserId, or no agent .env.
 *
 * Policy: allow-all → approve for anyone; approved-only/unset → approve only
 * when addedByUserId is an admin (SurfaceAdminService.isAdmin, fail-closed).
 *
 * Auth: exempted from the operator-cookie gate in proxy.ts (agents cannot
 * obtain the cookie) — see AGENT_CALLABLE_POST_PATHS there for the trust model.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; platform: string; groupId: string }> },
) {
  const { id, platform, groupId } = await params

  let body: { addedByUserId?: unknown }
  try {
    body = (await request.json()) as { addedByUserId?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const addedByUserId = typeof body.addedByUserId === 'string' ? body.addedByUserId : ''

  const result = services.surfaceAdmins.approveGroupInvite(
    id,
    platform,
    decodeURIComponent(groupId),
    addedByUserId,
  )

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  if (!result.approved) {
    return NextResponse.json({ approved: false, reason: result.reason })
  }
  if (!result.updated) {
    return NextResponse.json({ approved: true, already_allowed: true })
  }

  // Recreate the container so the updated allowlist actually loads (env_file is
  // read at container creation, not on a plain restart) — same as every other
  // env-writing route. Best-effort: the env is written either way.
  let restarted = false
  try {
    services.harness.restart(id, 'recreate')
    restarted = true
  } catch {}

  return NextResponse.json({ approved: true, restarted })
}
