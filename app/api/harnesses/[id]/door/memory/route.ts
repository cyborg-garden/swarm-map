import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse, requireDoorAgent } from '@/lib/harness-ref'

/**
 * The door's notes for a door agent, room by room, and its kept scratch
 * folder. Everything here is read with the redactor, so nothing
 * secret-shaped is ever sent to the page. docs/lab/persona-memory.md.
 *
 *   GET     the notes and the kept folder
 *   PUT     { room, files: { room?, people?, threads? } }  replace one room's notes
 *   DELETE  ?room=<key>   one room's notes
 *           ?all=notes    every room's notes
 *           ?all=scratch  the kept scratch folder (only while stopped)
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  try {
    return NextResponse.json(services.doorAgents.memory(id))
  } catch (err) {
    return doorErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  const body = await request.json().catch(() => ({}))
  try {
    return NextResponse.json(services.doorAgents.saveMemory(id, { room: body.room, files: body.files }))
  } catch (err) {
    return doorErrorResponse(err)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  const room = new URL(request.url).searchParams.get('room')
  const all = new URL(request.url).searchParams.get('all')
  try {
    return NextResponse.json(services.doorAgents.wipe(id, { room, all }))
  } catch (err) {
    return doorErrorResponse(err)
  }
}
