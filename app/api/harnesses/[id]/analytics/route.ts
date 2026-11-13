import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { clampDays } from '@/lib/services/analytics'

// GET /api/harnesses/:id/analytics?days=30 — daily cost/tokens/sessions/tool
// calls for one harness, from its state.db (live or ≤5-min snapshot).
// Read-only; served from the analytics service's cache, not from discover().
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const days = clampDays(new URL(request.url).searchParams.get('days'))

  try {
    const result = services.analytics.getHarnessAnalytics(id, days)
    // null = migrated harness with no snapshot exported yet. Usage is UNKNOWN,
    // not zero — the client renders "pending", never an empty chart.
    if (!result) return NextResponse.json({ harnessId: id, pending: true })
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'analytics failed'
    const status = /not found/i.test(msg) ? 404 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
