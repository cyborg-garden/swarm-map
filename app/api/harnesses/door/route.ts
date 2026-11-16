import { NextResponse } from 'next/server'
import { services } from '@/lib/services'
import { doorErrorResponse } from '@/lib/harness-ref'

/**
 * Make a draft door agent from a name. The name is checked against every
 * stored agent before anything is written. Nothing is started: the rules are
 * filled in on the agent's page, and the Discord application is made by hand
 * (docs/lab/pi-discord.md).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}))
  try {
    const record = services.doorAgents.create(body.name, body.runtime ?? 'pi')
    return NextResponse.json({ id: record.id, name: record.name, runtime: record.runtime }, { status: 201 })
  } catch (err) {
    return doorErrorResponse(err)
  }
}
