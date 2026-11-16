import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse, requireDoorAgent } from '@/lib/harness-ref'

/**
 * The door's decision log, newest first. Each receipt has the decision, the
 * rule that made it and one plain sentence. Receipts hold ids and sizes,
 * never message text.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  const wanted = parseInt(new URL(request.url).searchParams.get('last') ?? '50', 10)
  const last = Number.isFinite(wanted) && wanted > 0 ? Math.min(wanted, 500) : 50
  try {
    return NextResponse.json({ receipts: services.doorAgents.receipts(id, last) ?? [] })
  } catch (err) {
    return doorErrorResponse(err)
  }
}
