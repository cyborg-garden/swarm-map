import { NextResponse } from 'next/server'
import { services } from '@/lib/services'

function discover(id: string) {
  const harness = services.harness.get(id)
  if (!harness) return null

  const discovered = services.tools.discoverForHarness(harness.name)

  // Resolve discovered IDs to full tool objects for richer response
  const allTools = services.tools.list()
  const toolMap = new Map(allTools.map((t) => [t.id, t]))
  const resolvedTools = discovered.map((tid) => toolMap.get(tid)).filter(Boolean)

  return { harness, discovered, resolvedTools }
}

/**
 * GET /api/harnesses/:id/tools/discover
 *
 * Scans the agent's config.yaml and skills directory to discover runtime tools.
 * Pure read — never persists. Use POST to sync discovered tools into the
 * harness overlay.
 *
 * This GET MUST stay side-effect-free: the root middleware intentionally
 * passes GET/HEAD unauthenticated (agents' read hot-paths), so any write here
 * would be reachable without an operator session (issue #141). The old
 * `?sync=true` param is ignored for the same reason.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const result = discover(id)
  if (!result) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json({
    discovered: result.resolvedTools,
    discoveredIds: result.discovered,
    currentTools: result.harness.tools,
  })
}

/**
 * POST /api/harnesses/:id/tools/discover
 *
 * Discovers runtime tools and persists them into the harness overlay — but
 * only when no tools have been explicitly assigned (via PUT ../tools) and
 * discovery actually found some. Gated behind the operator session by the
 * root middleware (POST requires auth).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const result = discover(id)
  if (!result) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  const { harness, discovered, resolvedTools } = result
  let synced = false
  if (harness.tools.length === 0 && discovered.length > 0) {
    services.harness.updateConfig(id, { tools: discovered })
    synced = true
  }

  return NextResponse.json({
    discovered: resolvedTools,
    discoveredIds: discovered,
    // Post-write truth: when we just synced, the harness now holds the
    // discovered list — not the pre-sync snapshot captured above.
    currentTools: synced ? discovered : harness.tools,
    synced,
  })
}
