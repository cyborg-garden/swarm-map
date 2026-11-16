import { NextResponse } from 'next/server'
import { getUsageSummary } from '@/lib/services/usage'
import { services } from '@/lib/services'
import { doorAgentId, doorErrorResponse, invalidHarnessId } from '@/lib/harness-ref'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const invalid = invalidHarnessId(id)
  if (invalid) return invalid

  const door = doorAgentId(id)
  if (door) {
    // The door keeps a monthly ledger and nothing finer. What it does not
    // keep is null, which a page shows as a dash, never as $0.
    try {
      const spend = services.doorAgents.usage(door)
      return NextResponse.json({
        costToday: null, costWeek: null, costMonth: spend?.spentThisMonthUsd ?? null,
        totalTokensToday: null, sessionCountToday: null, costStatus: 'unknown', byModel: [], recentSessions: [],
      })
    } catch (err) {
      return doorErrorResponse(err)
    }
  }

  const usage = getUsageSummary(id)

  if (!usage) {
    return NextResponse.json(
      { costToday: 0, costWeek: 0, costMonth: 0, totalTokensToday: 0, sessionCountToday: 0, costStatus: 'unknown', byModel: [], recentSessions: [] },
      { status: 200 }
    )
  }

  return NextResponse.json(usage)
}
