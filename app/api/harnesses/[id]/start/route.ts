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
    // A door agent is started by its launcher, after a dry run that must end ready.
    try {
      await services.doorAgents.start(door)
      return NextResponse.json({ ok: true })
    } catch (err) {
      return doorErrorResponse(err)
    }
  }
  const { refusal } = requireHarness(id)
  if (refusal) return refusal
  try {
    services.harness.start(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Start failed' },
      { status: 500 }
    )
  }
}
