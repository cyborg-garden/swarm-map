import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorAgentId, doorErrorResponse, requireHarness } from '@/lib/harness-ref'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const door = doorAgentId(id)
  if (door) {
    try {
      await services.doorAgents.stop(door)
      return NextResponse.json({ ok: true })
    } catch (err) {
      return doorErrorResponse(err)
    }
  }
  const { refusal } = requireHarness(id)
  if (refusal) return refusal
  try {
    services.harness.stop(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Stop failed' },
      { status: 500 }
    )
  }
}
