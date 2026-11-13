import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { getIntegrityForHarness, getWriteFailureSignal } from '@/lib/services/integrity'

// GET /api/harnesses/:id/health → canary signal (healthy | starting | unhealthy)
// plus the DB health block (#204, PR1): cached quick_check result from the
// scheduled fleet sweep and a write-failure signal from the errors.log tail.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const health = services.harness.agentHealth(id)
    const db = {
      integrity: getIntegrityForHarness(id),
      writeFailures: getWriteFailureSignal(id),
    }
    return NextResponse.json({ ...health, db })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'health check failed'
    return NextResponse.json({ error: msg }, { status: /not found/i.test(msg) ? 404 : 500 })
  }
}
