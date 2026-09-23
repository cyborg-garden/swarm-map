import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { clampDays } from '@/lib/services/analytics'

// GET /api/fleet/analytics?days=30 — fleet-wide daily series (cost stacked by
// harness, sessions by source) plus per-harness totals. Read-only, cached.
export async function GET(request: Request) {
  const days = clampDays(new URL(request.url).searchParams.get('days'))
  try {
    return NextResponse.json(services.analytics.getFleetAnalytics(days))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fleet analytics failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
