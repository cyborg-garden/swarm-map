import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { isSupportedSurface } from '@/lib/services/surface-admins'

/**
 * GET /api/harnesses/:id/surfaces/:platform/admins
 *
 * List the effective admins for a surface. Returns the explicit admin list if
 * one is set, otherwise the DM-allowlist bootstrap set (source: 'allowlist').
 * Used by the Permissions UI. Like all GETs this is intentionally ungated by
 * the auth middleware (agents' policy reads must keep working); with mutations
 * transport-gated, listing admin identities no longer hands a caller anything
 * it can use to mutate the list.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; platform: string }> },
) {
  const { id, platform } = await params
  if (!isSupportedSurface(platform)) {
    return NextResponse.json({ error: `Unsupported platform: ${platform}` }, { status: 400 })
  }
  const list = services.surfaceAdmins.listAdmins(id, platform)
  return NextResponse.json(list)
}

/**
 * PUT /api/harnesses/:id/surfaces/:platform/admins
 * body: { admins: string[], actor: string }
 *
 * Replace the explicit admin list for a surface.
 *
 * Auth: like every mutating /api route, this is transport-gated by the
 * operator-cookie middleware (proxy.ts, PR #139) — agent containers
 * cannot obtain the cookie, so only a logged-in operator reaches this handler.
 * On top of that, `actor` must already be an admin for the surface (explicit
 * list, or the DM allowlist before any explicit list exists). The actor check
 * is defense-in-depth + semantic attribution (which surface identity made the
 * change), and keeps self-escalation closed even with the middleware
 * kill-switch (HSM_OPERATOR_TOKEN unset) engaged.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; platform: string }> },
) {
  const { id, platform } = await params
  let body: { admins?: unknown; actor?: unknown }
  try {
    body = (await request.json()) as { admins?: unknown; actor?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const actor = typeof body.actor === 'string' ? body.actor : ''
  const result = services.surfaceAdmins.setAdmins(id, platform, body.admins, actor)

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json({ success: true, admins: result.admins })
}
