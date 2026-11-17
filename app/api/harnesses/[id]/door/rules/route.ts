import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse, requireDoorAgent } from '@/lib/harness-ref'

/**
 * Save an edit of a door agent's rules, and apply it. The rules are checked
 * by the launcher's own parser before anything is stored. On a running door
 * they are dry-run first, and the door is restarted on them only if the dry
 * run ends ready (DoorAgentService.saveRules).
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: raw } = await params
  const { id, refusal } = requireDoorAgent(raw)
  if (refusal) return refusal
  const body = await request.json().catch(() => ({}))
  try {
    // The record, whether it was applied to a running door, and who started that door again.
    const saved = await services.doorAgents.saveRules(id, { rules: body.rules, secrets: body.secrets, version: body.version })
    return NextResponse.json(saved)
  } catch (err) {
    return doorErrorResponse(err)
  }
}
