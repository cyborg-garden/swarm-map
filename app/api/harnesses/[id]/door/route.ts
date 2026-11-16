import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse, requireDoorAgent } from '@/lib/harness-ref'

/**
 * Everything the page of a door agent shows: the rules record, the door's
 * status, the month's spend, the last dry run and the supervisor command.
 * The record names the two secret files by path. What they hold is never
 * read into this response.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  try {
    return NextResponse.json(services.doorAgents.view(id))
  } catch (err) {
    return doorErrorResponse(err)
  }
}
