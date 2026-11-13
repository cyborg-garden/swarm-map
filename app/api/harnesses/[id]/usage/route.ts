import { NextResponse } from 'next/server'
import { getUsageSummary } from '@/lib/services/usage'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const usage = getUsageSummary(id)

  if (!usage) {
    return NextResponse.json(
      { costToday: 0, costWeek: 0, costMonth: 0, totalTokensToday: 0, sessionCountToday: 0, costStatus: 'unknown', byModel: [], recentSessions: [] },
      { status: 200 }
    )
  }

  return NextResponse.json(usage)
}
