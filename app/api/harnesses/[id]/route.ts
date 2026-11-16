import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorAgentId, doorErrorResponse, requireHarness, requireHarnessToRemove } from '@/lib/harness-ref'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const door = doorAgentId(id)
  if (door) {
    const row = services.doorAgents.row(door)
    return row ? NextResponse.json(row) : NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }
  const { harness, refusal } = requireHarness(id)
  if (refusal) return refusal
  return NextResponse.json(harness)
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const door = doorAgentId(id)
  if (door) {
    // Stops the door and forgets the agent's record. The two secret files are left where they are.
    try { return NextResponse.json(await services.doorAgents.remove(door)) } catch (err) { return doorErrorResponse(err) }
  }
  const refusal = requireHarnessToRemove(id)
  if (refusal) return refusal
  const url = new URL(request.url)
  const deleteFiles = url.searchParams.get('deleteFiles') === 'true'

  const result = services.harness.remove(id, deleteFiles)
  if (!result.removed) {
    return NextResponse.json({ error: 'Harness not found' }, { status: 404 })
  }

  return NextResponse.json(result)
}
