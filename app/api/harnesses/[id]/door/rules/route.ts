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
    const { record, applied } = await services.doorAgents.saveRules(id, { rules: body.rules, secrets: body.secrets, version: body.version })
    return NextResponse.json({ record, applied })
  } catch (err) {
    return doorErrorResponse(err)
  }
}
